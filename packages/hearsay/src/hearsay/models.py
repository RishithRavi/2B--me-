"""Lazy, explicit model loading. Unit tests inject callables; imports never download.

All countermeasure margins are synthetic-high. Model failure is an error, never
an unreadable-audio result or an automatic fallback to another detector.
"""

import re
from collections.abc import Callable
from contextlib import nullcontext
from threading import Lock

import numpy as np

from .audio import SAMPLE_RATE, cm_windows, mono_16k

DF_ARENA = "Speech-Arena-2025/DF_Arena_500M_V_1"
FALLBACK = "garystafford/wav2vec2-deepfake-voice-detector"
ECAPA = "speechbrain/spkrec-ecapa-voxceleb"


def pinned_revision(revision: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("model revision must be a full Hugging Face commit SHA")
    return revision


def logits_margin(logits, *, spoof_index: int) -> float:
    values = np.asarray(logits, dtype=np.float64)
    if values.shape not in ((2,), (1, 2)) or not np.isfinite(values).all():
        raise ValueError("detector must return two finite logits for one window")
    if spoof_index not in (0, 1):
        raise ValueError("spoof_index must be zero or one")
    values = values.reshape(2)
    return float(values[spoof_index] - values[1 - spoof_index])


class Countermeasure:
    """One instance serializes inference across all windows and callers."""

    def __init__(self, infer_logits: Callable, *, model: str, revision: str, spoof_index: int):
        self._infer = infer_logits
        self._lock = Lock()
        self.model = model
        self.revision = pinned_revision(revision)
        if spoof_index not in (0, 1):
            raise ValueError("invalid spoof logit index")
        self.spoof_index = spoof_index

    @property
    def identity(self) -> dict:
        return {
            "model": self.model,
            "revision": self.revision,
            "spoof_index": self.spoof_index,
            "extractor_version": 1,
        }

    def score(self, samples: np.ndarray, *, profile: str = "hearsay") -> float:
        if profile not in {"stepup", "hearsay"}:
            raise ValueError("profile must be stepup or hearsay")
        windows = cm_windows(samples, max_windows=1 if profile == "stepup" else 3)
        with self._lock:
            margins = [
                logits_margin(self._infer(window), spoof_index=self.spoof_index)
                for window in windows
            ]
        return float(np.mean(margins))

    @classmethod
    def load(cls, *, model: str = DF_ARENA, revision: str, device: str = "cpu", threads: int = 6):
        pinned_revision(revision)
        if model not in (DF_ARENA, FALLBACK):
            raise ValueError("unsupported detector")
        if device not in ("cpu", "cuda") or threads < 1:
            raise ValueError("device must be cpu/cuda and threads positive")
        import torch

        torch.set_num_threads(threads)
        if model == DF_ARENA:
            from transformers import pipeline

            pipe = pipeline(
                "antispoofing",
                model=model,
                revision=revision,
                code_revision=revision,
                trust_remote_code=True,
                device=device,
            )

            def infer(x):
                with (
                    torch.inference_mode(),
                    (
                        torch.autocast("cuda", dtype=torch.float16)
                        if device == "cuda"
                        else nullcontext()
                    ),
                ):
                    return pipe(x)["logits"]

            spoof_index = 0
        else:
            from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

            extractor = AutoFeatureExtractor.from_pretrained(model, revision=revision)
            network = AutoModelForAudioClassification.from_pretrained(model, revision=revision)
            network.to(device).eval()

            def infer(x):
                inputs = extractor(x, sampling_rate=SAMPLE_RATE, return_tensors="pt", padding=True)
                inputs = {key: tensor.to(device) for key, tensor in inputs.items()}
                with (
                    torch.inference_mode(),
                    (
                        torch.autocast("cuda", dtype=torch.float16)
                        if device == "cuda"
                        else nullcontext()
                    ),
                ):
                    return network(**inputs).logits.float().cpu().numpy()

            spoof_index = 1
        return cls(infer, model=model, revision=revision, spoof_index=spoof_index)


def unit_embedding(values) -> np.ndarray:
    embedding = np.asarray(values, dtype=np.float32).reshape(-1)
    if embedding.shape != (192,) or not np.isfinite(embedding).all():
        raise ValueError("ECAPA must return 192 finite dimensions")
    norm = float(np.linalg.norm(embedding.astype(np.float64)))
    if norm <= 1e-12:
        raise ValueError("zero speaker embedding")
    return embedding / norm


class SpeakerEncoder:
    def __init__(self, encode: Callable):
        self._encode = encode
        self._lock = Lock()

    def embed(self, samples: np.ndarray) -> np.ndarray:
        x = mono_16k(samples, SAMPLE_RATE)
        with self._lock:
            return unit_embedding(self._encode(x))

    @classmethod
    def load(cls, *, revision: str, savedir: str, device: str = "cpu"):
        pinned_revision(revision)
        import torch
        from huggingface_hub import snapshot_download
        from speechbrain.inference.speaker import EncoderClassifier

        snapshot = snapshot_download(ECAPA, revision=revision)
        encoder = EncoderClassifier.from_hparams(
            source=snapshot,
            savedir=savedir,
            run_opts={"device": device},
            overrides={"pretrained_path": snapshot},
        )

        def encode(x):
            with torch.inference_mode():
                return (
                    encoder.encode_batch(torch.from_numpy(x).unsqueeze(0).to(device)).cpu().numpy()
                )

        return cls(encode)


def speaker_match(embedding: np.ndarray, centroids: list[np.ndarray]) -> float:
    if not centroids:
        raise ValueError("at least one enrolled centroid is required")
    probe = unit_embedding(embedding)
    return float(np.clip(max(probe @ unit_embedding(c) for c in centroids), -1, 1))
