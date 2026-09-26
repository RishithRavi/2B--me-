import importlib
import io
from datetime import timedelta
from uuid import UUID

import pytest
import soundfile as sf
from app.voice.tests.test_pipeline import tone
from fastapi.testclient import TestClient
from twobme_common.types import utcnow


def wav():
    stream = io.BytesIO()
    sf.write(stream, tone(), 16000, format="WAV", subtype="PCM_16")
    return stream.getvalue()


@pytest.fixture
def client(monkeypatch, tmp_path, pipeline):
    for key, value in {
        "TIGER_DATABASE_URL": "",
        "DATA_DIR": str(tmp_path / "data"),
        "REPORTS_DIR": str(tmp_path / "reports"),
        "COOKIE_SECURE": "false",
        "DEMO_MODE": "true",
        "SEED_PASSWORD_A": "test-pw",
        "VOICE_MODE": "real",
        "ELEVENLABS_MODE": "stub",
        "ELEVENLABS_API_KEY": "",
    }.items():
        monkeypatch.setenv(key, value)
    from app.config import get_settings

    get_settings.cache_clear()
    startup = importlib.import_module("app.voice.startup")
    monkeypatch.setattr(startup, "load_pipeline", lambda *args: pipeline)
    from app.main import create_app

    with TestClient(create_app()) as client:
        assert (
            client.post(
                "/api/auth/login", json={"email": "a@2bme.tech", "password": "test-pw"}
            ).status_code
            == 200
        )
        yield client
    get_settings.cache_clear()


def challenge(client):
    response = client.post("/api/voice/challenges", json={"reason": "sandbox"})
    assert response.status_code == 200, response.text
    return response.json()


def submit(client, ch, **headers):
    return client.post(
        f"/api/voice/challenges/{ch['challenge_id']}/response",
        files={"wav": ("take.wav", wav(), "audio/wav")},
        headers=headers,
    )


def ready(client, ch):
    assert (
        client.post(f"/api/voice/challenges/{ch['challenge_id']}/prompt-ended").status_code == 200
    )


def test_real_enroll_verify_single_use(client, pipeline):
    ticket = client.post("/api/voice/enroll/start").json()
    pipeline.stt.texts = ticket["phrases"].copy()
    files = [("wav", ("take.wav", wav(), "audio/wav")) for _ in range(5)]
    enrollment = client.post(
        "/api/voice/enroll", data={"enroll_id": ticket["enroll_id"]}, files=files
    )
    assert enrollment.status_code == 200, enrollment.text
    assert enrollment.json()["enrolled"]
    assert (
        client.post(
            "/api/voice/enroll", data={"enroll_id": ticket["enroll_id"]}, files=files
        ).status_code
        == 403
    )
    ch = challenge(client)
    pipeline.stt.text = ch["phrase"]
    ready(client, ch)
    result = submit(client, ch)
    assert result.status_code == 200, result.text
    assert result.json()["result"]["decision"] == "VERIFY"
    assert result.json()["result"]["cm_p_spoof"] < 0.001
    assert submit(client, ch).status_code == 409


def test_response_requires_prompt_and_rejects_fake_header(client):
    ch = challenge(client)
    assert submit(client, ch).status_code == 409
    ready(client, ch)
    assert submit(client, ch, **{"X-Fake-Decision": "VERIFY"}).status_code == 400


def test_retry_fresh_phrase_then_mfa(client, pipeline):
    ch = challenge(client)
    first = ch["phrase"]
    pipeline.stt.text = "entirely different words never match"
    for attempt in (1, 2, 3):
        ready(client, ch)
        response = submit(client, ch)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["result"]["decision"] == ("RETRY" if attempt < 3 else "FALLBACK_MFA")
        if attempt < 3:
            assert data["next"]["phrase"] != first
            assert data["next"]["attempt"] == attempt + 1
            first = data["next"]["phrase"]
    assert submit(client, ch).status_code == 409


def test_terminal_challenge_cannot_be_reopened_by_prompt_or_totp(client, pipeline):
    ch = challenge(client)
    pipeline.cm.margin = 8
    ready(client, ch)
    assert submit(client, ch).json()["result"]["decision"] == "BLOCK_SPOOF"
    prefix = f"/api/voice/challenges/{ch['challenge_id']}"
    assert client.get(prefix + "/prompt.mp3").status_code == 409
    assert client.post(prefix + "/prompt-ended").status_code == 409
    assert (
        client.post(
            "/api/voice/totp/verify", json={"challenge_id": ch["challenge_id"], "code": "123456"}
        ).status_code
        == 409
    )


def test_expiry_and_bad_audio(client):
    from app.core.runtime import rt

    ch = challenge(client)
    ready(client, ch)
    prefix = f"/api/voice/challenges/{ch['challenge_id']}"
    assert (
        client.post(
            prefix + "/response", files={"wav": ("x.wav", b"not audio", "audio/wav")}
        ).status_code
        == 422
    )
    rt().repo_voice.challenges[UUID(ch["challenge_id"])]["expires_at"] = utcnow() - timedelta(
        seconds=1
    )
    assert submit(client, ch).status_code == 410


def test_inference_error_cancels_challenge(client, pipeline, monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("private details")

    monkeypatch.setattr(pipeline, "verify", broken)
    ch = challenge(client)
    ready(client, ch)
    result = submit(client, ch)
    assert result.status_code == 503 and "private details" not in result.text
    assert client.get(f"/api/voice/challenges/{ch['challenge_id']}").json()["status"] == "cancelled"


def test_concurrent_response_cannot_score_twice(client, pipeline, monkeypatch):
    import asyncio
    import threading
    from concurrent.futures import ThreadPoolExecutor

    entered, release = threading.Event(), threading.Event()
    original = pipeline.verify

    async def paused(*args, **kwargs):
        entered.set()
        await asyncio.to_thread(release.wait, 5)
        return await original(*args, **kwargs)

    monkeypatch.setattr(pipeline, "verify", paused)
    ch = challenge(client)
    ready(client, ch)
    with ThreadPoolExecutor(1) as pool:
        first = pool.submit(submit, client, ch)
        try:
            assert entered.wait(3)
            assert submit(client, ch).status_code == 409
        finally:
            release.set()
        assert first.result().status_code == 200


def test_cancel_during_inference_never_applies_verification(client, pipeline, monkeypatch):
    from app.core.runtime import rt
    from app.voice.tests.test_pipeline import profile

    original = pipeline.verify
    ch = challenge(client)
    pipeline.stt.text = ch["phrase"]
    uid = rt().repo_voice.challenges[UUID(ch["challenge_id"])]["user_id"]
    rt().repo_voice.profiles[uid] = [profile()]

    async def cancelled(*args, **kwargs):
        result = await original(*args, **kwargs)
        assert result.decision == "VERIFY"
        await rt().issuer.cancel(UUID(ch["challenge_id"]), "operator_reset")
        return result

    monkeypatch.setattr(pipeline, "verify", cancelled)
    ready(client, ch)
    assert submit(client, ch).status_code == 409
    assert client.get(f"/api/voice/challenges/{ch['challenge_id']}").json()["status"] == "cancelled"


def test_prompt_deadline_cannot_be_extended_by_replay(client):
    ch = challenge(client)
    url = f"/api/voice/challenges/{ch['challenge_id']}"
    assert client.get(url + "/prompt.mp3").status_code == 200
    first = client.get(url).json()["expires_at"]
    assert client.get(url + "/prompt.mp3").status_code == 200
    assert client.get(url).json()["expires_at"] == first


def test_startup_failure_leaves_real_routes_unavailable(monkeypatch, tmp_path):
    from app.config import get_settings

    for key, value in {
        "TIGER_DATABASE_URL": "",
        "DATA_DIR": str(tmp_path),
        "REPORTS_DIR": str(tmp_path),
        "VOICE_MODE": "real",
        "DEMO_MODE": "true",
        "COOKIE_SECURE": "false",
        "ELEVENLABS_API_KEY": "",
        "SEED_PASSWORD_A": "test-pw",
    }.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()

    def unavailable(*args):
        raise ValueError("Models are not configured")

    monkeypatch.setattr(importlib.import_module("app.voice.startup"), "load_pipeline", unavailable)
    from app.main import create_app

    with TestClient(create_app()) as c:
        c.post("/api/auth/login", json={"email": "a@2bme.tech", "password": "test-pw"})
        assert c.get("/api/healthz").status_code == 503
        assert c.post("/api/voice/enroll/start").status_code == 503
    get_settings.cache_clear()


def test_real_pipeline_resolves_only_current_checkout_session(client, pipeline):
    from app.core.runtime import rt
    from app.voice.tests.test_pipeline import profile

    # A remote checkout still requires voice; only the requesting cookie can resolve it.
    order = client.post(
        "/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}
    )
    assert order.status_code == 200, order.text
    order = order.json()
    assert order["trans_status"] == "C"
    ch = {"challenge_id": order["challenge_id"]}
    row = rt().repo_voice.challenges[UUID(ch["challenge_id"])]
    rt().repo_voice.profiles[row["user_id"]] = [profile()]
    pipeline.stt.text = row["phrase"]
    ready(client, ch)
    response = submit(client, ch)
    assert response.status_code == 200, response.text
    assert response.json()["result"]["decision"] == "VERIFY"
    assert response.json()["outcome"]["resolved_decisions"] == [
        {"decision_id": order["decision_id"], "decision": "allow", "trans_status": "Y"}
    ]
    assert submit(client, ch).status_code == 409


def test_changed_cookie_session_cannot_approve_pending_order(client, pipeline):
    from app.core.runtime import rt
    from app.voice.tests.test_pipeline import profile

    order = client.post(
        "/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}
    ).json()
    ch = {"challenge_id": order["challenge_id"]}
    row = rt().repo_voice.challenges[UUID(ch["challenge_id"])]
    rt().repo_voice.profiles[row["user_id"]] = [profile()]
    pipeline.stt.text = row["phrase"]
    client.post("/api/auth/login", json={"email": "a@2bme.tech", "password": "test-pw"})
    ready(client, ch)
    response = submit(client, ch)
    assert response.status_code == 200, response.text
    assert response.json()["result"]["decision"] == "VERIFY"
    assert response.json()["outcome"]["resolved_decisions"][0]["trans_status"] == "N"
