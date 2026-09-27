from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.auth import CurrentPrincipal
from app.core.runtime import rt
from twobme_common.types import CheckoutIn, DecisionDetailOut, DecisionIn, DecisionOut, PresenceIn, PresenceOut

router = APIRouter(tags=["decisions"])


@router.post("/decisions", response_model=DecisionOut)
async def decisions(body: DecisionIn, p: CurrentPrincipal) -> DecisionOut:
    if body.action == "purchase" and body.amount_cents is None:
        raise HTTPException(422, "purchase needs amount_cents")
    rec = await rt().hub.decide(user_id=p.user.id, sid=p.sid, action=body.action, amount_cents=body.amount_cents)
    return rec.out()


@router.post("/checkout/authorize", response_model=DecisionOut)
async def checkout(body: CheckoutIn, p: CurrentPrincipal) -> DecisionOut:
    """Mock 3-D Secure-style authorization (Visa is a clearly labelled demo scenario, not affiliated)."""
    rec = await rt().hub.decide(user_id=p.user.id, sid=p.sid, action="purchase", amount_cents=body.amount_cents)
    return rec.out()


@router.get("/decisions/{decision_id}", response_model=DecisionDetailOut)
async def get_decision(decision_id: UUID, p: CurrentPrincipal) -> DecisionDetailOut:
    r = rt()
    rec = r.hub.decisions.get(decision_id)
    if rec is not None:
        if rec.user_id != p.user.id and not p.is_admin:
            raise HTTPException(404, "unknown decision")
        return rec.detail()
    # §5.3: not in memory (API restarted, or pruned) → the Tiger row, so "the attacker's order stays N" survives
    row = await r.db.fetchrow(
        "SELECT id, user_id, action, amount_cents, tier, binding, confidence, decision, trans_status, status, "
        "challenge_id, final_decision, final_trans_status, resolved_at, reasons FROM decisions WHERE id = $1",
        decision_id)
    if row is None or (row["user_id"] != p.user.id and not p.is_admin):
        raise HTTPException(404, "unknown decision")
    reasons = row["reasons"] if isinstance(row["reasons"], list) else []
    return DecisionDetailOut(
        decision_id=row["id"], status=row["status"], decision=row["decision"], trans_status=row["trans_status"],
        confidence=float(row["confidence"]), tier=row["tier"], binding=row["binding"],
        reasons=[str(x) for x in reasons], challenge_id=row["challenge_id"],
        verify_url=r.settings.verify_url(row["challenge_id"]) if row["challenge_id"] and row["status"] == "pending"
        else None,
        action=row["action"], amount_cents=row["amount_cents"], final_decision=row["final_decision"],
        final_trans_status=row["final_trans_status"], resolved_at=row["resolved_at"],
    )


@router.post("/web/presence", response_model=PresenceOut)
async def presence(body: PresenceIn, p: CurrentPrincipal) -> PresenceOut:
    if p.sid is None:
        raise HTTPException(400, "presence needs a cookie session")
    buckets = [(b.t_s, b.keys + b.pointer + b.wheel) for b in body.buckets]
    binding, score, drt = rt().hub.presence_update(p.sid, p.user.id, buckets, body.client_now_ms)
    return PresenceOut(binding=binding, score=score, device_id=drt.device_id if drt else None)
