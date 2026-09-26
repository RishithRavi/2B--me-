"""Write the hand-written contract examples (§6 A0): one block per modality, one full tick,
and sample report files. Values are plausible, hand-picked numbers — not measurements.

    uv run python scripts/core_make_contract_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path

from twobme_common import types as T
from twobme_common.spec import load_spec

ROOT = Path(__file__).resolve().parents[1]
TICKS = ROOT / "contracts" / "fixtures" / "ticks"
REPORTS = ROOT / "contracts" / "fixtures" / "reports"

RUN_ID = "7d3f5a8e-2c41-4b8e-9d61-0f5b1a7c9e21"
SESSION_ID = "c1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f607"

KEYBOARD = {
    "kb.hold_p50": 96.0, "kb.hold_iqr": 28.0, "kb.hold_p50_L": 92.0, "kb.hold_p50_R": 99.0,
    "kb.hold_p50_space": 104.0, "kb.dd_p50": 148.0, "kb.dd_iqr": 71.0, "kb.ud_p50": 52.0,
    "kb.ud_iqr": 64.0, "kb.rollover_frac": 0.21, "kb.dd_p50_same_hand": 163.0,
    "kb.dd_p50_cross_hand": 131.0, "kb.dd_p50_letter_space": 139.0, "kb.dd_p50_space_letter": 171.0,
    "kb.tri_p50": 301.0, "kb.tri_iqr": 96.0, "kb.speed_kps": 6.4, "kb.burst_len_mean": 9.5,
    "kb.pause_rate": 0.05, "kb.bksp_rate": 0.05, "kb.bksp_run_mean": 1.0,
    "kb.pre_bksp_dd_p50": 212.0, "kb.post_bksp_dd_p50": 187.0, "kb.shift_lead_p50": 78.0,
    "kb.chord_rate": 0.0,
}
MOUSE = {
    "ms.v_p50": 0.42, "ms.v_p90": 1.31, "ms.a_p50": 5.8, "ms.jerk_p50": 142.0, "ms.curv_p50": 2.9,
    "ms.angvel_p50": 3.4, "ms.straightness_p50": 0.87, "ms.path_p50": 0.19, "ms.dur_p50": 468.0,
    "ms.t_peak_frac_p50": 0.38, "ms.submoves_p50": 2.0, "ms.click_hold_p50": 88.0,
    "ms.pre_click_pause_p50": 164.0, "ms.dblclick_p50": None, "ms.frac_pc": 0.6, "ms.frac_dd": 0.0,
    "ms.dir_entropy": 2.41, "ms.dwell_rate": 0.9, "ms.dwell_p50": 240.0,
}
SCROLL = {
    "sc.burst_dur_p50": 410.0, "sc.burst_events_p50": 18.0, "sc.burst_dist_p50": 620.0,
    "sc.v_peak_p50": 3900.0, "sc.v_mean_p50": 1480.0, "sc.iei_cv_p50": 0.62,
    "sc.inter_burst_p50": 1350.0, "sc.reversal_rate": 0.33, "sc.momentum_frac": 0.41,
    "sc.horizontal_frac": 0.02,
}
WORKFLOW = {
    "wf.switch_rate": 3.0, "wf.switch_latency_p50": 820.0, "wf.kbd_switch_frac": 0.67,
    "wf.win_change_rate": 1.0, "wf.tab_chord_rate": 2.0, "wf.k2m_p50": 610.0, "wf.m2k_p50": 540.0,
    "wf.app_dwell_p50": 14500.0, "wf.markov_ll": None,
}
TEMPORAL = {
    "tp.rate": 11.2, "tp.B": 0.31, "tp.Bn": 0.33, "tp.M": 0.12, "tp.idle_frac": 0.18,
    "tp.idle_p50": 2600.0, "tp.idle_p90": 4800.0, "tp.bp_0_05": 0.34, "tp.bp_05_2": 0.27,
    "tp.bp_2_5": 0.21, "tp.bp_5_10": 0.12, "tp.bp_10_25": 0.06, "tp.spec_entropy": 4.1,
    "tp.peak_hz": 6.3, "tp.centroid_hz": 4.7, "tp.acf_peak_lag": 160.0, "tp.acf_peak": 0.22,
}
PSD = [round(-2.0 - 0.09 * i + (0.8 if 7 <= i <= 9 else 0.0), 3) for i in range(32)]


def block(modality: str, features: dict, t_start: str, t_end: str, n: int, **extra) -> dict:
    spec = load_spec()
    spec.check_features(modality, features)
    b = T.Block(modality=modality, t_start=t_start, t_end=t_end, n=n, features=features, **extra)
    return json.loads(b.model_dump_json(exclude_none=False))


def main() -> None:
    TICKS.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    blocks = {
        "keyboard": block("keyboard", KEYBOARD, "2026-09-26T14:30:01.214Z", "2026-09-26T14:30:04.391Z", 20),
        "mouse": block("mouse", MOUSE, "2026-09-26T14:29:58.020Z", "2026-09-26T14:30:04.870Z", 5),
        "scroll": block("scroll", SCROLL, "2026-09-26T14:29:41.500Z", "2026-09-26T14:30:02.115Z", 3),
        "workflow": block(
            "workflow", WORKFLOW, "2026-09-26T14:29:05.000Z", "2026-09-26T14:30:05.000Z", 3,
            transitions={"ide>browser": 2, "browser>ide": 1},
        ),
        "temporal": block(
            "temporal", TEMPORAL, "2026-09-26T14:29:35.000Z", "2026-09-26T14:30:05.000Z", 336, psd=PSD,
        ),
    }
    for m, b in blocks.items():
        (TICKS / f"block_{m}.json").write_text(json.dumps(b, indent=2) + "\n")

    tick = T.Tick(
        run_id=RUN_ID, session_id=SESSION_ID, seq=812, t_end="2026-09-26T14:30:05.000Z",
        flags=T.TickFlags(secure_input=False, injected=0, pointer="trackpad", late=False, idle_s=0.0),
        counts=T.TickCounts(keys=24, mouse_moves=410, clicks=2, scroll_events=0, app_switches=0),
        activity=[5, 7, 3, 0, 4],
        blocks=[T.Block.model_validate(blocks["keyboard"]), T.Block.model_validate(blocks["mouse"])],
        context=T.Block.model_validate(blocks["temporal"]),
    )
    (TICKS / "tick_example.json").write_text(json.dumps(json.loads(tick.model_dump_json()), indent=2) + "\n")

    hello = T.Hello(
        device_token="dt_example_not_a_real_token", run_id=RUN_ID, requested_mode="monitor",
        agent_version="0.1.0", schema_version=1, os="macOS 26.4", pointer="trackpad",
        display=T.Display(w_pt=1512, h_pt=982, hz=120),
    )
    (TICKS / "hello_example.json").write_text(json.dumps(json.loads(hello.model_dump_json()), indent=2) + "\n")

    write_reports()
    print(f"wrote {TICKS} and {REPORTS}")


def write_reports() -> None:
    mods = ["keyboard", "mouse", "scroll", "workflow", "temporal"]
    sample = {
        "keyboard": (0.91, 0.16), "mouse": (0.84, 0.23), "scroll": (0.71, 0.34),
        "workflow": (0.64, 0.39), "temporal": (0.69, 0.36),
    }
    ev = T.EvalReport(
        generated_at="2026-09-26T18:40:00.000Z",
        n_blocks={"a": {m: 400 for m in mods}, "b": {m: 60 for m in mods}},
        modalities={
            m: T.EvalModality(
                auc=a, eer=e, roc=[(0.0, 0.0), (e, 1 - e), (1.0, 1.0)], n_genuine=120, n_impostor=60,
                beta=6.0, weak=m in ("workflow",),
            )
            for m, (a, e) in sample.items()
        },
        fused=T.EvalFused(auc=0.96, eer=0.09),
        ablation=[T.EvalAblation(removed=m, fused_eer=0.09 + d) for m, d in zip(mods, [0.05, 0.03, 0.01, 0.0, 0.005])],
        identification=T.EvalIdentification(labels=["a", "b"], confusion=[[112, 8], [9, 51]], accuracy=0.906),
        live_trials=[
            T.EvalLiveTrial(t_start=f"2026-09-26T14:{10 + 5 * i:02d}:00.000Z", ttd_s=s, detected=True)
            for i, s in enumerate([38.0, 52.0, 41.0, 60.0, 47.0])
        ],
        splice=None,
        notes=["SAMPLE FIXTURE — not real results", "Impostor data from teammates only."],
    )
    rt = T.RedteamReport(
        generated_at="2026-09-26T18:40:00.000Z", delivery="acoustic",
        thresholds={"T_ASV_HIGH": 0.6, "T_ASV_LOW": 0.35, "T_CM": 0.5, "T_SPEC": 0.8},
        genuine=T.RedteamCount(n=20, frr=0.05), impostor=T.RedteamCount(n=20, far=0.0),
        attacks=[
            T.RedteamAttack(attack_class="tts_flash", generator="eleven_flash_v2_5", n=20,
                            far_asv_only=0.55, far_cm_only=0.05, far_fused=0.0, mean_asv_cos=0.58),
            T.RedteamAttack(attack_class="replay", generator="phone_speaker", n=20,
                            far_asv_only=0.8, far_cm_only=0.4, far_fused=0.0, mean_asv_cos=0.66),
        ],
    )
    hs = T.HearsayReport(
        generated_at="2026-09-26T18:40:00.000Z", rules_confirmed=False,
        dev=T.HearsayDev(n=800, min_dcf_a=0.21, min_dcf_b=0.18, eer=0.07),
        detectors=[T.HearsayDetector(name="df_arena_500m", min_dcf_a=0.24, min_dcf_b=0.2)],
        fusion={"method": "mean_rank", "members": ["df_arena_500m"]},
        ablation=[],
    )
    for name, rep in {"eval": ev, "redteam": rt, "hearsay": hs}.items():
        data = json.loads(rep.model_dump_json(by_alias=True))
        (REPORTS / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")


if __name__ == "__main__":
    main()
