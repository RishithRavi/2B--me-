import { Activity, AppWindow, Keyboard, MousePointer2, ScrollText } from "lucide-react";
import { describe, expect, it } from "vitest";

import {
  featureLabel,
  featureMeta,
  fmtAgo,
  fmtDuration,
  fmtMoney,
  fmtPct,
  fmtZ,
  levelColor,
  levelFromConfidence,
  levelLabel,
  modalityColor,
  modalityIcon,
} from "./ui";

describe("level helpers", () => {
  it("maps levels to semantic tokens", () => {
    expect(levelColor("normal")).toBe("var(--trust-normal)");
    expect(levelColor("watch")).toBe("var(--trust-watch)");
    expect(levelColor("suspicious")).toBe("var(--trust-suspicious)");
    expect(levelColor("locked")).toBe("var(--trust-locked)");
    expect(levelColor("learning")).toBe("var(--trust-learning)");
    expect(levelColor(null)).toBe("var(--trust-learning)");
  });

  it("labels levels", () => {
    expect(levelLabel("suspicious")).toBe("Suspicious");
    expect(levelLabel(undefined)).toBe("Unknown");
  });

  it("bands confidence per trust_config", () => {
    expect(levelFromConfidence(0.97)).toBe("normal");
    expect(levelFromConfidence(0.8)).toBe("normal");
    expect(levelFromConfidence(0.79)).toBe("watch");
    expect(levelFromConfidence(0.4)).toBe("watch");
    expect(levelFromConfidence(0.31)).toBe("suspicious");
  });
});

describe("formatters", () => {
  it("fmtPct", () => {
    expect(fmtPct(0.9712)).toBe("97%");
    expect(fmtPct(0.31, 1)).toBe("31.0%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(Number.NaN)).toBe("—");
  });

  it("fmtAgo", () => {
    const now = Date.parse("2026-09-26T14:30:00.000Z");
    expect(fmtAgo("2026-09-26T14:30:00.000Z", now)).toBe("just now");
    expect(fmtAgo("2026-09-26T14:29:48.000Z", now)).toBe("12s ago");
    expect(fmtAgo("2026-09-26T14:27:00.000Z", now)).toBe("3m ago");
    expect(fmtAgo("2026-09-26T12:30:00.000Z", now)).toBe("2h ago");
    expect(fmtAgo("2026-09-22T14:30:00.000Z", now)).toBe("4d ago");
    expect(fmtAgo(null, now)).toBe("—");
    expect(fmtAgo("garbage", now)).toBe("—");
  });

  it("fmtZ / fmtDuration / fmtMoney", () => {
    expect(fmtZ(3.14)).toBe("+3.1σ");
    expect(fmtZ(-2)).toBe("−2.0σ");
    expect(fmtDuration(38)).toBe("38s");
    expect(fmtDuration(4.25)).toBe("4.3s");
    expect(fmtDuration(185)).toBe("3m 05s");
    expect(fmtMoney(200000)).toBe("$2,000.00");
  });
});

describe("modality helpers", () => {
  it("colors", () => {
    expect(modalityColor("keyboard")).toBe("var(--mod-keyboard)");
    expect(modalityColor("temporal")).toBe("var(--mod-temporal)");
    expect(modalityColor("nope")).toBe("var(--muted-foreground)");
  });

  it("icons", () => {
    expect(modalityIcon("keyboard")).toBe(Keyboard);
    expect(modalityIcon("mouse")).toBe(MousePointer2);
    expect(modalityIcon("scroll")).toBe(ScrollText);
    expect(modalityIcon("workflow")).toBe(AppWindow);
    expect(modalityIcon("temporal")).toBe(Activity);
  });
});

describe("feature lookup", () => {
  it("finds features by spec name and by column", () => {
    expect(featureLabel("kb.dd_p50")).toBe("flight time");
    expect(featureMeta("kb_dd_p50")?.name).toBe("kb.dd_p50");
    expect(featureMeta("tp_peak_hz")?.modality).toBe("temporal");
    expect(featureLabel("unknown.x")).toBe("unknown.x");
  });
});
