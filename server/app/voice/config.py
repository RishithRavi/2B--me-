"""Voice-owned settings. No model loads or network calls at import time."""

from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class VoiceSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    voice_mode: Literal["stub", "real"] | None = None
    elevenlabs_mode: Literal["stub", "live"] = "stub"
    stt_backend: Literal["local", "elevenlabs"] = "local"
    voice_calibration_path: Path | None = None
    voice_cm_model: str = "Speech-Arena-2025/DF_Arena_500M_V_1"
    voice_cm_revision: str = ""
    voice_ecapa_revision: str = ""
    voice_device: Literal["cpu", "cuda"] = "cpu"
    voice_enrollment_label: Literal["quiet", "expo"] = "quiet"
    voice_local_stt_path: Path | None = None
    elevenlabs_api_key: str = ""
    elevenlabs_prompt_voice_id: str = ""
    voice_max_upload_bytes: int = 8 * 1024 * 1024

    def mode(self, *, demo: bool) -> str:
        mode = self.voice_mode or ("stub" if demo and self.elevenlabs_mode == "stub" else "real")
        if mode == "stub" and not demo:
            raise ValueError("stub voice is permitted only with DEMO_MODE=true")
        if self.voice_max_upload_bytes <= 0 or self.voice_max_upload_bytes > 16 * 1024 * 1024:
            raise ValueError("voice upload limit must be between 1 byte and 16 MiB")
        return mode
