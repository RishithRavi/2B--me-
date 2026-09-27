"""Real step-up pipeline. Models are injected; no weights are loaded by imports."""

from __future__ import annotations

import asyncio
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from pathlib import Path

import numpy as np
from hearsay.audio import mono_16k
from hearsay.decision import Thresholds, decide
from hearsay.dsp import analyze, spectral_similarity, spectral_vector
from hearsay.models import speaker_match, unit_embedding
from hearsay.phrases import phrase_match
from twobme_common.types import CMResult, VoiceResult


@dataclass(frozen=True)
class Calibration:
    thresholds: Thresholds
    cm_scale: float
    cm_bias: float
    enrollment_min_speech_s: float = 20.0
    enrollment_min_cos: float = 0.5

    def __post_init__(self):
        if (
            not math.isfinite(self.cm_scale)
            or self.cm_scale <= 0
            or not math.isfinite(self.cm_bias)
        ):
            raise ValueError("CM calibration must be finite and synthetic-high")
        if not 8 <= self.enrollment_min_speech_s <= 30 or not 0.5 <= self.enrollment_min_cos < 1:
            raise ValueError("invalid enrollment quality thresholds")

    @classmethod
    def load(cls, path: Path, *, model: str, revision: str, speaker_revision: str | None = None):
        data = json.loads(path.read_text())
        if data["model"] != model or data["revision"] != revision:
            raise ValueError("calibration does not match the configured countermeasure")
        if speaker_revision is not None and data.get("speaker_revision") != speaker_revision:
            raise ValueError("calibration does not match the configured speaker encoder")
        return cls(
            Thresholds(**data["thresholds"]),
            float(data["cm_scale"]),
            float(data["cm_bias"]),
            float(data.get("enrollment_min_speech_s", 20.0)),
            float(data.get("enrollment_min_cos", 0.5)),
        )

    def probability(self, margin: float) -> float:
        if not math.isfinite(margin):
            raise ValueError("nonfinite countermeasure score")
        value = self.cm_scale * margin + self.cm_bias
        if not math.isfinite(value):
            raise ValueError("nonfinite calibrated score")
        return 1 / (1 + math.exp(-value)) if value >= 0 else math.exp(value) / (1 + math.exp(value))


class Pipeline:
    def __init__(self, *, cm, speaker, vad, stt, calibration: Calibration):
        self.cm, self.speaker, self.vad, self.stt = cm, speaker, vad, stt
        self.calibration = calibration
        self.cm_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-cm")

    def close(self):
        self.cm_executor.shutdown(wait=True, cancel_futures=True)

    def score_audio(self, x, sr: int, profile: str) -> CMResult:
        started = time.perf_counter()
        x = mono_16k(x, sr)
        speech = self.vad.analyze(x)["samples"]
        if not len(speech):
            return CMResult(margin=0, ms={"total": (time.perf_counter() - started) * 1000})
        margin = self.cm.score(speech, profile=profile)
        return CMResult(
            margin=margin,
            p_spoof=self.calibration.probability(margin),
            llr=margin,
            analyzers={"cm": margin},
            ms={"total": (time.perf_counter() - started) * 1000},
        )

    async def warmup(self):
        # Warm the tensor paths even though VAD correctly calls this silence.
        samples = np.zeros(64600, dtype=np.float32)
        await asyncio.to_thread(self.vad.analyze, samples)
        await asyncio.get_running_loop().run_in_executor(self.cm_executor, self.cm.score, samples)
        await asyncio.to_thread(self.speaker.embed, samples)
        await self.stt.warmup()

    async def measure(self, samples, *, stage=None):
        """Run all independent scores even when another stage fails or detects spoof."""
        began = time.perf_counter()
        prepared = await asyncio.to_thread(self.vad.analyze, samples)
        speech = prepared["samples"]
        timings = {"vad": round((time.perf_counter() - began) * 1000)}
        errors = []

        async def run(name, work):
            start = time.perf_counter()
            result = None
            try:
                result = await work()
            except Exception:
                # Neither provider error bodies nor transcripts/audio enter logs or the DTO.
                errors.append(name)
            timings[name] = round((time.perf_counter() - start) * 1000)
            if stage:
                await stage(name, result is not None)
            return result

        if len(speech):
            transcript, margin, embedding, dsp = await asyncio.gather(
                run("transcribing", lambda: self.stt.transcribe(speech)),
                run(
                    "anti-spoof",
                    lambda: asyncio.get_running_loop().run_in_executor(
                        self.cm_executor, partial(self.cm.score, speech, profile="stepup")
                    ),
                ),
                run("speaker", lambda: asyncio.to_thread(self.speaker.embed, speech)),
                run("spectral", lambda: asyncio.to_thread(analyze, speech)),
            )
        else:
            transcript, margin, embedding = None, None, None
            dsp = await run("spectral", lambda: asyncio.to_thread(analyze, samples))
        probability = None
        if margin is not None:
            try:
                probability = self.calibration.probability(margin)
            except ValueError:
                errors.append("anti-spoof")
        return dict(
            speech_s=prepared["speech_s"],
            onset_ms=prepared["onset_ms"],
            transcript=transcript,
            probability=probability,
            embedding=embedding,
            dsp=dsp,
            timings=timings,
            errors=errors,
        )

    async def verify(
        self, samples, *, phrase: str, profiles: list[dict], trigger: str, attempt: int, stage=None
    ) -> VoiceResult:
        started = time.perf_counter()
        m = await self.measure(samples, stage=stage)
        phrase_ok, wer = phrase_match(phrase, m["transcript"] or "")
        asv, spec = None, None
        if m["embedding"] is not None and profiles:
            try:
                asv = speaker_match(m["embedding"], [p["speaker_embedding"] for p in profiles])
            except ValueError:
                m["errors"].append("speaker profile")
        if m["dsp"] and profiles:
            scores = []
            current = spectral_vector(m["dsp"]["ltas_db"], m["dsp"]["mfcc_mean"])
            for profile in profiles:
                if profile.get("mfcc_mean") is None:
                    continue  # old profiles cannot silently become 64-d verification
                try:
                    scores.append(
                        spectral_similarity(
                            current,
                            spectral_vector(profile["spectral_summary"], profile["mfcc_mean"]),
                        )
                    )
                except (ValueError, TypeError):
                    continue
            spec = max(scores) if scores else None
        decision = decide(
            thresholds=self.calibration.thresholds,
            speech_s=m["speech_s"],
            cm_p_spoof=m["probability"],
            phrase_ok=phrase_ok,
            asv_cos=asv,
            spec_sim=spec,
            onset_ms=m["onset_ms"],
            attempt=attempt,
            trigger=trigger,
        )
        # A failed stage cannot turn partial evidence into verification. Spoof still wins.
        if m["errors"] and decision != "BLOCK_SPOOF":
            decision = "FALLBACK_MFA"
        confidence = 0.0
        if all(v is not None for v in (asv, spec, m["probability"])):
            confidence = float(
                np.clip(0.6 * ((asv + 1) / 2) + 0.25 * (1 - m["probability"]) + 0.15 * spec, 0, 1)
            )
        findings = [f"Phrase alignment: {round((1 - wer) * 5)}/5 words."]
        if asv is not None:
            findings.append(
                f"Speaker cosine {asv:.3f}; pass threshold {self.calibration.thresholds.asv_high:.3f}."
            )
        if m["probability"] is not None:
            findings.append(
                f"Synthetic score {m['probability']:.3f}; block threshold {self.calibration.thresholds.cm:.3f}."
            )
        if spec is not None:
            findings.append(
                f"LTAS/MFCC cosine {spec:.3f}; pass threshold {self.calibration.thresholds.spectral:.3f}."
            )
        if not profiles:
            findings.append("No enrolled voice profile is available.")
        findings.extend(f"{name} unavailable; verification withheld." for name in m["errors"])
        m["timings"]["total"] = round((time.perf_counter() - started) * 1000)
        dsp = m["dsp"] or {}
        return VoiceResult(
            decision=decision,
            voice_confidence=confidence,
            asv_cos=asv,
            cm_p_spoof=m["probability"],
            spec_sim=spec,
            phrase_wer=wer,
            onset_ms=m["onset_ms"],
            dsp=dsp.get("dsp", {}),
            findings=findings,
            stage_ms=m["timings"],
            spectrogram=dsp.get("spectrogram"),
        )

    async def enroll(self, takes, phrases):
        if len(takes) != 5 or len(phrases) != 5:
            raise ValueError("enrollment requires exactly five utterances")
        measurements = []
        for samples, phrase in zip(takes, phrases, strict=True):
            m = await self.measure(samples)
            if (
                m["errors"]
                or m["speech_s"] < 1
                or m["embedding"] is None
                or not m["dsp"]
                or m["probability"] is None
                or m["probability"] >= self.calibration.thresholds.cm
                or not phrase_match(phrase, m["transcript"] or "")[0]
            ):
                raise ValueError("Enrollment take failed phrase, speech or authenticity checks")
            measurements.append(m)
        if sum(m["speech_s"] for m in measurements) < self.calibration.enrollment_min_speech_s:
            raise ValueError(
                "Enrollment requires at least "
                f"{self.calibration.enrollment_min_speech_s:g} seconds of net speech"
            )
        embeddings = np.stack([unit_embedding(m["embedding"]) for m in measurements])
        pairwise = embeddings @ embeddings.T
        intra = float(np.min(pairwise[np.triu_indices(5, k=1)]))
        if intra < self.calibration.enrollment_min_cos:
            raise ValueError("Enrollment utterances do not consistently match one speaker")
        return dict(
            speaker_embedding=unit_embedding(embeddings.mean(axis=0)),
            utt_embeddings=embeddings.tolist(),
            spectral_summary=np.mean([m["dsp"]["ltas_db"] for m in measurements], axis=0),
            mfcc_mean=np.mean([m["dsp"]["mfcc_mean"] for m in measurements], axis=0),
            n_utts=5,
            intra_cos=intra,
        )


def score_audio(x, sr, profile) -> CMResult:
    from app.voice.state import state

    current = state()
    if current.mode == "stub":
        return CMResult(margin=0, ms={"total": 0})
    return current.pipeline.score_audio(x, sr, profile)
