"""Anomaly explanations (§6 A5, P1): Vultr Serverless Inference, 2 sentences, off the hot path.

Input is only trust before/after and the top-5 (label, z) deviations — never content. Falls back
to a deterministic template when the key is missing or the call fails/times out.
"""

from __future__ import annotations

import asyncio
import logging

from twobme_common.types import AnomalyLive

log = logging.getLogger("twobme.explain")

KIND_TEXT = {
    "trust_drop": "Trust fell",
    "takeover_suspected": "A takeover is suspected",
    "voice_spoof": "The voice reply was flagged as synthetic",
    "voice_impostor": "The voice reply did not match the enrolled speaker",
    "lock": "The device was locked",
    "redteam_tool": "The red-team tool read the active challenge",
}


VOICE_KINDS = ("voice_spoof", "voice_impostor")
VOICE_ACTION_TEXT = {
    "lock": ", so the device was locked and the session signed out.",
    "unlock_denied": ", so the unlock was refused and the device stays locked.",
}


def _pct(p: float) -> int:
    return round(p * 100)


def _voice_simulated() -> bool:
    """True when the voice layer on this server is the stub (its verdicts are canned, badged "simulated")."""
    try:
        from app.core.voice_demo import voice_mode

        return voice_mode() == "stub"
    except Exception:
        return True  # voice_mode() itself falls back to "stub"


def template(a: AnomalyLive) -> str:
    head = KIND_TEXT.get(a.kind, a.kind.replace("_", " ").capitalize())
    moved = (a.trust_before is not None and a.trust_after is not None
             and _pct(a.trust_before) != _pct(a.trust_after))
    if a.kind in VOICE_KINDS:
        # a voice verdict: never explained with keyboard/mouse deviations (those belong to the takeover anomaly)
        text = head + VOICE_ACTION_TEXT.get(a.action or "", ".")
        if moved:
            verb = "fell" if a.trust_after < a.trust_before else "rose"
            text += f" Trust {verb} from {_pct(a.trust_before)}% to {_pct(a.trust_after)}%."
        if _voice_simulated():
            text += " The voice check on this server is simulated."
        return text
    if moved:
        head += f" from {_pct(a.trust_before)}% to {_pct(a.trust_after)}%"
    if a.top_features:
        parts = [f"{d.label} {d.z:+.1f}σ" for d in a.top_features[:3]]
        return f"{head}. The biggest departures from the enrolled profile were {', '.join(parts)}."
    return f"{head}."


class Explainer:
    def __init__(self, api_key: str, base_url: str, model: str, timeout_s: float = 8.0):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.timeout_s = timeout_s
        self._client = None

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.model)

    def _get_client(self):  # noqa: ANN202
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)
        return self._client

    async def explain(self, a: AnomalyLive) -> str:
        if a.kind == "redteam_tool" or a.kind in VOICE_KINDS:
            return template(a)  # the Vultr prompt only sees behavior features: a voice verdict stays templated
        if not self.enabled:
            return template(a)
        feats = "; ".join(f"{d.label}: z={d.z:+.2f}" for d in a.top_features[:5]) or "none"
        prompt = (
            "You explain behavioral-authentication alerts to a security analyst in exactly two short sentences. "
            "Use only the numbers given; do not speculate about content or identity.\n"
            f"Event: {a.kind}. Trust before: {a.trust_before}. Trust after: {a.trust_after}. "
            f"Top deviating behavior features vs the enrolled profile (robust z): {feats}."
        )
        try:
            resp = await asyncio.wait_for(
                self._get_client().chat.completions.create(
                    model=self.model, messages=[{"role": "user", "content": prompt}], max_tokens=120, temperature=0.2),
                self.timeout_s,
            )
            text = (resp.choices[0].message.content or "").strip()
            return text or template(a)
        except Exception as e:
            log.info("vultr inference failed, using template: %s", e)
            return template(a)
