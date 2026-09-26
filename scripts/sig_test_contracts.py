"""ISOLATED TEST ONLY: bootstrap the documented DTOs while Claude's CP0 is absent.
Never included on the production PYTHONPATH. Replaced automatically when common exists.
"""

import sys
import types
from datetime import datetime
from pydantic import BaseModel


def install():
    try:
        import twobme_common.types  # noqa: F401 — tests availability, not a production fallback

        return
    except ModuleNotFoundError:
        pass
    common = types.ModuleType("twobme_common")
    dto = types.ModuleType("twobme_common.types")

    class Display(BaseModel):
        w_pt: float
        h_pt: float
        hz: int

    class Block(BaseModel):
        modality: str
        t_start: datetime
        t_end: datetime
        n: int
        features: dict[str, float | None]
        transitions: dict[str, int] | None = None
        psd: list[float] | None = None

    class Deviation(BaseModel):
        feature: str
        z: float

    class BlockScore(BaseModel):
        modality: str
        t_end: datetime
        n: int
        typicality: float | None = None
        llr_direct: float | None = None
        top: list[Deviation] = []

    class ModalityContribution(BaseModel):
        typicality: float | None
        llr: float
        q: float
        w: float
        delta: float
        n_blocks: int

    class TrustState(BaseModel):
        t: float
        logit: float
        delta_logit: float
        confidence: float
        display: int
        level: str
        per_modality: dict[str, ModalityContribution]
        reasons: list[str]

    for cls in [
        Display,
        Block,
        Deviation,
        BlockScore,
        ModalityContribution,
        TrustState,
    ]:
        setattr(dto, cls.__name__, cls)
    sys.modules["twobme_common"] = common
    sys.modules["twobme_common.types"] = dto


def spec():
    # Test specification transcribed from §5.1. Never used as a production ordering fallback.
    parts = {
        "keyboard": "hold_p50 hold_iqr hold_p50_L hold_p50_R hold_p50_space dd_p50 dd_iqr ud_p50 ud_iqr rollover_frac dd_p50_same_hand dd_p50_cross_hand dd_p50_letter_space dd_p50_space_letter tri_p50 tri_iqr speed_kps burst_len_mean pause_rate bksp_rate bksp_run_mean pre_bksp_dd_p50 post_bksp_dd_p50 shift_lead_p50 chord_rate",
        "mouse": "v_p50 v_p90 a_p50 jerk_p50 curv_p50 angvel_p50 straightness_p50 path_p50 dur_p50 t_peak_frac_p50 submoves_p50 click_hold_p50 pre_click_pause_p50 dblclick_p50 frac_pc frac_dd dir_entropy dwell_rate dwell_p50",
        "scroll": "burst_dur_p50 burst_events_p50 burst_dist_p50 v_peak_p50 v_mean_p50 iei_cv_p50 inter_burst_p50 reversal_rate momentum_frac horizontal_frac",
        "workflow": "switch_rate switch_latency_p50 kbd_switch_frac win_change_rate tab_chord_rate k2m_p50 m2k_p50 app_dwell_p50 markov_ll",
        "temporal": "rate B Bn M idle_frac idle_p50 idle_p90 bp_0_05 bp_05_2 bp_2_5 bp_5_10 bp_10_25 spec_entropy peak_hz centroid_hz acf_peak_lag acf_peak",
    }
    return {
        "schema_version": 1,
        "modalities": {
            m: {
                "n_ref": n,
                "features": [{"name": p + "." + s} for s in parts[m].split()],
            }
            for m, p, n in [
                ("keyboard", "kb", 20),
                ("mouse", "ms", 5),
                ("scroll", "sc", 3),
                ("workflow", "wf", 3),
                ("temporal", "tp", 100),
            ]
        },
    }


def trust_config():
    return {
        "cap": 0.995,
        "kappa": 0.5,
        "C": 1.0,
        "D": 1.0,
        "B": 0.5,
        "weights": {
            "keyboard": 1.0,
            "mouse": 1.0,
            "scroll": 0.5,
            "workflow": 0.4,
            "temporal": 0.05,
        },
        "beta": dict.fromkeys(
            ["keyboard", "mouse", "scroll", "workflow", "temporal"], 6
        ),
        "n_ref": {
            "keyboard": 20,
            "mouse": 5,
            "scroll": 3,
            "workflow": 3,
            "temporal": 100,
        },
    }
