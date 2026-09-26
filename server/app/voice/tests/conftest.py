import pytest
from app.voice.service import Calibration, Pipeline
from app.voice.tests.test_pipeline import CM, STT, VAD, Speaker
from hearsay.decision import Thresholds


@pytest.fixture
def pipeline():
    p = Pipeline(
        cm=CM(),
        speaker=Speaker(),
        vad=VAD(),
        stt=STT(),
        calibration=Calibration(Thresholds(0.35, 0.6, 0.5, 0.8), 1, 0),
    )
    yield p
    p.close()
