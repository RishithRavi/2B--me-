"""Tiny idempotent migration runner (§6 A2).

Each infra/migrations/NNN_*.sql file is split into statements and every statement runs in
autocommit (TimescaleDB `CALL ...` procedures and continuous-aggregate refreshes refuse to run
inside a transaction block). Files are written to be re-runnable (IF NOT EXISTS / if_exists =>),
so the runner simply re-applies everything on each start and records what it saw.

    uv run python -m app.db.migrate            # uses TIGER_DATABASE_URL
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

import asyncpg

log = logging.getLogger("twobme.migrate")


def split_sql(sql: str) -> list[str]:
    """Split on top-level semicolons; respects '...', "...", $tag$...$tag$ and -- / /* */ comments."""
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(sql)
    dollar: str | None = None
    while i < n:
        c = sql[i]
        if dollar:
            if sql.startswith(dollar, i):
                buf.append(dollar)
                i += len(dollar)
                dollar = None
                continue
            buf.append(c)
            i += 1
            continue
        if c == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j < 0 else j
            i = j
            continue
        if c == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in ("'", '"'):
            j = i + 1
            while j < n:
                if sql[j] == c:
                    if j + 1 < n and sql[j + 1] == c:
                        j += 2
                        continue
                    break
                j += 1
            buf.append(sql[i:j + 1])
            i = j + 1
            continue
        if c == "$":
            m = re.match(r"\$[A-Za-z_]*\$", sql[i:])
            if m:
                dollar = m.group(0)
                buf.append(dollar)
                i += len(dollar)
                continue
        if c == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    stmt = "".join(buf).strip()
    if stmt:
        out.append(stmt)
    return out


async def run_migrations(conn: asyncpg.Connection, directory: Path) -> list[str]:
    files = sorted(p for p in directory.glob("*.sql"))
    applied = []
    for f in files:
        for stmt in split_sql(f.read_text()):
            try:
                await conn.execute(stmt)
            except Exception as e:
                # optional statements are tagged with a leading `/* optional */` comment in the file;
                # after comment stripping we can't see it, so match on well-known optional features.
                if _is_optional(stmt):
                    log.warning("optional migration statement failed (%s): %s", f.name, e)
                    continue
                raise RuntimeError(f"{f.name}: {e}\n--- statement ---\n{stmt[:400]}") from e
        applied.append(f.name)
        try:
            await conn.execute(
                "INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET applied_at = now()",
                f.name,
            )
        except Exception:
            pass
    log.info("migrations applied: %s", applied)
    return applied


_OPTIONAL = ("vectorscale", "timescaledb_toolkit", "remove_columnstore_policy", "add_columnstore_policy",
             "add_continuous_aggregate_policy", "timescaledb.materialized_only")


def _is_optional(stmt: str) -> bool:
    return any(k in stmt for k in _OPTIONAL)


async def _main() -> None:
    from app.config import get_settings

    s = get_settings()
    conn = await asyncpg.connect(s.tiger_database_url)
    try:
        await run_migrations(conn, s.migrations_path)
    finally:
        await conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_main())
