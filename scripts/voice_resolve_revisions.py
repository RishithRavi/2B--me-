"""Resolve mutable Hugging Face refs once and persist their immutable revisions.

Run this only on the Linux batch box or serving VM. It does not download model
weights and never accepts a partial commit SHA.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from hearsay.models import DF_ARENA, ECAPA, FALLBACK

BACKBONE = "facebook/wav2vec2-xls-r-300m"
SHA = re.compile(r"[0-9a-f]{40}")


class ModelHub(Protocol):
    def model_info(self, repository: str, *, revision: str): ...


def resolve(api: ModelHub, repository: str) -> str:
    revision = api.model_info(repository, revision="main").sha
    if not isinstance(revision, str) or SHA.fullmatch(revision) is None:
        raise ValueError(f"{repository} did not resolve to a full commit SHA")
    return revision


def atomic_text(path: Path, contents: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["df-arena", "fallback"], default="df-arena")
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--calibration-path", type=Path)
    args = parser.parse_args()

    runtime_root = args.runtime_root.expanduser().resolve()
    calibration = (args.calibration_path or runtime_root / "calibration" / "expo.json").resolve()
    model = DF_ARENA if args.model == "df-arena" else FALLBACK
    from huggingface_hub import HfApi

    api = HfApi()
    revisions = {
        "countermeasure": {"repository": model, "revision": resolve(api, model)},
        "speaker": {"repository": ECAPA, "revision": resolve(api, ECAPA)},
    }
    if model == DF_ARENA:
        # DF_Arena remote code loads this repository separately. Record its
        # resolved revision even though the upstream loader cannot receive it.
        revisions["df_arena_backbone"] = {
            "repository": BACKBONE,
            "revision": resolve(api, BACKBONE),
            "enforced_by_upstream": False,
        }
    manifest = {
        "resolved_at": datetime.now(UTC).isoformat(),
        "source_ref": "main",
        "models": revisions,
    }
    env = {
        "HF_HOME": str(runtime_root / "hf"),
        "VOICE_MODE": "real",
        "VOICE_DEVICE": "cpu",
        "VOICE_CM_MODEL": model,
        "VOICE_CM_REVISION": revisions["countermeasure"]["revision"],
        "VOICE_ECAPA_REVISION": revisions["speaker"]["revision"],
        "VOICE_CALIBRATION_PATH": str(calibration),
    }
    atomic_text(runtime_root / "model-revisions.json", json.dumps(manifest, indent=2) + "\n")
    atomic_text(
        runtime_root / "voice-runtime.env",
        "\n".join(f"{name}={shlex.quote(value)}" for name, value in env.items()) + "\n",
    )
    print(
        json.dumps(
            {
                "manifest": str(runtime_root / "model-revisions.json"),
                "environment": str(runtime_root / "voice-runtime.env"),
                "calibration_present": calibration.is_file(),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
