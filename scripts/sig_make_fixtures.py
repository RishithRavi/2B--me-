#!/usr/bin/env python3
"""Generate synthetic, seeded class-level fixtures. Never takes personal recordings."""

import argparse
import json
from pathlib import Path
import numpy as np


def events(actor="a", minutes=3, seed=13):
    rng = np.random.default_rng(seed)
    out = []
    slot = 0
    slow = 1 if actor == "a" else 1.65

    def add(t, ev, **kw):
        out.append({"t_ns": int(t * 1e9), "ev": ev, **kw})

    for base in np.arange(0, minutes * 60, 8):
        if int(base) // 8 % 5 == 4:
            continue
        t = base + 0.2
        add(
            t - 0.08,
            "key",
            down=True,
            slot=900000 + slot,
            cls="SHIFT",
            autorepeat=False,
            inj=False,
        )
        for c in [
            "L_LETTER",
            "L_LETTER",
            "R_LETTER",
            "SPACE",
            "R_LETTER",
            "L_LETTER",
            "R_LETTER",
            "BKSP",
            "BKSP",
            "L_LETTER",
            "SPACE",
            "R_LETTER",
        ] * 2:
            t += max(0.035, float(rng.normal(0.12 * slow, 0.018 * slow)))
            slot += 1
            add(t, "key", down=True, slot=slot, cls=c, autorepeat=False, inj=False)
            add(
                t + float(rng.uniform(0.055, 0.105)) * slow,
                "key",
                down=False,
                slot=slot,
                cls=c,
                autorepeat=False,
                inj=False,
            )
        add(
            t + 0.3,
            "key",
            down=False,
            slot=900000 + slot - 24,
            cls="SHIFT",
            autorepeat=False,
            inj=False,
        )
        add(base + 0.3, "chord", kind="tab_new")
        for j in range(6):
            start = base + 4 + j * 0.42
            for k in range(15):
                u = k / 14
                add(
                    start + u * 0.22,
                    "mouse",
                    kind="drag" if j == 2 else "move",
                    x_pt=200 + j * 60 + u * 100,
                    y_pt=300 + 70 * np.sin(u * np.pi * slow),
                    button=0,
                    inj=False,
                )
            click_at = start + (0.38 if j == 5 else 0.24)
            add(
                click_at,
                "mouse",
                kind="down",
                x_pt=300 + j * 60,
                y_pt=300,
                button=0,
                inj=False,
            )
            add(
                click_at + 0.04 * slow,
                "mouse",
                kind="up",
                x_pt=300 + j * 60,
                y_pt=300,
                button=0,
                inj=False,
            )
        for j in range(3):
            for k in range(7):
                add(
                    base + 5 + j * 0.8 + k * 0.03,
                    "scroll",
                    dy=float((8 if k < 5 else -4) * slow + rng.normal()),
                    dx=float(rng.uniform(0, 2)),
                    continuous=True,
                    phase=0,
                    momentum=0,
                )
            add(
                base + 5 + j * 0.8 + 0.24,
                "scroll",
                dy=6.0,
                dx=0.0,
                continuous=True,
                phase=0,
                momentum=1,
            )
    for i, t in enumerate(np.arange(0, minutes * 60, 15)):
        add(
            t,
            "app",
            cat=(
                ["ide", "browser", "terminal"]
                if actor == "a"
                else ["chat", "media", "browser"]
            )[i % 3],
            via="cmdtab" if i % 2 else "click",
        )
        add(t + 0.1, "window")
    header = {
        "ev": "header",
        "schema_version": 1,
        "synthetic": True,
        "display": {"w_pt": 1512, "h_pt": 982, "hz": 120},
        "pointer": "trackpad",
        "label": "genuine" if actor == "a" else "impostor",
        "actor": actor,
    }
    return [header] + sorted(out, key=lambda e: e["t_ns"])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--minutes", type=float, default=3)
    p.add_argument("--test-contracts", action="store_true")
    args = p.parse_args()
    if args.test_contracts:
        from sig_test_contracts import install, spec

        install()
        s = spec()
    else:
        import yaml

        s = yaml.safe_load(Path("contracts/feature_spec.yaml").read_text())
    from twobme_features import features_from_events

    for name, actor in [("genuine_A", "a"), ("impostor_B", "b")]:
        ev = events(actor, args.minutes)
        Path(f"contracts/fixtures/events/{name}.jsonl").write_text(
            "".join(json.dumps(e) + "\n" for e in ev)
        )
        ticks = [
            {
                "t_ns": t,
                "blocks": [b.model_dump(mode="json") for b in bb],
                "context": c.model_dump(mode="json") if c else None,
            }
            for t, bb, c in features_from_events(ev, s)
        ]
        Path(f"contracts/fixtures/expected/{name}.json").write_text(
            json.dumps({"synthetic": True, "ticks": ticks}, indent=2) + "\n"
        )


if __name__ == "__main__":
    main()
