import json
import redis
import secrets
from typing import Optional
from ..config import settings

# Redis client
_redis_client: Optional[redis.Redis] = None


def get_redis() -> redis.Redis:
    """Get Redis client singleton."""
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


# Magic code keys
MAGIC_CODE_PREFIX = "magic_code:"
MAGIC_CODE_ATTEMPTS_PREFIX = "magic_code_attempts:"
MAGIC_CODE_EXPIRY_SECONDS = 600  # 10 minutes
MAX_MAGIC_CODE_ATTEMPTS = 5


def generate_magic_code() -> str:
    """Generate a 6-digit magic code."""
    return str(secrets.randbelow(900000) + 100000)


def store_magic_code(email: str, code: str) -> None:
    """Store magic code in Redis with expiry."""
    r = get_redis()
    key = f"{MAGIC_CODE_PREFIX}{email.lower()}"
    r.setex(key, MAGIC_CODE_EXPIRY_SECONDS, code)
    # Reset attempts counter
    attempts_key = f"{MAGIC_CODE_ATTEMPTS_PREFIX}{email.lower()}"
    r.delete(attempts_key)


def verify_magic_code(email: str, code: str) -> tuple[bool, str]:
    """
    Verify magic code from Redis.
    Returns (success, error_message).
    """
    r = get_redis()
    key = f"{MAGIC_CODE_PREFIX}{email.lower()}"
    attempts_key = f"{MAGIC_CODE_ATTEMPTS_PREFIX}{email.lower()}"
    
    # Check attempts
    attempts = r.get(attempts_key)
    if attempts and int(attempts) >= MAX_MAGIC_CODE_ATTEMPTS:
        return False, "Too many attempts. Request a new code."
    
    # Get stored code
    stored_code = r.get(key)
    if not stored_code:
        return False, "Code expired or not found"
    
    if stored_code != code:
        # Increment attempts
        r.incr(attempts_key)
        r.expire(attempts_key, MAGIC_CODE_EXPIRY_SECONDS)
        return False, "Invalid code"
    
    # Success - delete the code
    r.delete(key)
    r.delete(attempts_key)
    return True, ""


# ── Password-reset codes (§197) ──────────────────────────────────────────
#
# Its own pool, for the same reason the 2FA block below has one: a login
# code and a password-reset code for the same address used to share
# `magic_code:{email}`, and `store_magic_code` overwrites unconditionally —
# so requesting one silently destroyed the other, whichever order they came
# in. Since §195 the two are not even governed by the same policy: login
# codes are refused instance-wide once 2FA is required, reset codes are
# deliberately still issued, because they are the recovery path for users
# who never had a password. Two policies sharing one mutable slot is the
# collision §191 already refused to accept between login and 2FA codes.
#
# Copied rather than parameterised, deliberately, exactly as the 2FA block
# below was: the expiry and attempt ceiling happen to match today, and a
# shared constant would mean changing one of these three pools silently
# changed the others.
PASSWORD_RESET_CODE_PREFIX = "password_reset_code:"
PASSWORD_RESET_ATTEMPTS_PREFIX = "password_reset_attempts:"
PASSWORD_RESET_CODE_EXPIRY_SECONDS = 600  # 10 minutes
MAX_PASSWORD_RESET_ATTEMPTS = 5


def generate_password_reset_code() -> str:
    """A 6-digit password-reset code."""
    return str(secrets.randbelow(900000) + 100000)


def store_password_reset_code(email: str, code: str) -> None:
    r = get_redis()
    r.setex(
        f"{PASSWORD_RESET_CODE_PREFIX}{email.lower()}",
        PASSWORD_RESET_CODE_EXPIRY_SECONDS,
        code,
    )
    r.delete(f"{PASSWORD_RESET_ATTEMPTS_PREFIX}{email.lower()}")


def verify_password_reset_code(email: str, code: str) -> tuple[bool, str]:
    """Verify a password-reset code. Returns (success, error_message).

    Consumes the code on success, like both of its twins.
    """
    r = get_redis()
    key = f"{PASSWORD_RESET_CODE_PREFIX}{email.lower()}"
    attempts_key = f"{PASSWORD_RESET_ATTEMPTS_PREFIX}{email.lower()}"

    attempts = r.get(attempts_key)
    if attempts and int(attempts) >= MAX_PASSWORD_RESET_ATTEMPTS:
        return False, "Too many attempts. Request a new code."

    stored_code = r.get(key)
    if not stored_code:
        return False, "Code expired or not found"

    if stored_code != code:
        r.incr(attempts_key)
        r.expire(attempts_key, PASSWORD_RESET_CODE_EXPIRY_SECONDS)
        return False, "Invalid code"

    r.delete(key)
    r.delete(attempts_key)
    return True, ""


# ── Backup-email verification codes (§200) ───────────────────────────────
#
# A FOURTH pool, and for the same reason as the third: these codes prove a
# different thing from the other three, and sharing a slot with any of them
# would let one overwrite or be redeemed for another.
#
# What this one proves is narrow and worth stating: that the address the user
# just typed is a mailbox they can read. It is not a login credential and it
# is not a second factor — redeeming it grants nothing except "this address
# is confirmed". That is why it can afford a longer window than the other
# three: fifteen minutes rather than ten, because a backup address is often a
# personal account on a phone the person has to go and find, and an expired
# code here costs a resend rather than a locked-out session.
#
# Keyed by the CANDIDATE ADDRESS, not by user id: two users may not share a
# backup address today, but the thing being proved is a property of the
# mailbox, and a key that survives the user changing their mind about which
# address to use would let a code minted for one address confirm another.
BACKUP_EMAIL_CODE_PREFIX = "backup_email_code:"
BACKUP_EMAIL_ATTEMPTS_PREFIX = "backup_email_attempts:"
BACKUP_EMAIL_CODE_EXPIRY_SECONDS = 900  # 15 minutes
MAX_BACKUP_EMAIL_ATTEMPTS = 5


def generate_backup_email_code() -> str:
    """A 6-digit backup-address verification code."""
    return str(secrets.randbelow(900000) + 100000)


def store_backup_email_code(email: str, code: str) -> None:
    r = get_redis()
    r.setex(
        f"{BACKUP_EMAIL_CODE_PREFIX}{email.lower()}",
        BACKUP_EMAIL_CODE_EXPIRY_SECONDS,
        code,
    )
    r.delete(f"{BACKUP_EMAIL_ATTEMPTS_PREFIX}{email.lower()}")


def verify_backup_email_code(email: str, code: str) -> tuple[bool, str]:
    """Verify a backup-address code. Returns (success, error_message).

    Single use: consumed on success, exactly like its three twins. A code
    that could be replayed would let one intercepted email confirm the same
    address again after the user had changed it away.
    """
    r = get_redis()
    key = f"{BACKUP_EMAIL_CODE_PREFIX}{email.lower()}"
    attempts_key = f"{BACKUP_EMAIL_ATTEMPTS_PREFIX}{email.lower()}"

    attempts = r.get(attempts_key)
    if attempts and int(attempts) >= MAX_BACKUP_EMAIL_ATTEMPTS:
        return False, "Too many attempts. Request a new code."

    stored_code = r.get(key)
    if not stored_code:
        return False, "Code expired or not found"

    if stored_code != code:
        r.incr(attempts_key)
        r.expire(attempts_key, BACKUP_EMAIL_CODE_EXPIRY_SECONDS)
        return False, "Invalid code"

    r.delete(key)
    r.delete(attempts_key)
    return True, ""


def clear_backup_email_code(email: str) -> None:
    """Drop an outstanding code for an address the user has moved away from.

    Called when a pending backup address is replaced: leaving the old code
    live would mean an email already sent to the abandoned address could
    still be presented, and the verify endpoint checks the address currently
    on the row — so the two would have to agree by luck rather than by
    construction.
    """
    r = get_redis()
    r.delete(f"{BACKUP_EMAIL_CODE_PREFIX}{email.lower()}")
    r.delete(f"{BACKUP_EMAIL_ATTEMPTS_PREFIX}{email.lower()}")


# ── 2FA email fallback (§191) ────────────────────────────────────────────
#
# Deliberately its OWN key prefix, not the magic-code one above. A person
# requesting passwordless login and a person completing 2FA are different
# operations on the same address, and sharing a key would let either
# overwrite the other's pending code — or let one be redeemed for the
# other, which is worse: a magic code is a FULL login, so accepting one as
# a second factor would collapse 2FA back into single-factor.
#
# Same shape, same TTL, same attempt ceiling, copied rather than
# parameterised so neither can be changed for one and silently changed for
# both.
TWOFA_EMAIL_CODE_PREFIX = "2fa_email_code:"
TWOFA_EMAIL_ATTEMPTS_PREFIX = "2fa_email_attempts:"
TWOFA_EMAIL_CODE_EXPIRY_SECONDS = 600  # 10 minutes
MAX_TWOFA_EMAIL_ATTEMPTS = 5


def generate_2fa_email_code() -> str:
    """A 6-digit fallback code."""
    return str(secrets.randbelow(900000) + 100000)


def store_2fa_email_code(email: str, code: str) -> None:
    r = get_redis()
    r.setex(
        f"{TWOFA_EMAIL_CODE_PREFIX}{email.lower()}",
        TWOFA_EMAIL_CODE_EXPIRY_SECONDS,
        code,
    )
    r.delete(f"{TWOFA_EMAIL_ATTEMPTS_PREFIX}{email.lower()}")


def has_live_2fa_email_code(email: str) -> bool:
    """Whether an unexpired 2FA code is already outstanding (§194).

    Used to make login's automatic send idempotent for an email-primary
    user: hitting the login screen twice must not mail two codes, and must
    not invalidate the one already in the person's inbox by replacing it.

    It also bounds the blast radius of the automatic send. An attacker who
    holds someone's password can reach the 2FA gate repeatedly; without this
    that would mail a code per attempt. With it, at most one per TTL window
    however many times the gate is hit.
    """
    return bool(get_redis().get(f"{TWOFA_EMAIL_CODE_PREFIX}{email.lower()}"))


# ── 2FA enrolment staging (§194b) ────────────────────────────────────────
#
# A setup that has not been confirmed must not touch the user row. Writing
# the new secret or method straight onto an ALREADY-ENROLLED user replaced
# their working second factor before the replacement had proved it worked:
# one stray call to /auth/2fa/setup, no confirm, and the owner is locked
# out of an account that is still gated — now on a factor nobody has ever
# used. The half-finished enrolment lives here instead, and only
# confirm-setup promotes it into the database.
#
# Keyed by USER ID, unlike the code keys above, which are keyed by email:
# this is state about one account's enrolment attempt rather than about an
# address, and it must not be orphaned by an email change mid-flight.
#
# The secret is staged in exactly the form the column stores — encrypted.
# Redis is a different trust boundary from Postgres, and that column is
# encrypted precisely so a database dump does not yield working secrets;
# staging the plaintext would hand out through the back door what the front
# door encrypts.
TWOFA_SETUP_PREFIX = "2fa_pending_setup:"
#: Same ten minutes as the emailed code, which for an email enrolment is
#: the binding constraint anyway — a staging window that outlived the code
#: it is waiting for would only offer a confirm that cannot succeed.
TWOFA_SETUP_EXPIRY_SECONDS = 600


def store_pending_2fa_setup(
    user_id: str, method: str, secret_encrypted: Optional[str]
) -> None:
    """Stage an enrolment that has not been confirmed yet (§194b).

    Replaces any previous staged setup for this user: starting enrolment
    again abandons whatever the last attempt offered, and two live
    candidates would mean confirm-setup had to choose between them.
    """
    get_redis().setex(
        f"{TWOFA_SETUP_PREFIX}{user_id}",
        TWOFA_SETUP_EXPIRY_SECONDS,
        json.dumps({"method": method, "secret": secret_encrypted}),
    )


def read_pending_2fa_setup(user_id: str) -> Optional[dict]:
    """The staged enrolment, or None if there is none to confirm.

    A malformed or unrecognised document reads as None rather than raising:
    the caller's answer to "nothing staged" is already the right one —
    start setup again — and a 500 would be a worse way to say it.
    """
    raw = get_redis().get(f"{TWOFA_SETUP_PREFIX}{user_id}")
    if not raw:
        return None
    try:
        doc = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(doc, dict) or doc.get("method") not in ("totp", "email"):
        return None
    return doc


def clear_pending_2fa_setup(user_id: str) -> None:
    """Drop a staged enrolment, once it has been promoted or abandoned."""
    get_redis().delete(f"{TWOFA_SETUP_PREFIX}{user_id}")


def verify_2fa_email_code(email: str, code: str) -> tuple[bool, str]:
    """Verify a 2FA fallback code. Returns (success, error_message).

    Consumes the code on success, like its magic-code twin: a second factor
    that could be replayed would not be one.
    """
    r = get_redis()
    key = f"{TWOFA_EMAIL_CODE_PREFIX}{email.lower()}"
    attempts_key = f"{TWOFA_EMAIL_ATTEMPTS_PREFIX}{email.lower()}"

    attempts = r.get(attempts_key)
    if attempts and int(attempts) >= MAX_TWOFA_EMAIL_ATTEMPTS:
        return False, "Too many attempts. Request a new code."

    stored_code = r.get(key)
    if not stored_code:
        return False, "Code expired or not found"

    if stored_code != code:
        r.incr(attempts_key)
        r.expire(attempts_key, TWOFA_EMAIL_CODE_EXPIRY_SECONDS)
        return False, "Invalid code"

    r.delete(key)
    r.delete(attempts_key)
    return True, ""


def delete_magic_code(email: str) -> None:
    """Delete magic code from Redis."""
    r = get_redis()
    key = f"{MAGIC_CODE_PREFIX}{email.lower()}"
    attempts_key = f"{MAGIC_CODE_ATTEMPTS_PREFIX}{email.lower()}"
    r.delete(key)
    r.delete(attempts_key)


# Invite token keys (also in Redis for faster lookup)
INVITE_TOKEN_PREFIX = "invite_token:"
INVITE_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60  # 7 days


def store_invite_token(token: str, user_id: str) -> None:
    """Store invite token -> user_id mapping in Redis."""
    r = get_redis()
    key = f"{INVITE_TOKEN_PREFIX}{token}"
    r.setex(key, INVITE_TOKEN_EXPIRY_SECONDS, user_id)


def get_user_id_from_invite_token(token: str) -> Optional[str]:
    """Get user_id from invite token."""
    r = get_redis()
    key = f"{INVITE_TOKEN_PREFIX}{token}"
    return r.get(key)


def delete_invite_token(token: str) -> None:
    """Delete invite token from Redis."""
    r = get_redis()
    key = f"{INVITE_TOKEN_PREFIX}{token}"
    r.delete(key)


# ── IP-based rate limiting ────────────────────────────────────────────────────

RATE_LIMIT_PREFIX = "rl:"


def check_rate_limit(
    ip: str,
    action: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[bool, int]:
    """
    Check if an IP has exceeded the rate limit for a given action.
    Returns (allowed, remaining_seconds_until_reset).
    Uses a simple counter with TTL in Redis. Fails open if Redis is unavailable.
    """
    try:
        r = get_redis()
        key = f"{RATE_LIMIT_PREFIX}{action}:{ip}"
        current = r.get(key)

        if current is not None and int(current) >= max_requests:
            ttl = r.ttl(key)
            return False, max(ttl, 1)

        pipe = r.pipeline()
        pipe.incr(key)
        pipe.expire(key, window_seconds, nx=True)
        pipe.execute()
        return True, 0
    except Exception:
        # Fail open — allow the request if Redis is unavailable
        return True, 0


# ── Share link password sessions ──────────────────────────────────────────────

SHARE_SESSION_PREFIX = "share_session:"
SHARE_SESSION_EXPIRY_SECONDS = 3600  # 1 hour


def create_share_session(token: str, session_id: str) -> None:
    """Store a session after successful password verification."""
    r = get_redis()
    key = f"{SHARE_SESSION_PREFIX}{token}:{session_id}"
    r.setex(key, SHARE_SESSION_EXPIRY_SECONDS, "1")


def verify_share_session(token: str, session_id: str) -> bool:
    """Check if a valid password session exists for this share link."""
    r = get_redis()
    key = f"{SHARE_SESSION_PREFIX}{token}:{session_id}"
    return r.exists(key) > 0
