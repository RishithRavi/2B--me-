"""Synthetic tick replayer: a fake agent over real HTTPS/WSS (CP1 walking skeleton, e2e, demo fallback).

It is NOT the real agent (Codex 1's `twobme-agent replay` replays class-level event logs through the
feature pipeline). This streams hand-shaped aggregate ticks — genuine ("a") around the contract
fixture values, impostor ("b") shifted — so the server/dashboard path can be exercised end to end.

    # stream: 2 min genuine then 1 min impostor, real time (5 s ticks)
    uv run python scripts/core_replay_ticks.py --api http://localhost:8000 --schedule a:24,b:12
    # the §11.2 e2e scenario with assertions (fast; uses the stub voice X-Fake-Decision header)
    uv run python scripts/core_replay_ticks.py --api http://localhost:8000 --e2e
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "common" / "src"))
from twobme_common.spec import load_spec  # noqa: E402

FIX = ROOT / "contracts" / "fixtures" / "ticks"

# impostor multipliers per feature prefix (a clearly different typist / pointer user)
IMPOSTOR_SCALE = {
    "kb.hold": 1.30, "kb.dd": 1.45, "kb.ud": 1.8, "kb.tri": 1.4, "kb.speed_kps": 0.6, "kb.burst_len_mean": 0.6,
    "kb.pause_rate": 2.2, "kb.bksp": 2.4, "kb.pre_bksp": 1.5, "kb.post_bksp": 1.5, "kb.shift_lead": 1.5,
    "kb.rollover_frac": 0.4, "ms.v_": 0.65, "ms.a_": 0.6, "ms.jerk": 1.6, "ms.curv": 1.8, "ms.angvel": 1.5,
    "ms.straightness": 0.8, "ms.dur": 1.5, "ms.submoves": 1.8, "ms.click_hold": 1.45, "ms.pre_click": 1.6,
    "ms.dwell": 1.7, "tp.rate": 0.7, "tp.idle": 1.6,
}


def _scale(name: str) -> float:
    for k, v in IMPOSTOR_SCALE.items():
        if name.startswith(k):
            return v
    return 1.0


class Synth:
    def __init__(self, seed: int = 1):
        self.spec = load_spec()
        self.rng = random.Random(seed)
        self.base = {m: json.loads((FIX / f"block_{m}.json").read_text()) for m in self.spec.modalities}
        self.last_wf = 0.0
        self.last_scroll = 0.0

    def block(self, modality: str, who: str, t_end: datetime) -> dict:
        b = self.base[modality]
        feats = {}
        for n in self.spec.names(modality):
            v = b["features"].get(n)
            if v is None:
                feats[n] = None
                continue
            center = v * (_scale(n) if who == "b" else 1.0)
            val = self.rng.gauss(center, abs(center) * 0.10 + 1e-3)
            if self.spec.unit(n) == "frac":
                val = min(max(val, 0.0), 1.0)
            feats[n] = round(val, 4)
        out = {"modality": modality, "t_start": (t_end - timedelta(seconds=4)).isoformat(),
               "t_end": t_end.isoformat(), "n": b["n"], "features": feats}
        if modality == "workflow":
            out["transitions"] = {"ide>browser": 2, "browser>ide": 1} if who == "a" else {"browser>chat": 2, "chat>docs": 1}
        if modality == "temporal":
            peak = 8 if who == "a" else 4
            out["psd"] = [round(-2.0 - 0.09 * i + (0.8 if abs(i - peak) <= 1 else 0.0) + self.rng.gauss(0, 0.05), 3)
                          for i in range(32)]
        return out

    def tick(self, run_id: str, seq: int, session_id: str | None, who: str, activity: list[int]) -> dict:
        now = datetime.now(UTC)
        blocks = [self.block("keyboard", who, now), self.block("mouse", who, now)]
        if time.monotonic() - self.last_scroll > 15:
            blocks.append(self.block("scroll", who, now))
            self.last_scroll = time.monotonic()
        if time.monotonic() - self.last_wf > 60:
            blocks.append(self.block("workflow", who, now))
            self.last_wf = time.monotonic()
        return {
            "type": "tick", "run_id": run_id, "session_id": session_id, "seq": seq, "t_end": now.isoformat(),
            "flags": {"secure_input": False, "injected": 0, "pointer": "trackpad", "late": False, "idle_s": 0.0,
                      "clock_skew": False},
            "counts": {"keys": 24, "mouse_moves": 380, "clicks": 2, "scroll_events": 6, "app_switches": 0},
            "activity": activity, "blocks": blocks, "context": self.block("temporal", who, now),
        }


class FakeAgent:
    def __init__(self, api: str, token: str, mode: str | None = None):
        self.api = api.rstrip("/")
        self.ws_url = self.api.replace("http", "ws", 1) + "/ws/agent"
        self.token = token
        self.mode = mode
        self.run_id = str(uuid.uuid4())
        self.seq = 0
        self.session_id: str | None = None
        self.synth = Synth()
        self.inbox: list[dict] = []
        self.activity_log: dict[int, int] = {}

    async def __aenter__(self) -> FakeAgent:
        self.ws = await websockets.connect(self.ws_url, max_size=2**22)
        await self.ws.send(json.dumps({
            "type": "hello", "v": 1, "device_token": self.token, "run_id": self.run_id, "resume_session_id": None,
            "requested_mode": self.mode, "agent_version": "replay-0.1", "schema_version": 1, "os": "macOS 26.4",
            "pointer": "trackpad", "display": {"w_pt": 1512, "h_pt": 982, "hz": 120}}))
        await self._until("welcome")
        return self

    async def __aexit__(self, *a: object) -> None:
        await self.ws.close()

    async def _recv(self, timeout: float = 10.0) -> dict:
        m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout))
        if m.get("type") == "welcome":
            self.session_id = m["session_id"]
        return m

    async def _until(self, typ: str, seq: int | None = None) -> dict:
        while True:
            m = await self._recv()
            if m.get("type") == typ and (seq is None or m.get("seq") == seq):
                return m
            self.inbox.append(m)

    async def tick(self, who: str, back_s: float = 0.0) -> dict:
        """One tick; `back_s` backdates t_end (≤ 25 s, inside the 30 s skew window) to pace activity."""
        activity = [random.randint(2, 12) if who else 0 for _ in range(5)]
        t = self.synth.tick(self.run_id, self.seq, self.session_id, who, activity)
        if back_s:
            t_end = datetime.now(UTC) - timedelta(seconds=back_s)
            t["t_end"] = t_end.isoformat()
        base = int(datetime.fromisoformat(t["t_end"]).timestamp()) - len(activity)  # same mapping as the hub
        for i, n in enumerate(activity):
            self.activity_log[base + i + 1] = n
        await self.ws.send(json.dumps(t))
        seq = self.seq
        self.seq += 1
        return await self._until("trust", seq)

    def saw(self, typ: str) -> list[dict]:
        return [m for m in self.inbox if m.get("type") == typ]


async def login(c: httpx.AsyncClient, email: str, password: str) -> dict:
    r = await c.post("/api/auth/login", json={"email": email, "password": password})
    r.raise_for_status()
    return r.json()


async def presence(c: httpx.AsyncClient, agent: FakeAgent) -> dict:
    """Browser buckets that mirror the agent's recent activity (same laptop) → co-present."""
    now = int(time.time())
    buckets = [{"t_s": t, "keys": max(0, n // 2), "pointer": 0, "wheel": 0}
               for t, n in sorted(agent.activity_log.items()) if t > now - 25]
    r = await c.post("/api/web/presence", json={"buckets": buckets, "client_now_ms": int(time.time() * 1000)})
    r.raise_for_status()
    return r.json()


# ------------------------------------------------------------------------------------------------------
async def stream(args: argparse.Namespace) -> None:
    async with httpx.AsyncClient(base_url=args.api, timeout=30) as c:
        await login(c, args.email, args.password)
        token = args.device_token or os.environ.get("REPLAY_DEVICE_TOKEN")
        if not token:
            r = await c.post("/api/devices/register", json={"label": args.label, "pointer": "trackpad"})
            r.raise_for_status()
            token = r.json()["device_token"]
            print(f"registered device {r.json()['device_id']} (token saved to data/replay_token.txt)")
            (ROOT / "data").mkdir(exist_ok=True)
            (ROOT / "data" / "replay_token.txt").write_text(token)
        async with FakeAgent(args.api, token, args.mode) as agent:
            for part in args.schedule.split(","):
                who, n = part.split(":")
                for _ in range(int(n)):
                    t0 = time.monotonic()
                    tr = await agent.tick(who)
                    print(f"{who} seq={tr['seq']:4d} conf={tr['confidence']:.3f} level={tr['level']}")
                    await asyncio.sleep(max(0.0, args.interval - (time.monotonic() - t0)))


async def e2e(args: argparse.Namespace) -> int:
    ok = True
    admin = {"X-Admin-Token": args.admin_token} if args.admin_token else {}

    def check(name: str, cond: bool, detail: object = "") -> None:
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond and detail != "" else ""))
        ok = ok and cond

    async with httpx.AsyncClient(base_url=args.api, timeout=60) as c:
        me = await login(c, args.email, args.password)
        r = await c.post("/api/devices/register", json={"label": "e2e replay", "pointer": "trackpad"})
        dev = r.json()
        async with FakeAgent(args.api, dev["device_token"], "enroll") as agent:
            for _ in range(args.enroll_ticks):
                await agent.tick("a")
            j = await c.post("/api/enroll/train", json={"device_id": dev["device_id"], "source": "tiger"})
            check("train job accepted", j.status_code == 200, j.text)
            mi = {}
            for _ in range(120):
                mi = (await c.get("/api/models/active")).json()
                if mi.get("status") in ("ready", "failed"):
                    break
                await asyncio.sleep(0.25)
            check("model ready", mi.get("status") == "ready", mi)
            trs = [await agent.tick("a") for _ in range(8)]
            check("genuine stays ≥ 0.80", min(t["confidence"] for t in trs) >= 0.8, [round(t["confidence"], 3) for t in trs])
            await c.post("/api/demo/marker", json={"device_id": dev["device_id"], "label": "takeover_start"})
            t0 = time.monotonic()
            levels = []
            for _ in range(30):
                tr = await agent.tick("b")
                levels.append((tr["level"], round(tr["confidence"], 3)))
                if agent.saw("challenge"):
                    break
            check("impostor → suspicious", any(lv == "suspicious" for lv, _ in levels), levels)
            print("      ", levels[:12])
            ch = agent.saw("challenge")
            check("proactive challenge sent to agent", bool(ch) and ch[0]["trigger"] == "proactive", ch)
            print(f"      (ticks to arm: {len(levels)}; wall {time.monotonic() - t0:.1f}s)")
            d = (await c.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"})).json()
            check("attacker checkout → C", d.get("trans_status") == "C", d)
            cid = d.get("challenge_id")
            check("step-up consumed the armed challenge", bool(ch) and cid == ch[0]["challenge_id"], (cid, ch[:1]))
            r = await c.post(f"/api/voice/challenges/{cid}/response", files={"wav": ("r.wav", b"RIFF", "audio/wav")},
                             headers={"X-Fake-Decision": "BLOCK_IMPOSTOR"})
            out = r.json().get("outcome", {})
            check("BLOCK_IMPOSTOR locks the device", out.get("device_locked") is True, r.text[:200])
            check("attacker order → N", any(x["trans_status"] == "N" for x in out.get("resolved_decisions", [])), out)
            await c.post("/api/demo/marker", json={"device_id": dev["device_id"], "label": "takeover_end"})
            await login(c, args.email, args.password)  # sessions were revoked
            d2 = (await c.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"})).json()
            check("locked device → N", d2.get("trans_status") == "N", d2)
            u = await c.post("/api/voice/challenges", json={"reason": "unlock"})
            check("unlock challenge (new session)", u.status_code == 200, u.text)
            r = await c.post(f"/api/voice/challenges/{u.json()['challenge_id']}/response",
                             files={"wav": ("r.wav", b"RIFF", "audio/wav")}, headers={"X-Fake-Decision": "VERIFY"})
            check("VERIFY unlocks", r.json().get("outcome", {}).get("device_locked") is False, r.text[:200])
            for back in (20, 15, 10, 5, 0):  # 25 s of paced activity for the co-presence window
                tr = await agent.tick("a", back_s=back)
            check("trust back ≥ 0.90", tr["confidence"] >= 0.9, tr["confidence"])
            p = await presence(c, agent)
            check("same-laptop browser is co-present", p.get("binding") == "co-present", p)
            d3 = (await c.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"})).json()
            check("owner checkout → Y", d3.get("trans_status") == "Y", d3)
            det = (await c.get(f"/api/decisions/{d['decision_id']}")).json()
            check("attacker order stays N after owner VERIFY", det.get("final_trans_status") == "N", det)
        await asyncio.sleep(2.0)  # let the writer flush
        s = await c.get("/api/history/sessions")
        check("history/sessions from Tiger", s.status_code == 200 and len(s.json()) > 0, s.text[:200])
        st = (await c.get("/api/tiger/stats")).json()
        check("tiger/stats ok", st.get("ok") is True, st)
        if admin:
            rs = await c.post("/api/demo/reset", json={"device_id": dev["device_id"]}, headers=admin)
            check("demo reset", rs.status_code == 200, rs.text[:200])
    print("E2E " + ("PASSED" if ok else "FAILED") + f" (user {me['email']})")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("TWOBME_API", "http://localhost:8000"))
    ap.add_argument("--email", default="a@2bme.tech")
    ap.add_argument("--password", default=os.environ.get("SEED_PASSWORD_A", "a-dev-password"))
    ap.add_argument("--admin-token", default=os.environ.get("ADMIN_TOKEN", ""))
    ap.add_argument("--device-token", default=None)
    ap.add_argument("--label", default="Replay MacBook")
    ap.add_argument("--mode", choices=["enroll", "monitor"], default=None)
    ap.add_argument("--schedule", default="a:24,b:12", help="who:n_ticks,... (a genuine, b impostor)")
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between ticks (5 = real time)")
    ap.add_argument("--e2e", action="store_true")
    ap.add_argument("--enroll-ticks", type=int, default=40)
    args = ap.parse_args()
    if args.e2e:
        return asyncio.run(e2e(args))
    asyncio.run(stream(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
