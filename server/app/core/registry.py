"""In-memory users / devices / web sessions, mirrored to `data/state/registry.json` (degraded mode, §6 A1).

Memory is authoritative at runtime. Every change is written to the local mirror (atomic rename)
and queued to Tiger via the writer, so login, decisions and voice keep working when Tiger is down
and a restart without Tiger still knows every device and its trust_state.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from twobme_common.types import utcnow

log = logging.getLogger("twobme.registry")

SEED_NS = uuid.UUID("2b0e0000-0000-4000-8000-000000000000")


def seed_user_id(email: str) -> UUID:
    return uuid.uuid5(SEED_NS, email.lower())


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _dt(v: Any) -> datetime | None:
    if v is None or isinstance(v, datetime):
        return v
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


@dataclass
class User:
    id: UUID
    email: str
    pw_hash: str
    handle: str
    role: str = "user"
    tz: str = "America/New_York"
    totp_secret_enc: str | None = None
    enrollment_status: str = "new"
    sessions_revoked_at: datetime | None = None
    team: str | None = None  # org-demo employees only (§2.4; migration 006)


@dataclass
class Device:
    id: UUID
    user_id: UUID
    token_hash: str
    label: str = "MacBook"
    os: str | None = None
    pointer: str | None = None
    display: dict | None = None
    last_seen: datetime | None = None
    mode: str = "enroll"
    locked: bool = False
    locked_at: datetime | None = None
    lock_reason: str | None = None
    trust_state: dict | None = None


@dataclass
class WebSession:
    sid: str
    user_id: UUID
    created_at: datetime
    revoked: bool = False
    meta: dict = field(default_factory=dict)


class Registry:
    def __init__(self, state_dir: Path, writer: Any | None = None):
        self.path = state_dir / "registry.json"
        self.writer = writer
        self.users: dict[UUID, User] = {}
        self.devices: dict[UUID, Device] = {}
        self.web_sessions: dict[str, WebSession] = {}
        self._dirty = False

    # --- lookup ---------------------------------------------------------------------------
    def user_by_email(self, email: str) -> User | None:
        e = email.strip().lower()
        return next((u for u in self.users.values() if u.email == e), None)

    def device_by_token(self, token: str) -> Device | None:
        h = token_hash(token)
        return next((d for d in self.devices.values() if secrets.compare_digest(d.token_hash, h)), None)

    def devices_of(self, user_id: UUID) -> list[Device]:
        return [d for d in self.devices.values() if d.user_id == user_id]

    def bound_device(self, user_id: UUID) -> Device | None:
        """A web session binds to the cookie user's most recently seen device (§5.3)."""
        devs = self.devices_of(user_id)
        if not devs:
            return None
        return max(devs, key=lambda d: (d.last_seen or datetime.min.replace(tzinfo=utcnow().tzinfo)))

    # --- mutation -------------------------------------------------------------------------
    def add_user(self, email: str, pw_hash: str, handle: str, role: str = "user") -> User:
        u = User(id=seed_user_id(email), email=email.lower(), pw_hash=pw_hash, handle=handle, role=role)
        self.users[u.id] = u
        self._queue_user(u)
        self.mark_dirty()
        return u

    def register_device(self, user_id: UUID, label: str, os_: str | None, pointer: str | None,
                        display: dict | None, mode: str = "enroll") -> tuple[Device, str]:
        token = "dt_" + secrets.token_urlsafe(32)
        d = Device(id=uuid.uuid4(), user_id=user_id, token_hash=token_hash(token), label=label, os=os_,
                   pointer=pointer, display=display, mode=mode, last_seen=None)
        self.devices[d.id] = d
        self._queue_device(d, insert=True)
        self.mark_dirty()
        return d, token

    def save_device(self, d: Device) -> None:
        self._queue_device(d, insert=False)
        self.mark_dirty()

    def save_user(self, u: User) -> None:
        self._queue_user(u)
        self.mark_dirty()

    def new_web_session(self, user_id: UUID) -> WebSession:
        ws = WebSession(sid=secrets.token_urlsafe(18), user_id=user_id, created_at=utcnow())
        self.web_sessions[ws.sid] = ws
        # prune old sessions (keep the store small)
        if len(self.web_sessions) > 500:
            for sid in sorted(self.web_sessions, key=lambda s: self.web_sessions[s].created_at)[:100]:
                self.web_sessions.pop(sid, None)
        self.mark_dirty()
        return ws

    def revoke_user_sessions(self, user_id: UUID) -> None:
        u = self.users.get(user_id)
        if not u:
            return
        u.sessions_revoked_at = utcnow()
        for ws in self.web_sessions.values():
            if ws.user_id == user_id:
                ws.revoked = True
        self.save_user(u)

    def mark_dirty(self) -> None:
        self._dirty = True

    # --- persistence ------------------------------------------------------------------------
    def _queue_user(self, u: User) -> None:
        if self.writer is None:
            return
        self.writer.execute(
            """INSERT INTO users (id, email, pw_hash, handle, role, tz, totp_secret_enc, enrollment_status,
                                  sessions_revoked_at, team)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (id) DO UPDATE SET pw_hash=EXCLUDED.pw_hash, handle=EXCLUDED.handle, role=EXCLUDED.role,
                 totp_secret_enc=EXCLUDED.totp_secret_enc, enrollment_status=EXCLUDED.enrollment_status,
                 sessions_revoked_at=EXCLUDED.sessions_revoked_at, team=EXCLUDED.team""",
            u.id, u.email, u.pw_hash, u.handle, u.role, u.tz, u.totp_secret_enc, u.enrollment_status,
            u.sessions_revoked_at, u.team,
        )

    def _queue_device(self, d: Device, insert: bool) -> None:
        if self.writer is None:
            return
        self.writer.execute(
            """INSERT INTO devices (id, user_id, token_hash, label, os, pointer, display, last_seen, mode, locked,
                                    locked_at, lock_reason, trust_state)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, os=EXCLUDED.os, pointer=EXCLUDED.pointer,
                 display=EXCLUDED.display, last_seen=EXCLUDED.last_seen, mode=EXCLUDED.mode, locked=EXCLUDED.locked,
                 locked_at=EXCLUDED.locked_at, lock_reason=EXCLUDED.lock_reason, trust_state=EXCLUDED.trust_state""",
            d.id, d.user_id, d.token_hash, d.label, d.os, d.pointer, d.display, d.last_seen, d.mode, d.locked,
            d.locked_at, d.lock_reason, d.trust_state,
        )

    def sync_all_to_db(self) -> None:
        """After (re)connecting to Tiger, push everything that may have changed while it was down."""
        for u in self.users.values():
            self._queue_user(u)
        for d in self.devices.values():
            self._queue_device(d, insert=True)

    async def load_from_db(self, db: Any) -> int:
        rows_u = await db.fetch("SELECT * FROM users")
        rows_d = await db.fetch("SELECT * FROM devices")
        if rows_u is None or rows_d is None:
            return 0
        n = 0
        for r in rows_u:
            if r["id"] not in self.users:
                self.users[r["id"]] = User(
                    id=r["id"], email=r["email"], pw_hash=r["pw_hash"], handle=r["handle"], role=r["role"],
                    tz=r["tz"], totp_secret_enc=r["totp_secret_enc"], enrollment_status=r["enrollment_status"],
                    sessions_revoked_at=r["sessions_revoked_at"], team=r.get("team"),
                )
                n += 1
        for r in rows_d:
            if r["id"] not in self.devices:
                self.devices[r["id"]] = Device(
                    id=r["id"], user_id=r["user_id"], token_hash=r["token_hash"], label=r["label"], os=r["os"],
                    pointer=r["pointer"], display=r["display"], last_seen=r["last_seen"], mode=r["mode"],
                    locked=r["locked"], locked_at=r["locked_at"], lock_reason=r["lock_reason"],
                    trust_state=r["trust_state"],
                )
                n += 1
        if n:
            self.mark_dirty()
        return n

    def save_mirror(self, force: bool = False) -> None:
        if not (self._dirty or force):
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "users": [_ser(asdict(u)) for u in self.users.values()],
            "devices": [_ser(asdict(d)) for d in self.devices.values()],
            "web_sessions": [_ser(asdict(s)) for s in self.web_sessions.values()],
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, default=str))
        os.replace(tmp, self.path)
        self._dirty = False

    def load_mirror(self) -> None:
        if not self.path.is_file():
            return
        try:
            data = json.loads(self.path.read_text())
        except Exception as e:
            log.error("registry mirror unreadable (%s); starting empty", e)
            return
        for u in data.get("users", []):
            u["id"] = UUID(u["id"])
            u["sessions_revoked_at"] = _dt(u.get("sessions_revoked_at"))
            self.users[u["id"]] = User(**u)
        for d in data.get("devices", []):
            d["id"], d["user_id"] = UUID(d["id"]), UUID(d["user_id"])
            d["last_seen"], d["locked_at"] = _dt(d.get("last_seen")), _dt(d.get("locked_at"))
            self.devices[d["id"]] = Device(**d)
        for s in data.get("web_sessions", []):
            s["user_id"] = UUID(s["user_id"])
            s["created_at"] = _dt(s["created_at"])
            self.web_sessions[s["sid"]] = WebSession(**s)
        log.info("registry mirror: %d users, %d devices", len(self.users), len(self.devices))


def _ser(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, UUID):
            v = str(v)
        elif isinstance(v, datetime):
            v = v.isoformat()
        out[k] = v
    return out
