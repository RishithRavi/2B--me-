"""Warm real models before exposing a ready voice service. Failures stay closed."""

import asyncio

from app.config import get_settings
from app.core.runtime import rt
from app.voice.config import VoiceSettings
from app.voice.state import VoiceState


def load_pipeline(settings, data_path):
    from hearsay.models import Countermeasure, SpeakerEncoder, pinned_revision
    from hearsay.vad import VoiceActivityDetector

    from app.voice.providers import ElevenSpeech, LocalSTT
    from app.voice.service import Calibration, Pipeline

    pinned_revision(settings.voice_cm_revision)
    pinned_revision(settings.voice_ecapa_revision)
    if settings.voice_calibration_path is None:
        raise ValueError("VOICE_CALIBRATION_PATH is required in real mode")
    calibration = Calibration.load(
        settings.voice_calibration_path,
        model=settings.voice_cm_model,
        revision=settings.voice_cm_revision,
        speaker_revision=settings.voice_ecapa_revision,
    )
    stt = (
        LocalSTT.load(settings.voice_local_stt_path)
        if settings.stt_backend == "local" or settings.elevenlabs_mode == "stub"
        else ElevenSpeech(settings.elevenlabs_api_key)
    )
    return Pipeline(
        cm=Countermeasure.load(
            model=settings.voice_cm_model,
            revision=settings.voice_cm_revision,
            device=settings.voice_device,
            threads=6,
        ),
        speaker=SpeakerEncoder.load(
            revision=settings.voice_ecapa_revision,
            savedir=str(data_path / "models" / "ecapa"),
            device=settings.voice_device,
        ),
        vad=VoiceActivityDetector.load(),
        stt=stt,
        calibration=calibration,
    )


async def startup():
    core = get_settings()
    settings = VoiceSettings()
    current = VoiceState(settings, settings.mode(demo=core.demo_mode))
    rt().extras["voice_service"] = current
    if current.mode == "stub":
        current.ready = True
        return
    # Cancellation of model loading must not install a late warm service.
    current.pipeline = await asyncio.to_thread(load_pipeline, settings, core.data_path)
    try:
        await current.pipeline.warmup()
        if settings.elevenlabs_mode == "live":
            from app.voice.prompts import PromptPool
            from app.voice.providers import ElevenSpeech

            provider = ElevenSpeech(
                settings.elevenlabs_api_key, settings.elevenlabs_prompt_voice_id
            )
            current.prompts = PromptPool(core.data_path / "prompt_pool", provider.synthesize)
            await current.prompts.warmup()
        current.ready = True
    except BaseException:
        current.pipeline.close()
        current.pipeline = None
        raise
