"""TOTP as the MFA fallback (§0.1 item 10, "voice / MFA"). Secrets are Fernet-encrypted at rest.

    uri = enroll(user)            # otpauth:// URI (store encrypted secret on the user)
    ok = verify(user, "123456")   # ±1 step window
"""

from __future__ import annotations

import base64
import hashlib
import logging

import pyotp
from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings
from app.core.registry import User
from app.core.runtime import rt

log = logging.getLogger("twobme.totp")


def _fernet() -> Fernet:
    s = get_settings()
    key = s.totp_enc_key or base64.urlsafe_b64encode(hashlib.sha256(("totp:" + s.session_secret).encode()).digest())
    if isinstance(key, str):
        key = key.encode()
    return Fernet(key)


def enroll(user: User) -> str:
    """§5.3 factor rule: replacing an existing TOTP secret needs a fresh strong factor — a voice/TOTP VERIFY
    on the user's bound device in the last 5 min — or an admin. Otherwise HTTP 409 (via HubError)."""
    if user.totp_secret_enc and user.role != "admin" and not rt().hub.recent_strong_verify(user.id):
        from app.core.hub import HubError

        raise HubError(409, "TOTP is already set up; replacing it needs a voice or TOTP check on your device "
                            "in the last 5 minutes (or an admin)")
    secret = pyotp.random_base32()
    user.totp_secret_enc = _fernet().encrypt(secret.encode()).decode()
    rt().registry.save_user(user)
    return pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name="2bME")


def enrolled(user: User) -> bool:
    return bool(user.totp_secret_enc)


def verify(user: User, code: str) -> bool:
    if not user.totp_secret_enc:
        return False
    try:
        secret = _fernet().decrypt(user.totp_secret_enc.encode()).decode()
    except InvalidToken:
        log.error("TOTP secret for %s cannot be decrypted (key changed?)", user.email)
        return False
    return pyotp.TOTP(secret).verify(code.strip().replace(" ", ""), valid_window=1)
