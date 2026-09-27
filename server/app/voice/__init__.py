"""Voice service exports frozen at CP0."""

from app.voice.issuer import VoiceIssuer
from app.voice.router import router
from app.voice.startup import startup

issuer = VoiceIssuer()


def score_audio(x, sr, profile):
    from twobme_common.types import CMResult

    from app.voice.state import state

    current = state()
    if current.mode == "stub":
        return CMResult(margin=0, ms={"total": 0})
    return current.pipeline.score_audio(x, sr, profile)


__all__ = ["router", "issuer", "startup", "score_audio"]
