"""Voice step-up service (§8 C2). STUB committed by Claude at A0; ownership → Codex 2 at CP0.

Exports (the contract the app relies on — keep these names):
    router: APIRouter            # mounted at /api/voice
    issuer: ChallengeIssuer      # app.core.ports.ChallengeIssuer
    async def startup() -> None  # preload + warm-up; lifespan awaits it (timeout)
    def score_audio(x, sr, profile) -> CMResult
Hub callbacks: app.core.events.{challenge_status, voice_stage, voice_decided, totp_decided}.
Persistence: app.db.repo_voice.
"""

from app.voice.issuer import FakeIssuer
from app.voice.router import router
from app.voice.service import score_audio
from app.voice.startup import startup

issuer = FakeIssuer()

__all__ = ["router", "issuer", "startup", "score_audio"]
