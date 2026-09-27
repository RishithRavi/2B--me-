"""asyncpg pool with degraded mode (§6 A1): the API starts and serves from memory when Tiger is down.

`Db.up` is the single source of truth for `/status tiger=up|down`. A background task keeps
reconnecting; migrations run once on the first successful connection, and pgvector is
registered on pool connections only after the migrations created the extension.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import asyncpg

log = logging.getLogger("twobme.db")

# Errors that mean "Tiger is unavailable" rather than "this query is wrong": connection loss plus the
# PostgresError subclasses a server raises while (re)connecting — starting up / shutting down
# (CannotConnectNow, AdminShutdown, CrashShutdown), out of connection slots (TooManyConnections) or not
# accepting connections (ObjectNotInPrerequisiteState). They degrade to "db down", never raise into a caller
# on the hot path (agent hello → enroll counts).
DB_DOWN_ERRORS: tuple[type[BaseException], ...] = (
    OSError, asyncio.TimeoutError, asyncpg.PostgresConnectionError, asyncpg.InterfaceError,
    asyncpg.exceptions.CannotConnectNowError, asyncpg.exceptions.TooManyConnectionsError,
    asyncpg.exceptions.ObjectNotInPrerequisiteStateError, asyncpg.exceptions.AdminShutdownError,
    asyncpg.exceptions.CrashShutdownError,
)


async def _init_conn(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    try:
        from pgvector.asyncpg import register_vector

        await register_vector(conn)
    except Exception as e:  # extension missing -> vectors unavailable, rest still works
        log.warning("pgvector not registered: %s", e)


class Db:
    def __init__(self, dsn: str, *, connect_timeout_s: float = 8.0,
                 on_first_connect: Callable[[asyncpg.Connection], Awaitable[None]] | None = None):
        self.dsn = dsn
        self.connect_timeout_s = connect_timeout_s
        self.pool: asyncpg.Pool | None = None
        self._on_first_connect = on_first_connect
        self._migrated = False
        self._task: asyncio.Task | None = None
        self._stopping = False
        self.last_error: str | None = None
        self.connected_event = asyncio.Event()
        self.on_connected: list[Callable[[], Awaitable[None]]] = []

    @property
    def up(self) -> bool:
        return self.pool is not None

    @property
    def configured(self) -> bool:
        return bool(self.dsn)

    async def connect_once(self) -> bool:
        if not self.dsn:
            self.last_error = "TIGER_DATABASE_URL not set"
            return False
        try:
            if not self._migrated and self._on_first_connect:
                conn = await asyncio.wait_for(asyncpg.connect(self.dsn), self.connect_timeout_s)
                try:
                    await self._on_first_connect(conn)
                finally:
                    await conn.close()
                self._migrated = True
            self.pool = await asyncio.wait_for(
                asyncpg.create_pool(self.dsn, min_size=1, max_size=8, init=_init_conn,
                                    command_timeout=30, max_inactive_connection_lifetime=120),
                self.connect_timeout_s,
            )
            self.last_error = None
            self.connected_event.set()
            log.info("Tiger connected")
            for cb in self.on_connected:
                try:
                    await cb()
                except Exception:
                    log.exception("on_connected callback failed")
            return True
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            log.warning("Tiger connect failed: %s", self.last_error)
            self.pool = None
            return False

    def start(self) -> None:
        self._task = asyncio.create_task(self._keepalive(), name="db-keepalive")

    async def _keepalive(self) -> None:
        delay = 2.0
        while not self._stopping:
            if self.pool is None:
                if await self.connect_once():
                    delay = 2.0
                else:
                    delay = min(delay * 1.7, 30.0)
            else:
                try:
                    async with self.pool.acquire(timeout=5) as c:
                        await c.fetchval("SELECT 1")
                    delay = 10.0
                except Exception as e:
                    log.warning("Tiger ping failed: %s", e)
                    self.mark_down(e)
                    delay = 2.0
            await asyncio.sleep(delay)

    def mark_down(self, e: BaseException | None = None) -> None:
        if e is not None:
            self.last_error = f"{type(e).__name__}: {e}"
        pool, self.pool = self.pool, None
        self.connected_event.clear()
        if pool is not None:
            pool.terminate()

    async def close(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    # --- helpers that fail soft (return None / [] when down) --------------------------
    async def fetch(self, sql: str, *args: Any) -> list[asyncpg.Record] | None:
        if self.pool is None:
            return None
        try:
            return await self.pool.fetch(sql, *args)
        except DB_DOWN_ERRORS as e:
            self.mark_down(e)
            return None

    async def fetchrow(self, sql: str, *args: Any) -> asyncpg.Record | None:
        rows = await self.fetch(sql, *args)
        return rows[0] if rows else None

    async def execute(self, sql: str, *args: Any) -> bool:
        if self.pool is None:
            return False
        try:
            await self.pool.execute(sql, *args)
            return True
        except DB_DOWN_ERRORS as e:
            self.mark_down(e)
            return False
