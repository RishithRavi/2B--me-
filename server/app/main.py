"""2bME API (FastAPI, single uvicorn worker — the hub is in-memory by design, §6 A1).

    uv run uvicorn app.main:app --app-dir server --port 8000
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from app.auth import hash_password
from app.config import Settings, get_settings
from app.core.explain import Explainer
from app.core.hub import DeviceHub, HubError
from app.core.live import LiveBus
from app.core.models import ModelManager
from app.core.registry import Registry
from app.core.runtime import Runtime, set_runtime
from app.db.migrate import run_migrations
from app.db.pool import Db
from app.db.repo_voice import RepoVoice
from app.db.writer import Writer
from app.routers import auth, decisions, demo, devices, enroll, history, ws
from twobme_common.config import load_trust_config

log = logging.getLogger("twobme")

SEED_USERS = (
    ("a@2bme.tech", "A", "user", "seed_password_a"),
    ("b@2bme.tech", "B", "user", "seed_password_b"),
    ("admin@2bme.tech", "Observer", "admin", "seed_password_admin"),
)


def _seed(reg: Registry, s: Settings) -> None:
    for email, handle, role, attr in SEED_USERS:
        if reg.user_by_email(email) is None:
            reg.add_user(email, hash_password(getattr(s, attr)), handle, role)


def build_runtime(s: Settings) -> Runtime:
    data = s.data_path
    (data / "state").mkdir(parents=True, exist_ok=True)
    db = Db(s.tiger_database_url, connect_timeout_s=s.db_connect_timeout_s,
            on_first_connect=lambda conn: run_migrations(conn, s.migrations_path))
    writer = Writer(db, max_rows=s.writer_max_rows, flush_s=s.writer_flush_s)
    registry = Registry(data / "state", writer)
    registry.load_mirror()
    _seed(registry, s)
    live = LiveBus()
    models = ModelManager(s.model_path, data, db, writer)
    models.load_all()
    repo_voice = RepoVoice(db, writer, data / "voice_profiles")
    repo_voice.load_mirror()
    from app import voice

    explainer = Explainer(s.vultr_serverless_inference_api_key, s.vultr_inference_base_url, s.vultr_inference_model)
    hub = DeviceHub(settings=s, cfg=load_trust_config(tuned=True), registry=registry, writer=writer, live=live,
                    models=models, repo_voice=repo_voice, issuer_getter=lambda: voice.issuer, explainer=explainer)
    r = Runtime(settings=s, db=db, writer=writer, registry=registry, live=live, models=models, hub=hub,
                issuer=voice.issuer, repo_voice=repo_voice)
    r.extras["explainer_enabled"] = explainer.enabled

    async def _on_db() -> None:
        await registry.load_from_db(db)
        registry.sync_all_to_db()

    db.on_connected.append(_on_db)
    return r


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN201
    s = get_settings()
    r = build_runtime(s)
    set_runtime(r)
    # Tiger: bounded wait so an outage never blocks startup (degraded mode)
    if r.db.configured:
        try:
            await asyncio.wait_for(r.db.connect_once(), s.db_connect_timeout_s + 5)
        except Exception as e:
            log.warning("Tiger not reachable at startup: %s", e)
    r.hub.restore()
    r.db.start()
    r.writer.start()
    r.hub.start()
    from app import voice

    try:
        await asyncio.wait_for(voice.startup(), s.voice_startup_timeout_s)
        r.voice_warm = True
    except Exception as e:
        log.error("voice startup failed/timed out: %s — /healthz stays 503", e)
    log.info("2bME API up (tiger=%s, voice_warm=%s, model_backend=%s)",
             "up" if r.db.up else "down", r.voice_warm, r.models.backend_name)
    try:
        yield
    finally:
        await r.hub.stop()
        await r.writer.stop()
        await r.db.close()
        set_runtime(None)


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = FastAPI(title="2bME API", version=get_settings().version, lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json")
    from app import voice

    for mod in (auth, devices, decisions, enroll, demo, history):
        app.include_router(mod.router, prefix="/api")
    app.include_router(voice.router, prefix="/api")
    app.include_router(ws.router)

    from fastapi.responses import JSONResponse

    @app.exception_handler(HubError)
    async def _hub_error(_req, exc: HubError):  # noqa: ANN001, ANN202
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    return app


app = create_app()


def _data_dir() -> Path:  # used by scripts
    return get_settings().data_path
