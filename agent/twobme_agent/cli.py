from __future__ import annotations
import argparse
import asyncio
from collections import deque
from datetime import datetime, timezone
import getpass
import json
import os
from pathlib import Path
import socket
import threading
import time
import uuid
import yaml


def root():
    return Path.home() / ".2bme"


def credentials():
    import keyring

    cfg = json.loads((root() / "device.json").read_text())
    token = keyring.get_password("2bme", cfg["device_id"])
    if not token:
        raise RuntimeError("Device token missing from Keychain; run pair")
    return cfg, token


def pair(args):
    import httpx, keyring
    from urllib.parse import urlsplit

    parsed = urlsplit(args.api)
    if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1"):
        raise ValueError("Pairing requires HTTPS")
    with httpx.Client(base_url=args.api, timeout=15) as c:
        response = c.post(
            "/api/auth/login",
            json={
                "email": args.email or input("Email: "),
                "password": getpass.getpass("Password: "),
            },
        )
        response.raise_for_status()
        response = c.post("/api/devices/register", json={})
        response.raise_for_status()
        data = response.json()
    keyring.set_password("2bme", data["device_id"], data["device_token"])
    root().mkdir(mode=0o700, parents=True, exist_ok=True)
    p = root() / "device.json"
    p.write_text(json.dumps({"device_id": data["device_id"], "api": args.api}))
    p.chmod(0o600)
    print("Paired; device token saved in Keychain.")


def display():
    import Quartz as Q

    b = Q.CGDisplayBounds(Q.CGMainDisplayID())
    mode = Q.CGDisplayCopyDisplayMode(Q.CGMainDisplayID())
    return {
        "w_pt": b.size.width,
        "h_pt": b.size.height,
        "hz": round(Q.CGDisplayModeGetRefreshRate(mode)) or 60,
    }


def load_spec(args):
    return yaml.safe_load(Path(args.contracts, "feature_spec.yaml").read_text())


def record(args):
    from .capture import Capture
    from .privacy import Recorder

    cap = Capture(args.contracts)
    path = (
        root()
        / "logs"
        / f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:6]}.jsonl"
    )
    recorder = Recorder(
        path,
        {
            "ev": "header",
            "schema_version": 1,
            "display": display(),
            "pointer": "trackpad",
            "label": args.label,
            "actor": args.actor,
        },
    )
    stop = threading.Event()
    errors = []

    def drain():
        try:
            while not stop.wait(0.1):
                while cap.queue:
                    e = cap.queue.popleft()
                    if e["ev"] != "control":
                        recorder.write(e)
        except Exception as exc:
            errors.append(exc)
            cap.running = False

    thread = threading.Thread(target=drain, daemon=True)
    try:
        cap.start()
        thread.start()
        print(f"Recording class-level metadata locally: {path}")
        cap.run()
    finally:
        stop.set()
        if thread.is_alive():
            thread.join()
        while cap.queue:
            e = cap.queue.popleft()
            if e["ev"] != "control":
                recorder.write(e)
        cap.close()
        recorder.close()
    if errors:
        raise errors[0]


def run(args):
    from rich.console import Console
    from rich.live import Live
    from rich.table import Table
    from .capture import Capture
    from .privacy import Recorder
    from .runtime import TickBuilder, handle_message
    from .transport import Outbox, Transport, iso

    cfg, token = credentials()
    spec = load_spec(args)
    d = display()
    run_id = str(uuid.uuid4())
    cap = Capture(args.contracts)
    builder = TickBuilder(spec, d, run_id)
    out = Outbox(root() / "outbox.sqlite")
    status = {"confidence": None, "level": "connecting", "per_modality": {}}
    inbox = deque()
    stop = threading.Event()
    errors = []
    recorder = None
    if args.record:
        recorder = Recorder(
            root() / "logs" / f"{run_id}.jsonl",
            {
                "ev": "header",
                "schema_version": 1,
                "display": d,
                "pointer": "trackpad",
                "label": "genuine",
                "actor": "a",
            },
        )

    session_path = root() / "session.json"
    resume = None
    if session_path.exists():
        saved = json.loads(session_path.read_text())
        if saved.get("device_id") == cfg["device_id"]:
            resume = saved.get("session_id")

    def message(m):
        if m.get("type") == "welcome":
            session_path.write_text(
                json.dumps(
                    {"device_id": cfg["device_id"], "session_id": m["session_id"]}
                )
            )
            session_path.chmod(0o600)
        if m.get("type") == "trust":
            status.update(m)
        inbox.append(m)

    transport = Transport(
        cfg["api"],
        token,
        {
            "type": "hello",
            "v": 1,
            "run_id": run_id,
            "resume_session_id": resume,
            "requested_mode": args.mode,
            "agent_version": "0.1.0",
            "schema_version": 1,
            "os": "macOS " + __import__("platform").mac_ver()[0],
            "pointer": "trackpad",
            "display": d,
            "last_unlock_at": None,
        },
        out,
        message,
    )
    ipc = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    ipc_path = root() / "agent.sock"
    if ipc_path.exists():
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            probe.sendto(b"ping", str(ipc_path))
            raise RuntimeError("An agent is already running")
        except (ConnectionRefusedError, FileNotFoundError):
            ipc_path.unlink(missing_ok=True)
        finally:
            probe.close()
    ipc.bind(str(ipc_path))
    ipc_path.chmod(0o600)
    ipc.settimeout(0.01)

    def worker():
        next_tick = (time.monotonic_ns() // 5_000_000_000 + 1) * 5_000_000_000
        try:
            while not stop.wait(0.1):
                try:
                    action = ipc.recv(64).decode()
                    if action in ("takeover_start", "takeover_end"):
                        if recorder:
                            recorder.write(
                                {
                                    "ev": "label",
                                    "t_ns": time.monotonic_ns(),
                                    "label": "impostor"
                                    if action == "takeover_start"
                                    else "genuine",
                                    "actor": "b" if action == "takeover_start" else "a",
                                }
                            )
                        transport.controls.append(
                            {
                                "type": "marker",
                                "label": action,
                                "t": iso(transport.clock.wall(time.monotonic_ns())),
                            }
                        )
                except socket.timeout:
                    pass
                now = time.monotonic_ns()
                while cap.queue:
                    e = cap.queue.popleft()
                    while next_tick <= e["t_ns"]:
                        tick = builder.tick(
                            next_tick, transport.session_id, transport.clock
                        )
                        if transport.session_id:
                            out.put(tick)
                        next_tick += 5_000_000_000
                    if e["ev"] == "control":
                        transport.controls.append(
                            {"type": "demo", "action": "reset"}
                            if e["action"] == "reset"
                            else {
                                "type": "marker",
                                "label": e["action"],
                                "t": iso(transport.clock.wall(e["t_ns"])),
                            }
                        )
                    else:
                        if recorder:
                            recorder.write(e)
                        if e["ev"] == "os":
                            if e["event"] == "screen_unlocked":
                                transport.hello["last_unlock_at"] = iso(
                                    transport.clock.wall(e["t_ns"])
                                )
                            transport.controls.append(
                                {
                                    "type": "os_event",
                                    "event": e["event"],
                                    "t": iso(transport.clock.wall(e["t_ns"])),
                                }
                            )
                        builder.add(e)
                while next_tick <= now:
                    tick = builder.tick(
                        next_tick, transport.session_id, transport.clock
                    )
                    if transport.session_id:
                        out.put(tick)
                    next_tick += 5_000_000_000
                while inbox:
                    m = inbox.popleft()
                    if (
                        recorder
                        and m.get("type") == "welcome"
                        and m.get("label") in ("genuine", "impostor")
                        and m.get("actor") in ("a", "b")
                    ):
                        recorder.write(
                            {
                                "ev": "label",
                                "t_ns": time.monotonic_ns(),
                                "label": m["label"],
                                "actor": m["actor"],
                            }
                        )
                    handle_message(m, cfg["api"])
        except Exception as exc:
            errors.append(exc)
            cap.running = False

    def network():
        try:
            asyncio.run(transport.run())
        except Exception as exc:
            errors.append(exc)
            cap.running = False

    def panel():
        table = Table(title="2bME · local capture")
        table.add_column("Signal")
        table.add_column("Status")
        table.add_row(
            "Trust",
            "Waiting for server"
            if status["confidence"] is None
            else f"{status['confidence']:.0%} · {status['level']}",
        )
        table.add_row(
            "Connection",
            "WebSocket" if transport.connected else "HTTPS fallback / reconnecting",
        )
        table.add_row("Capture", f"{cap.n_events} events · {cap.dropped} dropped")
        for modality, c in status["per_modality"].items():
            delta = c.get("delta", 0)
            table.add_row(
                modality, f"{delta:+.3f} " + ("▰" * min(20, round(abs(delta) * 20)))
            )
        return table

    threads = [
        threading.Thread(target=worker, daemon=True),
        threading.Thread(target=network, daemon=True),
    ]
    try:
        cap.start()
        builder.secure = cap.secure
        for thread in threads:
            thread.start()
        with Live(panel(), console=Console(), refresh_per_second=2) as live:
            while cap.running:
                cap.run(0.5)
                live.update(panel())
    finally:
        stop.set()
        transport.stopping = True
        cap.close()
        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=20)
        ipc.close()
        ipc_path.unlink(missing_ok=True)
        if recorder:
            recorder.close()
        out.close()
    if errors:
        raise errors[0]


async def replay(args):
    from .runtime import TickBuilder
    from .transport import Outbox, Transport

    spec = load_spec(args)
    cfg, token = credentials()
    ev = [
        json.loads(line)
        for line in Path(args.log).read_text().splitlines()
        if line.strip()
    ]
    header = ev[0]
    base = ev[1]["t_ns"]
    data = [dict(e, t_ns=e["t_ns"] - base) for e in ev[1:]]
    if args.then:
        second = [
            json.loads(line)
            for line in Path(args.then).read_text().splitlines()
            if line.strip()
        ]
        start = second[1]["t_ns"]
        data = [e for e in data if e["t_ns"] < args.at * 1e9] + [
            dict(e, t_ns=int(args.at * 1e9) + e["t_ns"] - start) for e in second[1:]
        ]
    data.sort(key=lambda e: e["t_ns"])
    run_id = str(uuid.uuid4())
    out = Outbox(root() / "outbox.sqlite")
    transport = Transport(
        cfg["api"],
        token,
        {
            "type": "hello",
            "v": 1,
            "run_id": run_id,
            "resume_session_id": None,
            "requested_mode": args.mode,
            "agent_version": "0.1.0",
            "schema_version": 1,
            "os": "replay",
            "pointer": header["pointer"],
            "display": header["display"],
            "last_unlock_at": None,
        },
        out,
    )
    task = asyncio.create_task(transport.run())
    try:
        async with asyncio.timeout(30):
            while transport.session_id is None:
                if task.done():
                    task.result()
                await asyncio.sleep(0.1)
        builder = TickBuilder(spec, header["display"], run_id, header["pointer"])
        mono = time.monotonic_ns()
        tick = 5_000_000_000
        cursor = 0
        while tick <= data[-1]["t_ns"] + 35_000_000_000:
            await asyncio.sleep(
                max(0, (mono + tick / args.speed - time.monotonic_ns()) / 1e9)
            )
            while cursor < len(data) and data[cursor]["t_ns"] < tick:
                e = dict(data[cursor], t_ns=mono + data[cursor]["t_ns"])
                builder.add(e)
                cursor += 1
            payload = builder.tick(mono + tick, transport.session_id, transport.clock)
            if args.speed > 1:
                payload["flags"]["late"] = True
            out.put(payload)
            tick += 5_000_000_000
        async with asyncio.timeout(30):
            while out.pending():
                await asyncio.sleep(0.2)
    finally:
        transport.stopping = True
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        out.close()


def main():
    p = argparse.ArgumentParser(prog="twobme-agent")
    p.add_argument("--contracts", default="contracts")
    p.add_argument("--api", default=os.environ.get("TWOBME_API", "https://2bme.tech"))
    sub = p.add_subparsers(dest="command", required=True)
    doc = sub.add_parser("doctor")
    doc.add_argument("--stage", action="store_true")
    doc.add_argument("--seconds", type=float, default=5)
    pa = sub.add_parser("pair")
    pa.add_argument("--email")
    rec = sub.add_parser("record")
    rec.add_argument("--label", choices=["genuine", "impostor"], default="genuine")
    rec.add_argument("--actor", choices=["a", "b"], default="a")
    ru = sub.add_parser("run")
    ru.add_argument("--mode", choices=["enroll", "monitor"], default="monitor")
    ru.add_argument("--record", action="store_true")
    rep = sub.add_parser("replay")
    rep.add_argument("--log", required=True)
    rep.add_argument("--then")
    rep.add_argument("--at", type=float, default=120)
    rep.add_argument("--speed", type=float, default=1)
    rep.add_argument("--mode", choices=["enroll", "monitor"], default="monitor")
    mark = sub.add_parser("mark")
    mark.add_argument("--end", action="store_true")
    args = p.parse_args()
    try:
        if args.command == "doctor":
            from .doctor import doctor

            result = doctor(args.contracts, args.stage, args.api, args.seconds)
            print(json.dumps(result, indent=2))
            raise SystemExit(0 if result["ok"] else 1)
        elif args.command == "pair":
            pair(args)
        elif args.command == "record":
            record(args)
        elif args.command == "run":
            run(args)
        elif args.command == "replay":
            if args.speed <= 0:
                p.error("--speed must be positive")
            if args.speed > 1 and args.mode != "enroll":
                p.error("--speed > 1 is ingest-only; use --mode enroll")
            asyncio.run(replay(args))
        elif args.command == "mark":
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
                sock.sendto(
                    b"takeover_end" if args.end else b"takeover_start",
                    str(root() / "agent.sock"),
                )
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        p.exit(1, f"{type(exc).__name__}: {exc}\n")


if __name__ == "__main__":
    main()
