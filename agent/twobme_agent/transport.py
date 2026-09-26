from __future__ import annotations
import asyncio
from collections import deque
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time
import threading
from urllib.parse import urlsplit, urlunsplit
import httpx
from websockets.asyncio.client import connect


def iso(ns):
    return (
        datetime.fromtimestamp(ns / 1e9, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class ClockOffset:
    def __init__(self):
        self.samples = deque(maxlen=8)
        self.offset = 0
        self.wall_origin = time.time_ns() - time.monotonic_ns()

    def pong(self, t0_ns, server_ns, now_ns=None):
        now = time.time_ns() if now_ns is None else now_ns
        rtt = now - t0_ns
        if rtt < 0:
            return
        self.samples.append((rtt, server_ns - (t0_ns + now) // 2))
        self.offset = min(self.samples, key=lambda x: x[0])[1]

    def wall(self, mono_ns):
        return mono_ns + self.wall_origin + self.offset


class Outbox:
    def __init__(self, path, max_rows=17280):
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(p, check_same_thread=False)
        p.chmod(0o600)
        self.max_rows = max_rows
        self.lock = threading.RLock()
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS ticks (run_id TEXT, seq INTEGER, payload TEXT NOT NULL, PRIMARY KEY(run_id,seq))"
        )
        self.db.commit()

    def put(self, tick):
        with self.lock:
            if (
                self.db.execute("SELECT COUNT(*) FROM ticks").fetchone()[0]
                >= self.max_rows
            ):
                raise RuntimeError(
                    "Outbox full; restore network before continuing capture"
                )
            with self.db:
                self.db.execute(
                    "INSERT OR IGNORE INTO ticks VALUES(?,?,?)",
                    (tick["run_id"], tick["seq"], json.dumps(tick, allow_nan=False)),
                )

    def pending(self):
        with self.lock:
            return [
                json.loads(r[0])
                for r in self.db.execute(
                    "SELECT payload FROM ticks ORDER BY rowid LIMIT 100"
                )
            ]

    def ack(self, run, seq):
        with self.lock, self.db:
            self.db.execute("DELETE FROM ticks WHERE run_id=? AND seq=?", (run, seq))

    def close(self):
        self.db.close()


class Transport:
    def __init__(self, base, token, hello, outbox, on_message=lambda m: None):
        parsed = urlsplit(base)
        if parsed.scheme != "https" and parsed.hostname not in (
            "localhost",
            "127.0.0.1",
            "::1",
        ):
            raise ValueError("Remote endpoints require HTTPS")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Base URL cannot include credentials, query or fragment")
        self.base = base.rstrip("/")
        self.ws_url = urlunsplit(
            (
                "wss" if parsed.scheme == "https" else "ws",
                parsed.netloc,
                "/ws/agent",
                "",
                "",
            )
        )
        self.token = token
        self.hello = hello
        self.outbox = outbox
        self.on_message = on_message
        self.clock = ClockOffset()
        self.session_id = None
        self.device_id = None
        self.mode = hello.get("requested_mode")
        self.controls = deque()
        self.stopping = False
        self.connected = False

    async def _receive(self, ws):
        async for raw in ws:
            m = json.loads(raw)
            kind = m.get("type")
            if kind == "welcome":
                self.session_id = m["session_id"]
                self.device_id = m["device_id"]
                self.mode = m.get("mode")
                self.hello["resume_session_id"] = self.session_id
            elif kind == "clock_pong":
                self.clock.pong(m["t0_ns"], m["server_ns"])
            elif kind == "mode":
                self.mode = m["mode"]
            elif kind == "trust" and m.get("seq") is not None:
                self.outbox.ack(self.hello["run_id"], m["seq"])
            self.on_message(m)

    async def _send(self, ws):
        sent = set()
        last_ping = 0
        while not self.stopping:
            if time.monotonic() - last_ping > 60:
                await ws.send(
                    json.dumps({"type": "clock_ping", "t0_ns": time.time_ns()})
                )
                last_ping = time.monotonic()
            if self.session_id:
                for tick in self.outbox.pending():
                    key = (tick["run_id"], tick["seq"])
                    if tick["run_id"] != self.hello["run_id"]:
                        await self.fallback(prior_only=True)
                        continue
                    if key in sent:
                        continue
                    tick["flags"]["late"] = tick["flags"].get("late", False) or tick[
                        "t_end"
                    ] < iso(time.time_ns() - 10_000_000_000)
                    await ws.send(json.dumps(tick))
                    sent.add(key)
                while self.controls:
                    await ws.send(json.dumps(self.controls.popleft()))
            await asyncio.sleep(0.2)

    async def fallback(self, prior_only=False):
        async with httpx.AsyncClient(timeout=10) as client:
            for tick in self.outbox.pending():
                if prior_only and tick["run_id"] == self.hello["run_id"]:
                    continue
                tick["flags"]["late"] = True
                response = await client.post(
                    self.base + "/api/agent/ticks",
                    json={"ticks": [tick]},
                    headers={"Authorization": "Bearer " + self.token},
                )
                response.raise_for_status()
                self.outbox.ack(tick["run_id"], tick["seq"])

    async def run(self):
        backoff = 1
        while not self.stopping:
            try:
                async with connect(
                    self.ws_url, open_timeout=10, max_size=1_000_000
                ) as ws:
                    await ws.send(json.dumps(dict(self.hello, device_token=self.token)))
                    self.connected = True
                    backoff = 1
                    tasks = [
                        asyncio.create_task(self._receive(ws)),
                        asyncio.create_task(self._send(ws)),
                    ]
                    try:
                        done, _ = await asyncio.wait(
                            tasks, return_when=asyncio.FIRST_COMPLETED
                        )
                        for task in done:
                            task.result()
                    finally:
                        for task in tasks:
                            task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
            except (
                OSError,
                ValueError,
                TimeoutError,
                httpx.HTTPError,
                __import__("websockets").exceptions.WebSocketException,
            ):
                self.connected = False
                try:
                    await self.fallback()
                except (OSError, httpx.HTTPError):
                    pass
                await asyncio.sleep(backoff)
                backoff = min(15, backoff * 2)
            finally:
                self.connected = False
