# Real-recording training

Run from the repository root with the workspace Python environment and canonical common package installed:

```sh
uv run python scripts/sig_train_recordings.py --output work/my-run --from-logs /absolute/a1.jsonl /absolute/a2.jsonl /absolute/b.jsonl
uv run python scripts/sig_prefix_eval.py --run-dir work/my-run
```

The first command refuses synthetic recordings, preserves actor labels, extracts local features, exports canonical-vector Parquet, saves a chronological 70/30 evaluation model and a separate full-A candidate, and records primary held-out metrics. B never enters A's baseline. The run directory must not already exist. Restrictive permissions apply to generated artifacts. Do not commit its contents.

The second command adds a fixed first-100-block keyboard training prefix with a 60-second exclusion gap before future A test blocks. It never searches cutoffs. This is supplementary development evidence, not the primary global split or a final independent trial. Empty holdout metrics remain null.

`scripts/sig_gap_experiment.py --run-dir work/my-run` trains an additional five-signal artifact at the canonical gates. Workflow's gate is now 13, with an eight-block per-fold minimum. It also reports 60-second mean-score windows for modalities with held-out evidence and purged out-of-fold exploratory metrics. Lowering any gate below the specification still requires `allow_experimental_gate_override`; an accidental lower gate fails closed.

`scripts/sig_gap_compare.py --run-dir work/my-run` measures the detector change on identical rows, splits and folds for the active keyboard, mouse and scroll signals. It compares the original v1 detector with the default v2 detector and writes `gap-compare.json` with per-modality AUC and EER for the held-out split, the purged out-of-fold scores and 60-second windows. Workflow and temporal remain in the wire schema but are not trained, scored or fused. `--synthetic` runs seeded simulated pairs from `scripts/sig_sim_pair.py`; those validate plumbing and relative changes only, never real-person performance. The existing B recording already informed earlier branch choices, so confirm any final claim on a fresh B recording.

`scripts/sig_prepare_demo.py --run-dir work/my-run --output /absolute/local-output --modalities keyboard scroll` packages the selected branches and a chart, validates the primary report schema, and checks loading through the actual core ModelManager with a temporary identity. It does not activate a website. This packaging script documents the current recording experiment's branch choices; reevaluate that rationale before using different recordings. Matplotlib and jsonschema are needed only for packaging.

The runner's explicit `--standalone-pre-cp0` option is retained for isolated pre-contract experiments. Current real deliverables use the canonical contracts, without the DTO shim.

Final validation requires fresh recordings after any B-informed branch selection. Do not report full-A fit scores as held-out accuracy, report the offline binned summary as live TrustEngine performance, or count replay splices as live takeover trials. Activation must target a known enrolled account and a new integer model version through the core. Model artifacts alone do not change the canonical trust configuration.
