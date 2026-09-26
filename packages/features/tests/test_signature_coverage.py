import numpy as np
from sig_test_contracts import spec
from sig_make_fixtures import events
from twobme_features import features_from_events


def test_signature_coverage():
    values = {}
    transitions = {}
    for _, bb, c in features_from_events(events(), spec()):
        for b in bb + ([c] if c else []):
            for k, v in b.features.items():
                if v is not None:
                    values[k] = v
            transitions.update(b.transitions or {})
    required = [
        f["name"]
        for m in spec()["modalities"].values()
        for f in m["features"]
        if f["name"] != "wf.markov_ll"
    ]
    assert not set(required) - set(values)
    assert transitions
    from twobme_ml.model import markov_ll, transition_matrix

    assert np.isfinite(
        markov_ll(transitions, transition_matrix([{"transitions": transitions}]))
    )
