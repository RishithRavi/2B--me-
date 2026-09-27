"""Org demo engine behind /admin (§2.4): pseudonymous employees streamed through the REAL hub and Tiger.

Everything the admin panel shows for these rows is computed server-side from these ticks (the same hub, models,
arming state machine, audit trail and Tiger tables as A's real device). Only the behavior is synthetic:
each "Employee NN" is a fake agent over /ws/agent with a personal baseline (the contract fixture values scaled by
a per-employee persona), enrolled quickly from back-dated `late` ticks and trained through the normal
/api/enroll/train path (admin token), then streamed in real time (one tick per --interval seconds).

Scenarios, repeated every --loop-min minutes (each loop starts with an admin /api/demo/reset of the scenario
devices and of any locked synthetic device, so the story repeats). A device a person admin-LOCKED is left alone for
--admin-lock-hold loop(s) before it is recycled: the engine never silently undoes a human decision within a judge's
visit. Every call carries `X-Actor: org-demo engine`, so the audit trail says "org-demo engine (API token)" and never
attributes the engine's resets to the human admin.
  * Employee 07 — takeover: impostor-style blocks from T+60 s → trust falls → suspicious → the hub arms a
    proactive voice challenge, which is left for the admin to act on (Lock / Force re-verify / Acknowledge).
  * Employee 13 — insider drift (intermittent credential sharing): over ~4 min a growing share of ticks is
    off-baseline, steered from the confidence the hub returns so trust ramps into the watch band and settles at
    ~0.62 without arming a challenge → the roster's `insider_drift` flag.
  * Employee 19 — away: the laptop "closes" from T+120 s to T+300 s (roster shows it offline, then reconnects).
  * Employee 04 — remote session: NOT simulated. A remote-binding decision needs a web session of that user and
    org-demo users have no usable password; no admin endpoint creates decisions on a user's behalf.

It never touches a@/b@ devices, so A's real agent coexists with it. Ctrl-C exits cleanly.

    uv run --no-sync python scripts/core_org_demo.py --api http://localhost:8000 --admin-token "$ADMIN_TOKEN"
    # a bounded run (e.g. a smoke test): --duration-min 4
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import math
import os
import random
import signal
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
import httpx
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core_replay_ticks import FakeAgent, Synth, _scale  # noqa: E402

ACTOR = "org-demo engine"  # audit actor for every call (X-Actor; recorded as "org-demo engine (API token)")
CATEGORIES = ["browser", "ide", "terminal", "chat", "docs", "media", "system", "other"]


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%H:%M:%S')} {msg}", flush=True)


# ------------------------------------------------------------------------------------------------------
# Synthetic behavior
# ------------------------------------------------------------------------------------------------------
class PersonaSynth(Synth):
    """Synth (core_replay_ticks) with a personal baseline: every feature centre is the contract fixture value times
    a per-employee factor, with per-employee noise, app habits and rhythm. `drift` interpolates each block from
    this person (0.0) toward an impostor-shaped version of them (1.0, the replayer's IMPOSTOR_SCALE)."""

    def __init__(self, seed: int, persona_sd: float = 0.12):
        super().__init__(seed)
        p = random.Random(seed * 7919 + 13)
        self.persona = {n: math.exp(p.gauss(0.0, persona_sd))
                        for m in self.spec.modalities for n in self.spec.names(m)}
        self.noise = 0.07 + 0.04 * p.random()
        a, b = p.sample(CATEGORIES[:5], 2)
        self.habits = {f"{a}>{b}": 2, f"{b}>{a}": 1}
        self.peak = p.randint(6, 11)

    def pblock(self, modality: str, t_end: datetime, drift: float) -> dict:
        base = self.base[modality]
        feats: dict[str, float | None] = {}
        for n in self.spec.names(modality):
            v = base["features"].get(n)
            if v is None:
                feats[n] = None
                continue
            center = v * self.persona[n] * (1.0 + drift * (_scale(n) - 1.0))
            val = self.rng.gauss(center, abs(center) * self.noise + 1e-3)
            if self.spec.unit(n) == "frac":
                val = min(max(val, 0.0), 1.0)
            feats[n] = round(val, 4)
        out = {"modality": modality, "t_start": (t_end - timedelta(seconds=4)).isoformat(),
               "t_end": t_end.isoformat(), "n": base["n"], "features": feats}
        if modality == "workflow":
            out["transitions"] = self.habits if self.rng.random() >= drift else {"browser>chat": 2, "chat>docs": 1}
        if modality == "temporal":
            peak = round(self.peak - drift * (self.peak - 4))
            out["psd"] = [round(-2.0 - 0.09 * i + (0.8 if abs(i - peak) <= 1 else 0.0) + self.rng.gauss(0, 0.05), 3)
                          for i in range(32)]
        return out

    def tick_dict(self, run_id: str, seq: int, session_id: str | None, t_end: datetime, drift: float,
                  late: bool = False, activity_scale: float = 1.0) -> dict:
        blocks = [self.pblock("keyboard", t_end, drift), self.pblock("mouse", t_end, drift)]
        if seq % 3 == 0:
            blocks.append(self.pblock("scroll", t_end, drift))
        if seq % 8 == 0:
            blocks.append(self.pblock("workflow", t_end, drift))
        if activity_scale < 1.0:  # lighter activity: fewer events per block, so each block carries less evidence
            for b in blocks:
                b["n"] = max(1, round(b["n"] * activity_scale))
        activity = [self.rng.randint(2, 12) for _ in range(5)]
        return {
            "type": "tick", "run_id": run_id, "session_id": session_id, "seq": seq, "t_end": t_end.isoformat(),
            "flags": {"secure_input": False, "injected": 0, "pointer": "trackpad", "late": late, "idle_s": 0.0,
                      "clock_skew": False},
            "counts": {"keys": 20 + self.rng.randint(0, 12), "mouse_moves": 300 + self.rng.randint(0, 150),
                       "clicks": self.rng.randint(1, 4), "scroll_events": 6 if seq % 3 == 0 else 0,
                       "app_switches": 1 if seq % 8 == 0 else 0},
            "activity": activity, "blocks": blocks, "context": self.pblock("temporal", t_end, drift),
        }


class EmpAgent(FakeAgent):
    """FakeAgent (core_replay_ticks) driving a PersonaSynth; hello may resume the previous session."""

    def __init__(self, api: str, token: str, synth: PersonaSynth, resume: str | None = None):
        super().__init__(api, token, None)
        self.synth = synth  # type: ignore[assignment]
        self.resume = resume

    async def __aenter__(self) -> EmpAgent:
        self.ws = await websockets.connect(self.ws_url, max_size=2**22, open_timeout=10)
        await self.ws.send(json.dumps({
            "type": "hello", "v": 1, "device_token": self.token, "run_id": self.run_id,
            "resume_session_id": self.resume, "requested_mode": None, "agent_version": "org-demo-0.1",
            "schema_version": 1, "os": "macOS 26.4", "pointer": "trackpad",
            "display": {"w_pt": 1512, "h_pt": 982, "hz": 120}}))
        await self._until("welcome")
        return self

    async def send_backdated(self, n: int, interval: float) -> dict:
        """n `late` ticks spaced `interval` s apart, all older than the 30 s skew window (they are stored as
        enrollment rows, never scored), then one real-time tick as a barrier: its trust reply means the hub has
        ingested everything before it."""
        now = datetime.now(UTC)
        for i in range(n):
            t_end = now - timedelta(seconds=40 + (n - 1 - i) * interval)
            await self.ws.send(json.dumps(self.synth.tick_dict(self.run_id, self.seq, self.session_id, t_end, 0.0,
                                                               late=True)))
            self.seq += 1
        return await self.live_tick(0.0)

    async def live_tick(self, drift: float, activity_scale: float = 1.0) -> dict:
        # session_id None: the hub stamps its current session, so a tick racing a /demo/reset is never "late"
        t = self.synth.tick_dict(self.run_id, self.seq, None, datetime.now(UTC), drift,
                                 activity_scale=activity_scale)
        await self.ws.send(json.dumps(t))
        seq = self.seq
        self.seq += 1
        tr = await self._until("trust", seq)
        errs = [m for m in self.inbox if m.get("type") == "error"]
        if errs:
            log(f"   agent error from hub: {errs[-1]}")
        self.inbox = [m for m in self.inbox[-20:] if m.get("type") in ("challenge", "lock", "unlock")]
        return tr


# ------------------------------------------------------------------------------------------------------
# Scenario state
# ------------------------------------------------------------------------------------------------------
@dataclass
class Employee:
    idx: int
    handle: str
    team: str
    user_id: str
    device_id: str
    token: str
    synth: PersonaSynth
    role: str = "steady"               # steady | takeover | drift | away
    session_id: str | None = None
    ready: bool = False
    drift: float = 0.0
    last: dict = field(default_factory=dict)
    connected: bool = False
    held_loops: int = 0                # loop resets skipped while a person's admin lock stands


@dataclass
class Ctx:
    args: argparse.Namespace
    http: httpx.AsyncClient
    emps: list[Employee]
    loop_start: float = 0.0
    loop_no: int = 0
    stop: asyncio.Event = field(default_factory=asyncio.Event)

    @property
    def admin(self) -> dict[str, str]:
        return {"X-Admin-Token": self.args.admin_token, "X-Actor": ACTOR}

    def t(self) -> float:
        return time.monotonic() - self.loop_start


def drift_target(t: float, start: float = 10.0, ramp: float = 230.0, floor: float = 0.62) -> float | None:
    """Confidence the insider-drift employee is steered toward: 0.97 at `start`, concave ramp to `floor` over
    `ramp` seconds (crosses 0.80 after ~85 s), then held."""
    if t < start:
        return None
    x = min(1.0, (t - start) / ramp) ** 0.7
    return 0.97 - (0.97 - floor) * x


def next_drift(emp: Employee, t: float, takeover_at: float) -> float:
    """0 = this employee, 1 = an impostor-shaped version of them.

    Takeover: 1 from `takeover_at`. Insider drift ("someone else is intermittently on this account"): each tick is
    either off-baseline or normal, chosen from the hub's last confidence vs drift_target(t), so trust follows the
    slow ramp into the watch band and stays there. A model is too sharp for a blended feature shift to hold a band
    (a small shift already scores as fully atypical), so this steers the mix instead of the blend."""
    if emp.role == "takeover":
        return 1.0 if t >= takeover_at else 0.0
    if emp.role == "drift":
        target = drift_target(t)
        conf = emp.last.get("confidence") if emp.last else None
        emp.drift = 1.0 if (target is not None and conf is not None and conf > target) else 0.0
        return emp.drift
    return 0.0


# while drifting, the employee types/points less (smaller blocks → q = n/n_ref ≈ 0.3), so each tick moves trust by
# ~±0.3 logit and the confidence hovers within a few points of the target instead of arming a challenge
DRIFT_ACTIVITY = 0.3


# ------------------------------------------------------------------------------------------------------
# API helpers
# ------------------------------------------------------------------------------------------------------
async def seed(ctx: Ctx) -> list[dict]:
    r = await ctx.http.post("/api/demo/org/seed", json={"n": ctx.args.n}, headers=ctx.admin)
    r.raise_for_status()
    return r.json()["employees"]


async def reseed_tokens(ctx: Ctx) -> None:
    fresh = {e["device_id"]: e["device_token"] for e in await seed(ctx)}
    for emp in ctx.emps:
        emp.token = fresh.get(emp.device_id, emp.token)
    log("re-seeded: device tokens rotated")


async def model_status(ctx: Ctx, emp: Employee) -> dict:
    r = await ctx.http.get("/api/models/active", params={"user_id": emp.user_id}, headers=ctx.admin)
    r.raise_for_status()
    return r.json()


async def enroll_one(ctx: Ctx, emp: Employee, sem: asyncio.Semaphore) -> None:
    async with sem:
        r = await ctx.http.post("/api/enroll/mode", json={"device_id": emp.device_id, "mode": "enroll"},
                                headers=ctx.admin)
        r.raise_for_status()
        async with EmpAgent(ctx.args.api, emp.token, emp.synth) as ag:
            emp.session_id = ag.session_id
            await ag.send_backdated(ctx.args.enroll_ticks, ctx.args.interval)


async def train_one(ctx: Ctx, emp: Employee, sem: asyncio.Semaphore) -> None:
    async with sem:
        r = await ctx.http.post("/api/enroll/train", json={"device_id": emp.device_id, "source": "tiger"},
                                headers=ctx.admin)
        if r.status_code != 200:
            log(f"   {emp.handle}: train refused {r.status_code} {r.text[:160]}")
            return
        mi: dict = {}
        for _ in range(240):
            mi = await model_status(ctx, emp)
            if mi.get("status") in ("ready", "failed") and mi.get("job_id") == r.json()["job_id"]:
                break
            await asyncio.sleep(0.5)
        emp.ready = mi.get("status") == "ready"
        n = sum((mi.get("n_blocks") or {}).values())
        log(f"   {emp.handle}: model {mi.get('status')} v{mi.get('version')} ({n} blocks, "
            f"{','.join(mi.get('enabled_modalities') or []) or '-'})"
            + (f" error: {mi.get('error')}" if mi.get("error") else ""))


async def reset_device(ctx: Ctx, emp: Employee) -> None:
    r = await ctx.http.post("/api/demo/reset", json={"device_id": emp.device_id}, headers=ctx.admin)
    if r.status_code != 200:
        log(f"   reset {emp.handle} failed: {r.status_code} {r.text[:120]}")
    emp.drift, emp.last = 0.0, {}


# ------------------------------------------------------------------------------------------------------
# Tasks
# ------------------------------------------------------------------------------------------------------
async def run_employee(ctx: Ctx, emp: Employee, offset: float) -> None:
    await asyncio.sleep(offset)
    backoff = 1.0
    while not ctx.stop.is_set():
        if emp.role == "away" and ctx.args.away_from <= ctx.t() < ctx.args.away_until:
            await asyncio.sleep(1.0)
            continue
        try:
            async with EmpAgent(ctx.args.api, emp.token, emp.synth, resume=emp.session_id) as ag:
                emp.connected, backoff = True, 1.0
                emp.session_id = ag.session_id
                nxt = time.monotonic()
                while not ctx.stop.is_set():
                    t = ctx.t()
                    if emp.role == "away" and ctx.args.away_from <= t < ctx.args.away_until:
                        log(f"   {emp.handle}: laptop closed (away until T+{ctx.args.away_until:.0f}s)")
                        break
                    scale = DRIFT_ACTIVITY if emp.role == "drift" and drift_target(t) is not None else 1.0
                    emp.last = await ag.live_tick(next_drift(emp, t, ctx.args.takeover_at), scale)
                    emp.session_id = ag.session_id
                    nxt += ctx.args.interval
                    await asyncio.sleep(max(0.0, nxt - time.monotonic()))
        except asyncio.CancelledError:
            raise
        except websockets.ConnectionClosed as e:
            code = e.rcvd.code if e.rcvd else None
            log(f"   {emp.handle}: connection closed ({code}); reconnecting in {backoff:.0f}s")
            if code == 4401:  # token rotated by another seed: pick up the fresh tokens
                with contextlib.suppress(Exception):
                    await reseed_tokens(ctx)
        except (OSError, TimeoutError, httpx.HTTPError, websockets.InvalidHandshake, websockets.InvalidURI) as e:
            log(f"   {emp.handle}: {type(e).__name__}: {e}; reconnecting in {backoff:.0f}s")
        finally:
            emp.connected = False
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(ctx.stop.wait(), backoff)
        backoff = min(30.0, backoff * 2)


async def coordinator(ctx: Ctx) -> None:
    scenario = [e for e in ctx.emps if e.role in ("takeover", "drift")]
    while not ctx.stop.is_set():
        ctx.loop_no += 1
        locked: list[Employee] = []
        admin_locked: set[str] = set()
        with contextlib.suppress(Exception):
            rows = (await ctx.http.get("/api/admin/roster", headers=ctx.admin)).json()
            ids = {r["device_id"] for r in rows if r.get("locked")}
            admin_locked = {r["device_id"] for r in rows if r.get("lock_reason") == "admin_lock"}
            locked = [e for e in ctx.emps if e.device_id in ids and e not in scenario]
        todo, held = [], []
        for emp in scenario + locked:
            if emp.device_id in admin_locked and emp.held_loops < ctx.args.admin_lock_hold:
                emp.held_loops += 1
                held.append(emp)
                continue
            emp.held_loops = 0
            todo.append(emp)
        for emp in todo:
            await reset_device(ctx, emp)
        ctx.loop_start = time.monotonic()
        extra = f"; left {', '.join(e.handle for e in held)} admin-locked (a person's decision)" if held else ""
        log(f"loop {ctx.loop_no}: reset {', '.join(e.handle for e in todo) or 'nothing'}{extra}; "
            f"takeover at T+{ctx.args.takeover_at:.0f}s, drift from T+10s")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(ctx.stop.wait(), ctx.args.loop_min * 60)


async def reporter(ctx: Ctx) -> None:
    while not ctx.stop.is_set():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(ctx.stop.wait(), 30)
        if ctx.stop.is_set():
            return
        try:
            rows = (await ctx.http.get("/api/admin/roster", headers=ctx.admin)).json()
        except Exception as e:  # noqa: BLE001 - status line only
            log(f"roster unavailable: {e}")
            continue
        mine = {e.device_id: e for e in ctx.emps}
        syn = [r for r in rows if r["device_id"] in mine]
        levels: dict[str, int] = {}
        for r in syn:
            levels[r["level"]] = levels.get(r["level"], 0) + 1
        online = sum(1 for r in syn if r["online"])
        focus = [f"{r['handle']} {r['display']}% {r['level']}"
                 + (f" [{','.join(r['flags'])}]" if r["flags"] else "") for r in syn if r["flags"]]
        log(f"T+{ctx.t():4.0f}s online {online}/{len(syn)} {levels} | " + (" | ".join(focus) or "no flags"))


async def main_async(args: argparse.Namespace) -> int:
    async with httpx.AsyncClient(base_url=args.api, timeout=30) as http:
        st = (await http.get("/api/status")).json()
        log(f"API {args.api}: tiger={st.get('tiger')} voice_warm={st.get('voice_warm')} demo={st.get('demo_mode')} "
            f"backend={(st.get('inference') or {}).get('model_backend')}")
        ctx = Ctx(args=args, http=http, emps=[])
        roles = {args.takeover: "takeover", args.drift: "drift", args.away: "away"}
        for e in await seed(ctx):
            idx = int(e["handle"].split()[-1])
            ctx.emps.append(Employee(idx=idx, handle=e["handle"], team=e["team"], user_id=e["user_id"],
                                     device_id=e["device_id"], token=e["device_token"],
                                     synth=PersonaSynth(args.seed * 1000 + idx), role=roles.get(idx, "steady")))
        log(f"seeded {len(ctx.emps)} employees; scenarios: "
            + ", ".join(f"{e.handle}={e.role}" for e in ctx.emps if e.role != "steady")
            + "; Employee 04 remote session: skipped (needs a user web session)")

        # enrollment + training, only for employees without a ready model
        need = []
        for emp in ctx.emps:
            mi = await model_status(ctx, emp)
            emp.ready = mi.get("status") == "ready"
            if not emp.ready:
                need.append(emp)
        if need:
            log(f"enrolling {len(need)} employees ({args.enroll_ticks} back-dated ticks each) ...")
            sem = asyncio.Semaphore(6)
            await asyncio.gather(*(enroll_one(ctx, e, sem) for e in need))
            log("training (POST /api/enroll/train, admin token) ...")
            sem = asyncio.Semaphore(args.train_parallel)
            await asyncio.gather(*(train_one(ctx, e, sem) for e in need))
        log(f"{sum(e.ready for e in ctx.emps)}/{len(ctx.emps)} employees have a ready model; streaming "
            f"every {args.interval:.0f}s")

        ctx.loop_start = time.monotonic()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):  # clean stop even when started with SIGINT ignored (nohup, &)
            with contextlib.suppress(NotImplementedError, RuntimeError):
                loop.add_signal_handler(sig, ctx.stop.set)
        tasks = [asyncio.create_task(coordinator(ctx), name="coordinator"),
                 asyncio.create_task(reporter(ctx), name="reporter")]
        n = len(ctx.emps)
        tasks += [asyncio.create_task(run_employee(ctx, e, args.interval * i / n), name=e.handle)
                  for i, e in enumerate(ctx.emps)]
        try:
            if args.duration_min > 0:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(ctx.stop.wait(), args.duration_min * 60)
            else:
                await ctx.stop.wait()
        finally:
            ctx.stop.set()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            log("stopped (agents disconnected)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--api", default=os.environ.get("TWOBME_API", "http://localhost:8000"))
    ap.add_argument("--admin-token", default=os.environ.get("ADMIN_TOKEN", ""))
    ap.add_argument("--n", type=int, default=19, help="employees (1-40)")
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between ticks per employee")
    ap.add_argument("--loop-min", type=float, default=8.0, help="scenario loop length (minutes)")
    ap.add_argument("--duration-min", type=float, default=0.0, help="stop after N minutes (0 = until Ctrl-C)")
    ap.add_argument("--enroll-ticks", type=int, default=150, help="back-dated enrollment ticks per employee")
    ap.add_argument("--train-parallel", type=int, default=3)
    ap.add_argument("--takeover", type=int, default=7, help="employee number of the takeover scenario (0 = off)")
    ap.add_argument("--takeover-at", type=float, default=60.0, help="seconds into each loop")
    ap.add_argument("--drift", type=int, default=13, help="employee number of the insider-drift scenario (0 = off)")
    ap.add_argument("--away", type=int, default=19, help="employee number that goes offline each loop (0 = off)")
    ap.add_argument("--away-from", type=float, default=120.0)
    ap.add_argument("--away-until", type=float, default=300.0)
    ap.add_argument("--seed", type=int, default=42, help="persona seed (same seed = same employees)")
    ap.add_argument("--admin-lock-hold", type=int, default=1,
                    help="loop resets to skip for a device a person admin-locked before recycling it")
    args = ap.parse_args()
    if not args.admin_token:
        ap.error("--admin-token (or ADMIN_TOKEN) is required")
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        log("interrupted")
        return 0
    except httpx.HTTPStatusError as e:
        log(f"API error: {e.response.status_code} {e.response.text[:200]}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
