import { describe, expect, it } from "vitest";

import type { EvalReport } from "@/lib/contracts";
import { sampleEval } from "@/lib/sample-data";

import {
  blockTotals,
  dataKind,
  disabledReasons,
  eerPoint,
  eerStrength,
  frrAtFar,
  identificationRan,
  impostorReuse,
  liveTrialStats,
  measuredModalities,
  operatingRows,
  recordingCounts,
  splitInfo,
  tunedOnImpostor,
  type RocPoint,
} from "./metrics";

/** Shape of the committed reports/eval.json (real, weak, 0 live trials, identification not run). */
function realLike(): EvalReport {
  const mouse: RocPoint[] = [
    [0, 0],
    [0, 0.2],
    [0.1, 0.3],
    [0.4, 0.5],
    [0.6, 0.7],
    [1, 1],
  ];
  return {
    generated_at: "2026-09-26T18:59:00.019745+00:00",
    n_blocks: { a: { mouse: 23, scroll: 13 }, b: { mouse: 54, scroll: 50 } },
    modalities: {
      keyboard: { auc: null, eer: null, roc: [], n_genuine: 0, n_impostor: 0, beta: 6, weak: true },
      mouse: { auc: 0.55, eer: 0.45, roc: mouse as [number, number][], n_genuine: 23, n_impostor: 54, beta: 6, weak: true },
      workflow: { auc: null, eer: null, roc: [], n_genuine: 0, n_impostor: 0, beta: 6, weak: true },
    },
    fused: { auc: 0.78, eer: 0.375 },
    ablation: [],
    identification: { labels: ["a", "b"], confusion: [[0, 0], [0, 0]], accuracy: null },
    live_trials: [],
    splice: null,
    notes: [
      "Disabled A modalities: {'keyboard': 'Need 100 eligible blocks; have 39', 'workflow': 'Need 20 eligible blocks; have 8'}",
      "Two-way identification unavailable: B has insufficient enrollment/calibration data.",
      "REAL recordings; no synthetic data used. These few sessions are limited development evidence.",
    ],
  } as EvalReport;
}

describe("ROC operating points", () => {
  it("finds the equal-error crossing by interpolation", () => {
    // diagonal chance curve: EER is exactly 0.5
    const p = eerPoint([
      [0, 0],
      [1, 1],
    ]);
    expect(p?.far).toBeCloseTo(0.5, 9);
    expect(p?.frr).toBeCloseTo(0.5, 9);
  });

  it("matches the evaluator's EER on a stepped curve", () => {
    const roc: RocPoint[] = [
      [0, 0],
      [0, 0.5],
      [0.2, 0.5],
      [0.2, 0.9],
      [1, 1],
    ];
    const p = eerPoint(roc)!;
    // crossing lies on the segment (0.2, 0.5) → (0.2, 0.9): FAR 0.2 there
    expect(p.far).toBeCloseTo(0.2, 9);
    expect(p.frr).toBeCloseTo(p.far, 12);
  });

  it("reads FRR at a FAR budget from the step function (no optimistic interpolation)", () => {
    const roc: RocPoint[] = [
      [0, 0],
      [0.05, 0.3],
      [0.15, 0.6],
      [1, 1],
    ];
    expect(frrAtFar(roc, 0.1)).toBeCloseTo(0.7, 12);
    expect(frrAtFar(roc, 0.15)).toBeCloseTo(0.4, 12);
    expect(frrAtFar(roc, 0)).toBe(1);
    expect(frrAtFar([], 0.1)).toBeNull();
  });

  it("builds rows only for measured branches, plus the fused EER", () => {
    const rows = operatingRows(realLike(), 0.1);
    expect(rows.map((r) => r.m)).toEqual(["mouse", "fused"]);
    expect(rows[0].frrAtBudget).toBeCloseTo(0.7, 12);
    expect(rows[1]).toEqual({ m: "fused", eer: 0.375, frrAtBudget: null });
  });
});

describe("report provenance", () => {
  it("parses the evaluator's disabled-modality note", () => {
    expect(disabledReasons(realLike().notes)).toEqual({
      keyboard: "Need 100 eligible blocks; have 39",
      workflow: "Need 20 eligible blocks; have 8",
    });
    expect(disabledReasons(["nothing here"])).toEqual({});
  });

  it("classifies real, sample and synthetic reports from their own notes", () => {
    expect(dataKind(realLike())).toBe("real");
    expect(dataKind(sampleEval())).toBe("sample");
    expect(dataKind({ ...realLike(), notes: ["SYNTHETIC DATA ONLY — validates the pipeline"] })).toBe("synthetic");
    expect(dataKind({ ...realLike(), notes: [] })).toBe("unknown");
  });

  it("does not show an identification matrix that was never run", () => {
    expect(identificationRan(realLike())).toBe(false);
    expect(identificationRan({ ...realLike(), identification: null })).toBe(false);
    expect(identificationRan(sampleEval())).toBe(true);
  });

  it("counts blocks, measured branches and live trials", () => {
    const r = realLike();
    expect(blockTotals(r)).toEqual({ a: 36, b: 104 });
    expect(measuredModalities(r)).toEqual(["mouse"]);
    expect(liveTrialStats(r)).toEqual({ n: 0, detected: 0, median: null });
    const s = liveTrialStats(sampleEval());
    expect(s.n).toBe(5);
    expect(s.median).toBe(47);
  });

  it("only attaches recording counts to the exact report they describe", () => {
    expect(recordingCounts(realLike())).toEqual({ a: 3, b: 1 });
    expect(recordingCounts({ ...realLike(), generated_at: "2026-09-27T06:00:00Z" })).toBeNull();
    expect(recordingCounts({ ...realLike(), recordings: { a: 4, b: 2 } } as EvalReport)).toEqual({ a: 4, b: 2 });
  });

  it("says when not-A tuned the model, so the EERs are not a blind test", () => {
    const r = realLike();
    expect(impostorReuse(r)).toEqual({ betaFitted: [], modelSelection: true });
    const fitted = { ...r, modalities: { ...r.modalities, mouse: { ...r.modalities.mouse!, beta: 4.79, weak: false } } } as EvalReport;
    expect(impostorReuse(fitted).betaFitted).toEqual(["mouse"]);
    expect(tunedOnImpostor(r)).toBe(true);
    const blind = { ...r, notes: [...r.notes, "B blocks were not used for model selection."] };
    expect(impostorReuse(blind)).toEqual({ betaFitted: [], modelSelection: false });
    expect(tunedOnImpostor(blind)).toBe(false);
    expect(tunedOnImpostor(sampleEval())).toBe(false);
  });

  it("reads the optional split block defensively", () => {
    expect(splitInfo(realLike())).toBeNull();
    const withSplit = { ...realLike(), split: { training_counts: { mouse: 80 }, test_counts: { mouse: 23 }, purge_seconds: 60 } } as EvalReport;
    expect(splitInfo(withSplit)).toEqual({ train: { mouse: 80 }, test: { mouse: 23 }, purge_s: 60 });
  });

  it("names EER strength without hiding the number", () => {
    expect(eerStrength(0.375)).toBe("weak");
    expect(eerStrength(0.16)).toBe("moderate");
    expect(eerStrength(0.05)).toBe("strong");
    expect(eerStrength(null)).toBe("none");
  });
});
