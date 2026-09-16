"""TOTP secrets, provisioning URIs, and encryption at rest (§191).

Three concerns kept apart on purpose: generating/verifying codes (pyotp),
protecting the secret in the database (Fernet), and the backup codes that
exist for when both factors are gone.

── Where the encryption key comes from ────────────────────────────────────

Derived from `settings.jwt_secret` with HKDF-SHA256 under a fixed info
string, NOT from a new required environment variable.

That is a real tradeoff and it is being made deliberately, so it should be
easy to reverse: adding a required `TOTP_ENCRYPTION_KEY` to `.env.prod`
would give this feature a key of its own, and a self-hosted install that
upgraded without setting it would fail to start — a deployment break for
every operator, to protect a secret that is already only as safe as the
JWT secret sitting beside it in the same file. If `jwt_secret` leaks, an
attacker can already mint access tokens for any account, which is strictly
worse than holding TOTP secrets.

HKDF rather than a hash-and-truncate: the derived key is domain-separated
by `info`, so the Fernet key and the JWT signing key are not the same
bytes and neither can be used to attack the other.

If Mathias would rather have a dedicated key, the change is local to
`_fernet()` — swap the derivation for a settings field and add it to
config.py. Nothing else in this module or its callers would move.

── Rotation, stated because it is not handled ─────────────────────────────

Rotating `jwt_secret` invalidates every stored TOTP secret: they become
undecryptable and those users must re-enrol. This is not automatic and
there is no re-encryption path. A dedicated key would have the same
property. Worth knowing before a secret rotation, not after.
"""

import base64
import secrets
from typing import Optional

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from ..config import settings

#: Domain separation for the derived key. Changing this string makes every
#: stored secret undecryptable, exactly like rotating jwt_secret would.
_HKDF_INFO = b"freeframe-totp-secret-encryption-v1"

#: How many recovery codes are issued, once, at confirmation.
BACKUP_CODE_COUNT = 10

#: Shown to the user as e.g. "A3F9-2K7Q". Crockford-ish: no O/0/I/1, since
#: these get read off a screen and typed, sometimes off a printout.
_BACKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_BACKUP_GROUP = 4


def _fernet() -> Fernet:
    """A Fernet built from the derived key. Cheap; not cached deliberately —
    `settings` is read at call time everywhere else in this codebase too."""
    derived = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=_HKDF_INFO,
    ).derive(settings.jwt_secret.encode("utf-8"))
    return Fernet(base64.urlsafe_b64encode(derived))


# ── The secret ──────────────────────────────────────────────────────────────

def generate_totp_secret() -> str:
    """A fresh base32 secret, from pyotp's own generator."""
    return pyotp.random_base32()


def encrypt_secret(secret: str) -> str:
    """The form that goes in the database."""
    return _fernet().encrypt(secret.encode("utf-8")).decode("utf-8")


def decrypt_secret(encrypted: Optional[str]) -> Optional[str]:
    """Plaintext secret, or None if there is nothing to decrypt or the
    ciphertext cannot be read.

    None rather than an exception for an unreadable value: that happens when
    `jwt_secret` has been rotated, and the useful outcome is "this user's
    2FA no longer verifies, they must re-enrol", not a 500 on every login.
    """
    if not encrypted:
        return None
    try:
        return _fernet().decrypt(encrypted.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        return None


# ── Codes ───────────────────────────────────────────────────────────────────

def totp_provisioning_uri(secret: str, email: str, issuer: str = "FreeFrame") -> str:
    """The otpauth:// URI an authenticator app scans.

    `issuer` is what shows up as the account's name in Google
    Authenticator/1Password, so the caller passes the instance's own
    org_name where it has one — a self-hosted install branded as something
    else should not say "FreeFrame" in someone's authenticator.
    """
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer or "FreeFrame")


def qr_code_data_uri(provisioning_uri: str) -> str:
    """The provisioning URI as a PNG `data:` URI.

    Rendered server-side so the browser needs no QR library and, more to the
    point, so the secret never reaches a third-party chart/QR service — the
    usual shortcut for this, and one that hands an outside host a working
    second factor.
    """
    import io

    import qrcode

    img = qrcode.make(provisioning_uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def verify_totp_code(secret: Optional[str], code: str) -> bool:
    """Whether `code` is currently valid for `secret`.

    pyotp's default drift window (±1 step, i.e. ±30s) is kept as-is.
    Widening it buys convenience for a clock nobody has measured and costs
    a proportionally larger window for a replayed code.
    """
    if not secret or not code:
        return False
    try:
        return pyotp.TOTP(secret).verify(code.strip().replace(" ", ""))
    except Exception:
        # A malformed secret should fail the check, not the request.
        return False


# ── Backup codes ────────────────────────────────────────────────────────────

def generate_backup_codes(count: int = BACKUP_CODE_COUNT) -> list[str]:
    """Plaintext recovery codes. Shown once and never again."""
    def one() -> str:
        raw = "".join(secrets.choice(_BACKUP_ALPHABET) for _ in range(_BACKUP_GROUP * 2))
        return f"{raw[:_BACKUP_GROUP]}-{raw[_BACKUP_GROUP:]}"

    return [one() for _ in range(count)]


def normalize_backup_code(code: str) -> str:
    """What the user typed, reduced to what was issued.

    People retype these from a screenshot or a printout, so case and the
    dash are not something to fail them on.
    """
    return code.strip().upper().replace(" ", "").replace("-", "")


def hash_backup_codes(codes: list[str]) -> list[str]:
    """Hashed with the SAME helper that hashes passwords — deliberately not
    a second scheme invented for this."""
    from .auth_service import hash_password

    return [hash_password(normalize_backup_code(c)) for c in codes]


def consume_backup_code(hashed_codes: Optional[list], code: str) -> tuple[bool, list]:
    """Spend one recovery code.

    Returns `(matched, remaining)`. SINGLE USE is the whole point: the
    matching hash is removed from the list that comes back, and the caller
    is responsible for persisting it. A code that verified but stayed in the
    list would be a permanent password.
    """
    from .auth_service import verify_password

    if not hashed_codes:
        return False, list(hashed_codes or [])

    candidate = normalize_backup_code(code)
    if not candidate:
        return False, list(hashed_codes)

    for i, hashed in enumerate(hashed_codes):
        if verify_password(candidate, hashed):
            remaining = list(hashed_codes)
            remaining.pop(i)
            return True, remaining
    return False, list(hashed_codes)
