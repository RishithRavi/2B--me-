"""Async batch writer (§5.5, §6 A1). Tiger is never on the hot path.

- `insert(table, row)` queues a row; `execute(sql, *args)` queues an UPDATE-style statement.
- Every `flush_s` seconds: inserts via `executemany INSERT ... ON CONFLICT DO NOTHING` (never COPY
  into a table with a unique index), then statements in order.
- A failed batch is retried row by row; rows that still fail are logged and counted.
- Connection loss re-queues everything at the front and marks the DB down.
- Bounded at `max_rows`: when full the oldest rows are dropped and counted (degraded mode).
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime
from typing import Any

import asyncpg

from app.db.pool import Db
from twobme_common.types import WriterStats, utcnow

log = logging.getLogger("twobme.writer")

HEADLINE = [
    "kb_hold_p50", "kb_dd_p50", "kb_ud_p50", "kb_speed_kps", "kb_bksp_rate",
    "ms_v_p50", "ms_curv_p50", "ms_straightness_p50", "ms_click_hold_p50",
    "sc_v_mean_p50", "wf_switch_rate", "tp_rate", "tp_b", "tp_idle_frac", "tp_peak_hz",
]

COLUMNS: dict[str, tuple[str, ...]] = {
    "feature_blocks": (
        "time", "block_start", "user_id", "device_id", "session_id", "channel", "modality",
        "schema_version", "mode", "n", "features", *HEADLINE, "extras", "typicality", "llr", "q", "delta",
        "model_version", "label", "actor", "baseline_eligible", "update_candidate", "flags",
    ),
    "trust_ticks": (
        "time", "device_id", "session_id", "user_id", "run_id", "seq", "confidence", "display", "logit",
        "delta_logit", "level", "kb_llr", "ms_llr", "sc_llr", "wf_llr", "tp_llr", "challenge_issued",
        "model_version", "label", "actor", "flags",
    ),
    "anomalies": (
        "time", "id", "user_id", "device_id", "session_id", "kind", "severity", "trust_before",
        "trust_after", "top_features", "action", "challenge_id", "explanation", "resolution",
    ),
    "markers": ("time", "device_id", "session_id", "label", "text"),
    "sessions": ("id", "user_id", "device_id", "channel", "kind", "status", "started_at", "ended_at",
                 "ended_reason", "run_id"),
    "decisions": (
        "id", "time", "user_id", "device_id", "session_id", "web_session_id", "action", "amount_cents",
        "tier", "binding", "confidence", "decision", "trans_status", "status", "challenge_id",
        "final_decision", "final_trans_status", "resolved_at", "reasons", "label", "actor",
    ),
    "voice_challenges": (
        "id", "user_id", "device_id", "session_id", "trigger", "status", "attempt", "phrase", "issued_at",
        "prompt_first_get_at", "expires_at", "asv_cos", "cm_p_spoof", "spec_sim", "phrase_wer", "onset_ms",
        "voice_confidence", "decision", "findings", "decision_id",
    ),
}

_CONN_ERRORS = (OSError, asyncpg.PostgresConnectionError, asyncpg.InterfaceError, asyncio.TimeoutError)


def insert_sql(table: str) -> str:
    cols = COLUMNS[table]
    ph = ", ".join(f"${i + 1}" for i in range(len(cols)))
    return f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({ph}) ON CONFLICT DO NOTHING"


class Writer:
    def __init__(self, db: Db, *, max_rows: int = 50_000, flush_s: float = 1.5):
        self.db = db
        self.max_rows = max_rows
        self.flush_s = flush_s
        self._rows: deque[tuple[str, tuple[Any, ...]]] = deque()
        self._stmts: deque[tuple[str, tuple[Any, ...]]] = deque()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self.dropped = 0
        self.flushed = 0
        self.failed_batches = 0
        self.failed_rows = 0
        self.last_flush_at: datetime | None = None

    # --- producers (sync, never block) -------------------------------------------------
    def insert(self, table: str, row: dict[str, Any]) -> None:
        cols = COLUMNS[table]
        unknown = set(row) - set(cols)
        if unknown:
            raise KeyError(f"{table}: unknown columns {sorted(unknown)}")
        self._push(self._rows, (table, tuple(row.get(c) for c in cols)))

    def execute(self, sql: str, *args: Any) -> None:
        self._push(self._stmts, (sql, args))

    def _push(self, q: deque, item: tuple) -> None:
        if len(self._rows) + len(self._stmts) >= self.max_rows:
            victim = self._rows if self._rows else self._stmts
            victim.popleft()
            self.dropped += 1
        q.append(item)

    @property
    def queued(self) -> int:
        return len(self._rows) + len(self._stmts)

    def stats(self) -> WriterStats:
        return WriterStats(queued=self.queued, dropped=self.dropped, flushed=self.flushed,
                           failed_batches=self.failed_batches, last_flush_at=self.last_flush_at)

    # --- consumer --------------------------------------------------------------------------
    def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="writer")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        try:
            await asyncio.wait_for(self.flush(), 5)
        except Exception:
            pass

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.flush_s)
            try:
                await self.flush()
            except Exception:  # never let the writer die
                log.exception("writer flush crashed")

    async def flush(self) -> int:
        async with self._lock:
            if self.db.pool is None or not self.queued:
                return 0
            rows = list(self._rows)
            self._rows.clear()
            stmts = list(self._stmts)
            self._stmts.clear()
            done = 0
            try:
                by_table: dict[str, list[tuple]] = {}
                for t, r in rows:
                    by_table.setdefault(t, []).append(r)
                # sessions/decisions/challenges first so later UPDATEs find their rows
                order = ["sessions", "voice_challenges", "decisions", "markers", "anomalies",
                         "trust_ticks", "feature_blocks"]
                for t in sorted(by_table, key=lambda x: order.index(x) if x in order else 99):
                    done += await self._insert_many(t, by_table[t])
                for i, (sql, args) in enumerate(stmts):
                    try:
                        await self.db.pool.execute(sql, *args)
                        done += 1
                    except _CONN_ERRORS:
                        # requeue the statements not yet applied
                        for item in reversed(stmts[i:]):
                            self._stmts.appendleft(item)
                        raise
                    except Exception as e:
                        self.failed_rows += 1
                        log.warning("statement failed: %s | %s", e, sql[:120])
            except _CONN_ERRORS as e:
                log.warning("writer lost Tiger: %s — requeueing", e)
                for item in reversed(rows):
                    self._rows.appendleft(item)
                self.db.mark_down(e)
                return 0
            self.flushed += done
            self.last_flush_at = utcnow()
            return done

    async def _insert_many(self, table: str, rows: list[tuple]) -> int:
        sql = insert_sql(table)
        assert self.db.pool is not None
        try:
            async with self.db.pool.acquire() as conn:
                await conn.executemany(sql, rows)
            return len(rows)
        except _CONN_ERRORS:
            raise
        except Exception as e:
            self.failed_batches += 1
            log.warning("batch insert into %s failed (%s); retrying row by row", table, e)
        ok = 0
        async with self.db.pool.acquire() as conn:
            for r in rows:
                try:
                    await conn.execute(sql, *r)
                    ok += 1
                except _CONN_ERRORS:
                    raise
                except Exception as e:
                    self.failed_rows += 1
                    log.warning("row insert into %s failed: %s", table, e)
        return ok
