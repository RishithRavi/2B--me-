"use client";

import { Archive, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { SimulatedBadge } from "@/components/dashboard/voice-analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { anomalyLabel } from "@/lib/live";
import { api, errorMessage } from "@/lib/api";
import type { AnomalyRow, BaselineRow, SessionRow, TigerStats } from "@/lib/contracts";
import { fmtAgo, fmtBytes, fmtClock, fmtDuration, fmtPct, fmtValue, fmtZ, levelColor, levelFromConfidence, shortId } from "@/lib/ui";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function ConfCell({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 rounded-full" style={{ background: levelColor(levelFromConfidence(v)) }} />
      <span className="tnum font-mono">{fmtPct(v)}</span>
    </span>
  );
}

export function SessionsTable({
  rows,
  selected,
  onSelect,
  deviceLabel,
}: {
  rows: SessionRow[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Employee or device name for a session's device_id (null when unknown to this viewer). */
  deviceLabel?: (deviceId: string | null) => string | null;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead className="hidden sm:table-cell">Duration</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Ticks</TableHead>
          <TableHead>Avg</TableHead>
          <TableHead>Min</TableHead>
          <TableHead className="text-right">Anomalies</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((s) => {
          const start = Date.parse(s.started_at);
          const end = s.ended_at ? Date.parse(s.ended_at) : Date.now();
          const active = s.session_id === selected;
          const who = deviceLabel?.(s.device_id) ?? null;
          return (
            <TableRow
              key={s.session_id}
              onClick={() => onSelect(s.session_id)}
              data-state={active ? "selected" : undefined}
              className={cn("cursor-pointer", active && "bg-muted/60")}
            >
              <TableCell>
                <div className="flex flex-col">
                  <span className="text-sm">{fmtAgo(s.started_at)}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {who && <span className="font-sans text-foreground/80">{who} · </span>}
                    {shortId(s.session_id)} · {s.channel}
                    {s.status === "active" ? " · live" : ""}
                  </span>
                </div>
              </TableCell>
              <TableCell className="tnum hidden font-mono text-xs sm:table-cell">{fmtDuration((end - start) / 1000)}</TableCell>
              <TableCell className="tnum hidden text-right font-mono text-xs sm:table-cell">{s.n_ticks.toLocaleString()}</TableCell>
              <TableCell>
                <ConfCell v={s.avg_confidence} />
              </TableCell>
              <TableCell>
                <ConfCell v={s.min_confidence} />
              </TableCell>
              <TableCell className="text-right">
                {s.n_anomalies > 0 ? (
                  <Badge variant="outline" className="border-trust-suspicious/45 text-trust-suspicious">
                    {s.n_anomalies}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

function Severity({ n }: { n: number }) {
  return (
    <span className="inline-flex gap-0.5" title={`severity ${n}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="h-2.5 w-1 rounded-sm" style={{ background: i <= n ? (n >= 4 ? "var(--trust-suspicious)" : "var(--trust-watch)") : "var(--muted)" }} />
      ))}
    </span>
  );
}

function outcomeTone(decision: string | null, resolution: string | null): { text: string; color: string } | null {
  const d = decision ?? resolution;
  if (!d) return null;
  const u = d.toUpperCase();
  if (u.includes("VERIFY") || u === "RECOVERED") return { text: d, color: "var(--trust-normal)" };
  if (u.startsWith("BLOCK") || u === "LOCKED" || u === "BLOCKED") return { text: d, color: "var(--trust-suspicious)" };
  return { text: d, color: "var(--trust-watch)" };
}

const VOICE_KINDS = new Set<string>(["voice_spoof", "voice_impostor"]);

export function AnomaliesList({
  rows,
  voiceSimulated = false,
  explanations = null,
}: {
  rows: AnomalyRow[];
  /** Stub voice server: voice-result anomalies came from canned outcomes, so they carry the "Simulated voice result" badge. */
  voiceSimulated?: boolean;
  /** Where explanations come from (/status inference.explanations): "template" ones are marked as such. */
  explanations?: "vultr" | "template" | null;
}) {
  return (
    <ol className="divide-y">
      {rows.map((a) => {
        const outcome = outcomeTone(a.challenge_decision, a.resolution);
        return (
          <li key={a.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <Severity n={a.severity} />
              <span className="text-sm font-medium capitalize">{anomalyLabel(a.kind)}</span>
              {voiceSimulated && VOICE_KINDS.has(a.kind) && <SimulatedBadge />}
              <span className="font-mono text-[11px] text-muted-foreground">
                {fmtClock(a.time)} · {fmtAgo(a.time)}
              </span>
              {a.trust_before !== null && a.trust_after !== null && (
                <span className="tnum font-mono text-xs text-muted-foreground">
                  {fmtPct(a.trust_before)} → <span style={{ color: levelColor(levelFromConfidence(a.trust_after)) }}>{fmtPct(a.trust_after)}</span>
                </span>
              )}
              {outcome && (
                <Badge variant="outline" className="ml-auto font-mono text-[10px]" style={{ color: outcome.color, borderColor: `color-mix(in oklch, ${outcome.color} 45%, transparent)` }}>
                  {a.challenge_id ? "challenge: " : ""}
                  {outcome.text}
                </Badge>
              )}
            </div>
            {a.top_features.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {a.top_features.map((f) => (
                  <span
                    key={f.feature}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      Math.abs(f.z) >= 2 ? "border-trust-suspicious/40 bg-trust-suspicious/10" : "text-muted-foreground",
                    )}
                  >
                    {f.label} <span className="tnum font-mono">{fmtZ(f.z)}</span>
                  </span>
                ))}
              </div>
            )}
            <p className={cn("text-sm leading-relaxed", a.explanation ? "text-muted-foreground" : "text-muted-foreground/60 italic")}>
              {a.explanation && explanations === "template" && (
                <span
                  className="mr-1.5 inline-flex -translate-y-px items-center rounded border px-1 py-px align-middle font-mono text-[9px] tracking-wide text-muted-foreground uppercase"
                  title="Written by a local template from the feature z-scores (no inference key on this server)"
                >
                  template
                </span>
              )}
              {a.explanation ?? "Explanation pending (Vultr inference writes it from the feature z-scores only)."}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export function BaselineTable({ rows }: { rows: BaselineRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Feature</TableHead>
          <TableHead className="text-right">Session median</TableHead>
          <TableHead className="text-right">Baseline</TableHead>
          <TableHead>z vs baseline</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const z = r.z;
          const frac = z === null ? 0 : Math.min(1, Math.abs(z) / 4);
          const red = z !== null && Math.abs(z) >= 2;
          return (
            <TableRow key={r.feature}>
              <TableCell className="text-sm">{r.label}</TableCell>
              <TableCell className="tnum text-right font-mono text-xs">{fmtValue(r.session_median, r.unit)}</TableCell>
              <TableCell className="tnum text-right font-mono text-xs text-muted-foreground">
                {fmtValue(r.baseline_mean, r.unit)}
                {r.baseline_std !== null && <span className="opacity-70"> ± {fmtValue(r.baseline_std, r.unit === "frac" ? "frac" : "")}</span>}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <div className="relative h-1.5 w-24 shrink-0 rounded-full bg-muted">
                    <div className="absolute inset-y-[-2px] left-1/2 w-px bg-foreground/25" />
                    {z !== null && (
                      <div
                        className="absolute inset-y-0 rounded-full"
                        style={{
                          width: `${frac * 50}%`,
                          [z < 0 ? "right" : "left"]: "50%",
                          background: red ? "var(--trust-suspicious)" : "var(--muted-foreground)",
                        }}
                      />
                    )}
                  </div>
                  <span className={cn("tnum w-12 text-right font-mono text-[11px]", red ? "text-trust-suspicious" : "text-muted-foreground")}>{fmtZ(z)}</span>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Tiger
// ---------------------------------------------------------------------------

export function TigerCard({ stats, isAdmin, onCompressed, mock }: { stats: TigerStats; isAdmin: boolean; onCompressed: () => void; mock: boolean }) {
  const [busy, setBusy] = useState(false);
  const totalBefore = stats.hypertables.reduce((a, h) => a + (h.before_bytes ?? 0), 0);
  const totalAfter = stats.hypertables.reduce((a, h) => a + (h.after_bytes ?? 0), 0);

  async function compress() {
    setBusy(true);
    try {
      if (!mock) await api.compressNow();
      toast.success(mock ? "Sample mode: nothing to compress" : "Compressing feature_blocks chunks older than 1 h…");
      onCompressed();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-6">
        {totalAfter > 0 ? (
          <div>
            <div className="eyebrow">Columnstore</div>
            <div className="tnum mt-1 text-3xl font-semibold tracking-tight">{`${(totalBefore / totalAfter).toFixed(1)}×`}</div>
            <div className="text-xs text-muted-foreground">
              {fmtBytes(totalBefore)} → {fmtBytes(totalAfter)}
            </div>
          </div>
        ) : (
          <div className="max-w-xs">
            <div className="eyebrow">Columnstore</div>
            <div className="mt-1 text-xl font-semibold tracking-tight">Not compressed yet</div>
            <div className="text-xs leading-snug text-muted-foreground">
              No chunk is old enough yet (policy: after 2 h). Admins: Compress now compresses chunks older than 1 h.
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {stats.caggs.map((c) => (
            <Badge key={c} variant="outline" className="font-mono text-[10px]">
              cagg {c}
            </Badge>
          ))}
          {Object.entries(stats.extensions).map(([k, v]) => (
            <Badge key={k} variant="outline" className="font-mono text-[10px] text-muted-foreground">
              {k} {v}
            </Badge>
          ))}
        </div>
        {isAdmin && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={compress} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Archive />} Compress now
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Hypertable</TableHead>
            <TableHead>Chunks compressed</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead className="text-right">Ratio</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.hypertables.map((h) => (
            <TableRow key={h.name}>
              <TableCell className="font-mono text-xs">{h.name}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${h.total_chunks ? (h.compressed_chunks / h.total_chunks) * 100 : 0}%` }} />
                  </div>
                  <span className="tnum font-mono text-xs text-muted-foreground">
                    {h.compressed_chunks}/{h.total_chunks}
                  </span>
                </div>
              </TableCell>
              <TableCell className="tnum text-right font-mono text-xs text-muted-foreground">
                {(h.after_bytes ?? 0) > 0 ? `${fmtBytes(h.before_bytes)} → ${fmtBytes(h.after_bytes)}` : "uncompressed"}
              </TableCell>
              <TableCell className="tnum text-right font-mono text-xs">{h.ratio !== null ? `${h.ratio.toFixed(1)}×` : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div>
        <div className="eyebrow mb-1.5">Background jobs</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Every</TableHead>
              <TableHead>Last run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.jobs.map((j) => (
              <TableRow key={j.job_id}>
                <TableCell className="font-mono text-[11px]">{j.proc.replace(/^policy_/, "")}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{j.hypertable ?? "—"}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{j.schedule_interval ?? "—"}</TableCell>
                <TableCell>
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: j.last_run_status === "Success" ? "var(--trust-normal)" : j.last_run_status ? "var(--trust-suspicious)" : "var(--muted-foreground)" }}
                  >
                    {j.last_run_status ?? "not run yet"}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {stats.cached_at && <p className="text-[11px] text-muted-foreground">server snapshot {fmtAgo(stats.cached_at)}</p>}
    </div>
  );
}
