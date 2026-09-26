# twobme_features

`Accumulators(spec, display)` exposes the §5.6 event methods, `poll(now_ns)` and `context(now_ns)`. `features_from_events(events, spec)` yields five-second ticks from class-level local logs. Labels and OS markers do not enter behavioral scoring. Features use canonical spec ordering, missing values are `None`, coordinates normalize to the display diagonal, and only aggregate Blocks leave the accumulator.

The native runtime converts monotonic block times to calibrated UTC exactly once at the transport boundary. Fixtures use a synthetic epoch for deterministic comparisons. `wf.markov_ll` is null at extraction and computed by the fold-local/model-local workflow transition matrix.

Run `scripts/sig_test.py` from the repository root. Synthetic expected fixtures can be regenerated with `scripts/sig_make_fixtures.py`. Tests cover timing perturbations, timeout discard, missing releases, wheel momentum, sample-rate invariance and complete signature coverage.
