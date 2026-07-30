"""Reversible encryption for credentials the app has to replay.

An SMTP password has to be handed to the mail server in the clear, so this
is deliberately *not* the one-way hashing used for user auth passwords —
those can never be recovered, which is the whole point there and useless
here.

Keyed off the existing `jwt_secret` rather than a second env var: it is
already required, already secret, and already rotated as a unit with the
rest of the deployment's trust. SHA-256 over it gives exactly the 32 bytes
Fernet wants, urlsafe-base64'd.

**Rotating `jwt_secret` therefore invalidates every stored mail
credential.** They can't be decrypted with a different key, so the admin
has to re-enter them in Settings → Admin. `decrypt_secret` returns None on
failure rather than raising, so that scenario degrades to "mail falls back
to the env vars" instead of crashing every email send.
"""

import base64
import hashlib
import logging
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings

logger = logging.getLogger(__name__)

_fernet: Optional[Fernet] = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        key = base64.urlsafe_b64encode(hashlib.sha256(settings.jwt_secret.encode()).digest())
        _fernet = Fernet(key)
    return _fernet


def encrypt_secret(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: Optional[str]) -> Optional[str]:
    """Returns None when the value is absent or undecryptable.

    Undecryptable in practice means jwt_secret changed since it was
    written. Callers treat None as "not configured" and fall back to the
    environment, which is a far better failure mode than every outbound
    email raising.
    """
    if not ciphertext:
        return None
    try:
        return _get_fernet().decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError):
        logger.warning(
            "Stored mail credential could not be decrypted — has JWT_SECRET changed? "
            "Falling back to environment configuration; re-enter it in Settings → Admin."
        )
        return None
