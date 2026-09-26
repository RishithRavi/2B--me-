# twobme_ml

Exports `UserModel` and `TrustEngine` with §5.6 signatures. The CLI supports train/eval from class-level logs, parquet, or Tiger rows. See `agent/README.md` and `agent/INTEGRATION.md` for commands, data provenance, configuration shape and integration ownership.

The ensemble uses a modality's total eligible training count to choose its family consistently across OOF folds and deployment, and each member is fit only on that fold's training rows. Raw and ensemble OOF reference arrays are saved. Chronological folds are purged by actual block start/end plus 60 seconds. Evaluation uses a separate chronological 30% holdout with an additional 60-second boundary purge. No class label or takeover marker is a scoring feature.

Low-confidence behavior is not a block decision. The numerical engine only emits a confidence band; the hub owns authorization, sticky locks, challenge arming and approved anchors. Manual update candidates are quarantined and checked against untouched A/B holdouts before a new version can be returned.
