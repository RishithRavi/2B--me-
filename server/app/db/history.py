"""History / Tiger queries (§6 A2). Every function returns None when Tiger is down; the router then
serves the last cached payload (degraded mode)."""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from app.db.pool import Db
from twobme_common.spec import load_spec
from twobme_common.types import (
    AnomalyRow,
    AuditRow,
    BaselineOut,
    BaselineRow,
    DeviationOut,
    HypertableStat,
    MarkerPoint,
    SessionRow,
    TigerJob,
    TigerStats,
    TrustBucket,
    TrustSeries,
    utcnow,
)

HYPERTABLES = ("feature_blocks", "trust_ticks", "anomalies", "markers")


async def sessions(db: Db, user_id: UUID | None, limit: int,
                   device_id: UUID | None = None) -> list[SessionRow] | None:
    rows = await db.fetch(
        """
        SELECT s.id, s.device_id, s.user_id, s.channel, s.status, s.started_at, s.ended_at,
               t.n_ticks, t.avg_conf, t.min_conf, a.n_anom, m.n_markers
        FROM sessions s
        LEFT JOIN LATERAL (
            SELECT count(*) AS n_ticks, avg(confidence) AS avg_conf, min(confidence) AS min_conf
            FROM trust_ticks tt
            WHERE tt.session_id = s.id AND tt.device_id = s.device_id AND tt.time >= s.started_at
        ) t ON true
        LEFT JOIN LATERAL (
            SELECT count(*) AS n_anom FROM anomalies an WHERE an.session_id = s.id AND an.time >= s.started_at
        ) a ON true
        LEFT JOIN LATERAL (
            SELECT count(*) AS n_markers FROM markers mk WHERE mk.session_id = s.id AND mk.time >= s.started_at
        ) m ON true
        WHERE ($1::uuid IS NULL OR s.user_id = $1) AND ($3::uuid IS NULL OR s.device_id = $3)
          AND s.status <> 'purged' AND s.channel = 'desktop'
        ORDER BY s.started_at DESC
        LIMIT $2
        """,
        user_id, limit, device_id,
    )
    if rows is None:
        return None
    return [SessionRow(session_id=r["id"], device_id=r["device_id"], user_id=r["user_id"], channel=r["channel"],
                       status=r["status"], started_at=r["started_at"], ended_at=r["ended_at"],
                       n_ticks=r["n_ticks"] or 0, avg_confidence=r["avg_conf"], min_confidence=r["min_conf"],
                       n_anomalies=r["n_anom"] or 0, n_markers=r["n_markers"] or 0) for r in rows]


async def session_info(db: Db, session_id: UUID) -> dict[str, Any] | None:
    r = await db.fetchrow("SELECT id, user_id, device_id, started_at, ended_at FROM sessions WHERE id = $1", session_id)
    return dict(r) if r else None


def _auto_bucket(start: datetime, end: datetime) -> str:
    span = (end - start).total_seconds()
    if span <= 30 * 60:
        return "10 seconds"
    if span <= 6 * 3600:
        return "1 minute"
    if span <= 48 * 3600:
        return "10 minutes"
    return "1 hour"


async def trust_series(db: Db, *, device_id: UUID, session_id: UUID | None, start: datetime, end: datetime,
                       bucket: str | None) -> TrustSeries | None:
    bucket = bucket or _auto_bucket(start, end)
    raw = bucket.endswith("seconds") or bucket.endswith("second")
    if raw:
        rows = await db.fetch(
            """
            SELECT time_bucket_gapfill($1::interval, time, $3::timestamptz, $4::timestamptz) AS t,
                   avg(confidence) AS avg, min(confidence) AS min, max(confidence) AS max,
                   locf(last(confidence, time)) AS last,
                   count(*) FILTER (WHERE challenge_issued) AS n_stepups
            FROM trust_ticks
            WHERE device_id = $2 AND time >= $3 AND time < $4 AND ($5::uuid IS NULL OR session_id = $5)
            GROUP BY 1 ORDER BY 1
            """,
            timedelta_str(bucket), device_id, start, end, session_id,
        )
    else:
        rows = await db.fetch(
            """
            SELECT time_bucket_gapfill($1::interval, bucket, $3::timestamptz, $4::timestamptz) AS t,
                   avg(avg_conf) AS avg, min(min_conf) AS min, max(max_conf) AS max,
                   locf(last(last_conf, bucket)) AS last, sum(n_stepups) AS n_stepups
            FROM trust_1m
            WHERE device_id = $2 AND bucket >= $3 AND bucket < $4
            GROUP BY 1 ORDER BY 1
            """,
            timedelta_str(bucket), device_id, start, end,
        )
    if rows is None:
        return None
    mrows = await db.fetch(
        "SELECT time, label, text FROM markers WHERE device_id = $1 AND time >= $2 AND time < $3 ORDER BY time",
        device_id, start, end,
    ) or []
    return TrustSeries(
        session_id=session_id, bucket=bucket,
        points=[TrustBucket(t=r["t"], avg=r["avg"], min=r["min"], max=r["max"], last=r["last"],
                            n_stepups=int(r["n_stepups"] or 0)) for r in rows],
        markers=[MarkerPoint(t=m["time"], label=m["label"], text=m["text"]) for m in mrows
                 if m["label"] in ("takeover_start", "takeover_end", "note", "rearm", "reset")],
    )


def timedelta_str(bucket: str) -> timedelta:
    n, unit = bucket.split()
    n = float(n)
    unit = unit.rstrip("s")
    return {"second": timedelta(seconds=n), "minute": timedelta(minutes=n), "hour": timedelta(hours=n),
            "day": timedelta(days=n)}[unit]


async def anomalies(db: Db, user_id: UUID | None, limit: int,
                    device_id: UUID | None = None) -> list[AnomalyRow] | None:
    rows = await db.fetch(
        """
        SELECT a.time, a.id, a.kind, a.severity, a.device_id, a.session_id, a.trust_before, a.trust_after,
               a.top_features, a.action, a.challenge_id, a.explanation, a.resolution, vc.decision AS challenge_decision
        FROM anomalies a
        LEFT JOIN voice_challenges vc ON vc.id = a.challenge_id
        WHERE ($1::uuid IS NULL OR a.user_id = $1) AND ($3::uuid IS NULL OR a.device_id = $3)
        ORDER BY a.time DESC
        LIMIT $2
        """,
        user_id, limit, device_id,
    )
    if rows is None:
        return None
    out = []
    for r in rows:
        tops = []
        for d in r["top_features"] or []:
            try:
                tops.append(DeviationOut(**d))
            except Exception:
                continue
        out.append(AnomalyRow(id=r["id"], time=r["time"], kind=r["kind"], severity=r["severity"],
                              device_id=r["device_id"], session_id=r["session_id"], trust_before=r["trust_before"],
                              trust_after=r["trust_after"], top_features=tops, action=r["action"],
                              challenge_id=r["challenge_id"], challenge_decision=r["challenge_decision"],
                              explanation=r["explanation"], resolution=r["resolution"]))
    return out


async def baseline(db: Db, *, user_id: UUID, modality: str, session_id: UUID | None) -> BaselineOut | None:
    spec = load_spec()
    feats = [f for f in spec.modalities[modality].features if f.headline]
    if session_id is None:
        r = await db.fetchrow(
            "SELECT id FROM sessions WHERE user_id = $1 AND channel='desktop' ORDER BY started_at DESC LIMIT 1", user_id)
        session_id = r["id"] if r else None
    med: dict[str, float | None] = {f.column: None for f in feats}
    if session_id is not None:
        sel = ", ".join(f"percentile_cont(0.5) WITHIN GROUP (ORDER BY {f.column}) AS {f.column}" for f in feats)
        r = await db.fetchrow(f"SELECT {sel} FROM feature_blocks WHERE session_id = $1 AND modality = $2",
                              session_id, modality)
        if r is None and not db.up:
            return None
        if r is not None:
            med = {f.column: r[f.column] for f in feats}
    cols = ", ".join(f"{f.column}_avg, {f.column}_std, {f.column}_n" for f in feats)
    rows = await db.fetch(f"SELECT {cols} FROM block_baseline_hourly WHERE user_id = $1 AND modality = $2",
                          user_id, modality)
    if rows is None:
        return None
    out = []
    for f in feats:
        parts = [(r[f"{f.column}_avg"], r[f"{f.column}_std"], r[f"{f.column}_n"]) for r in rows
                 if r[f"{f.column}_n"] and r[f"{f.column}_avg"] is not None]
        mean = std = None
        n_tot = sum(n for _, _, n in parts)
        if n_tot:
            mean = sum(a * n for a, _, n in parts) / n_tot
            if n_tot > 1:
                ss = sum(((s or 0.0) ** 2) * (n - 1) + n * (a - mean) ** 2 for a, s, n in parts)
                std = math.sqrt(ss / (n_tot - 1))
        sm = med.get(f.column)
        z = (sm - mean) / std if (sm is not None and mean is not None and std) else None
        out.append(BaselineRow(feature=f.name, column=f.column, label=f.label, unit=f.unit, session_median=sm,
                               baseline_mean=mean, baseline_std=std, z=z))
    return BaselineOut(modality=modality, session_id=session_id, rows=out)


async def tiger_stats(db: Db) -> TigerStats | None:
    if not db.up:
        return None
    hts = []
    for h in HYPERTABLES:
        r = await db.fetchrow(
            """SELECT total_chunks, number_compressed_chunks, before_compression_total_bytes,
                      after_compression_total_bytes FROM hypertable_columnstore_stats($1::regclass)""", h)
        n = await db.fetchrow("SELECT approximate_row_count($1::regclass) AS n", h)
        if r is None:
            hts.append(HypertableStat(name=h, total_chunks=0, compressed_chunks=0, before_bytes=None, after_bytes=None,
                                      ratio=None, rows_estimate=n["n"] if n else None))
            continue
        before, after = r["before_compression_total_bytes"], r["after_compression_total_bytes"]
        hts.append(HypertableStat(
            name=h, total_chunks=r["total_chunks"] or 0, compressed_chunks=r["number_compressed_chunks"] or 0,
            before_bytes=before, after_bytes=after,
            ratio=(before / after) if before and after else None, rows_estimate=n["n"] if n else None))
    jobs = await db.fetch(
        """SELECT j.job_id, j.proc_name, j.hypertable_name, j.schedule_interval::text AS schedule_interval,
                  s.last_run_status, s.next_start
           FROM timescaledb_information.jobs j
           LEFT JOIN timescaledb_information.job_stats s USING (job_id)
           WHERE j.proc_name NOT IN ('policy_telemetry', 'policy_job_stat_history_retention')
           ORDER BY j.job_id""") or []
    caggs = await db.fetch("SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1") or []
    exts = await db.fetch("SELECT extname, extversion FROM pg_extension") or []
    return TigerStats(
        ok=True, hypertables=hts,
        jobs=[TigerJob(job_id=j["job_id"], proc=j["proc_name"], hypertable=j["hypertable_name"],
                       schedule_interval=j["schedule_interval"], last_run_status=j["last_run_status"],
                       next_start=j["next_start"]) for j in jobs],
        caggs=[c["view_name"] for c in caggs], extensions={e["extname"]: e["extversion"] for e in exts},
        cached_at=utcnow(),
    )


async def compress_now(db: Db) -> int | None:
    total = 0
    for h in ("feature_blocks", "trust_ticks"):
        rows = await db.fetch(
            f"SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('{h}', "
            "older_than => INTERVAL '1 hour') c")
        if rows is None:
            return None
        total += len(rows)
    return total


async def audit(db: Db, limit: int, device_id: UUID | None) -> list[AuditRow] | None:
    """Org audit trail (§2.4, migration 006), newest first. None when Tiger is down."""
    if not db.up:
        return None
    rows = await db.fetch(
        """
        SELECT time, id, kind, device_id, user_id, handle, actor, summary, severity, ref_id
        FROM audit_log
        WHERE ($2::uuid IS NULL OR device_id = $2)
        ORDER BY time DESC
        LIMIT $1
        """,
        limit, device_id,
    )
    if rows is None:
        return None
    out = []
    for r in rows:
        try:
            out.append(AuditRow(id=r["id"], t=r["time"], kind=r["kind"], device_id=r["device_id"],
                                user_id=r["user_id"], handle=r["handle"], actor=r["actor"], summary=r["summary"],
                                severity=r["severity"], ref_id=r["ref_id"]))
        except Exception:  # a row written by a newer/older build with an unknown kind: skip, never 500
            continue
    return out
