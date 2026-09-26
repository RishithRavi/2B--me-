"""Server settings (§5.7). Everything comes from env / .env; nothing secret has a real default."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # site and security
    domain: str = "2bme.tech"
    public_base_url: str = "https://2bme.tech"
    session_secret: str = "dev-insecure-session-secret"
    cookie_secure: bool = True
    demo_mode: bool = True
    admin_token: str = ""
    seed_password_a: str = "a-dev-password"
    seed_password_b: str = "b-dev-password"
    seed_password_admin: str = "admin-dev-password"
    totp_enc_key: str = ""
    continuous_update: bool = True
    training_frozen: bool = False

    # Tiger
    tiger_database_url: str = ""
    db_connect_timeout_s: float = 8.0
    writer_flush_s: float = 1.5
    writer_max_rows: int = 50_000

    # voice
    voice_startup_timeout_s: float = 240.0
    elevenlabs_api_key: str = ""

    # Vultr inference (A5)
    vultr_serverless_inference_api_key: str = ""
    vultr_inference_base_url: str = "https://api.vultrinference.com/v1"
    vultr_inference_model: str = ""

    # paths
    data_dir: str = "data"
    model_dir: str = ""
    reports_dir: str = "reports"
    migrations_dir: str = ""

    # misc
    version: str = "0.1.0"
    decision_tick_wait_s: float = 6.0

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir)

    @property
    def model_path(self) -> Path:
        return Path(self.model_dir) if self.model_dir else self.data_path / "models"

    @property
    def migrations_path(self) -> Path:
        if self.migrations_dir:
            return Path(self.migrations_dir)
        here = Path(__file__).resolve()
        for d in here.parents:
            cand = d / "infra" / "migrations"
            if cand.is_dir():
                return cand
        return Path("infra/migrations")

    def verify_url(self, challenge_id: object) -> str:
        return f"{self.public_base_url.rstrip('/')}/verify?c={challenge_id}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
