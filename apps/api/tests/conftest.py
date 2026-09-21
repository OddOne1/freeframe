"""
Test configuration for FreeFrame API.

Uses a mock-based database approach because the models use PostgreSQL-specific
UUID types that are incompatible with SQLite. All DB interactions are mocked
so tests can run without a live database or S3.
"""
import os
import sys
import uuid
import pytest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

# Set required environment variables BEFORE importing the app modules.
# This must happen before any import of apps.api.config or apps.api.main.
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/freeframe_test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("S3_BUCKET", "freeframe-test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")
os.environ.setdefault("S3_ACCESS_KEY", "testkey")
os.environ.setdefault("S3_SECRET_KEY", "testsecret")
os.environ.setdefault("S3_REGION", "us-east-1")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-key-for-tests-only")
os.environ.setdefault("FRONTEND_URL", "http://localhost:3000")


_FAKE_HASH = "$2b$12$fakehashfortestsonlythisisnotrealatall000000000000000"


def _make_user(
    user_id: uuid.UUID | None = None,
    email: str = "test@example.com",
    name: str = "Test User",
    password: str = "testpassword123",
) -> MagicMock:
    """Create a mock User object.

    We use a fake password hash so this function works even when the local
    bcrypt installation is incompatible with passlib.
    """
    from apps.api.models.user import UserStatus, UserGlobalRole

    u = MagicMock()
    u.id = user_id or uuid.uuid4()
    u.email = email
    u.name = name
    # Store a fake hash — tests that need verify() must mock it themselves.
    u.password_hash = _FAKE_HASH
    u.status = UserStatus.active
    u.avatar_url = None
    u.created_at = datetime.now(timezone.utc)
    u.deleted_at = None
    # Matches pre-task-11 is_superadmin=False semantics (unrestricted
    # except admin-only endpoints) -- 'user' is the new, more restrictive
    # bottom tier that only applies to brand-new accounts going forward,
    # not what existing non-admin test fixtures should default to.
    u.role = UserGlobalRole.superuser
    u.storage_limit_bytes = 200 * 1024 ** 3
    u.email_verified = False
    u.preferences = {}
    # §191 — same reason as test_auth's own stub: every MagicMock attribute
    # is truthy, so leaving these unset routes any login through this
    # fixture into the 2FA branch.
    u.two_factor_enabled = False
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    # §194 — explicit for the same reason as the fields above: a MagicMock
    # attribute is a truthy object, and this one is now validated against
    # Literal["totp", "email"], so leaving it unset fails serialisation.
    u.two_factor_method = None
    # And `require_2fa`, which is not a User field at all: this suite's
    # mock_db returns ONE object from every `.first()`, so the site-settings
    # lookup inside /auth/login gets this same stub. Without it that lookup
    # reads a truthy MagicMock and every plain login is forced into 2FA
    # enrolment.
    u.require_2fa = False
    u.invite_token = None
    # §199 — explicit for the same reason as the 2FA fields above: every
    # MagicMock attribute is a truthy object, and get_current_user now
    # compares a token's `tv` claim against this. Left unset, no mock user
    # could ever authenticate.
    u.token_version = 0
    # §200 — explicit for the same reason as every field above it: on a real
    # User these three are a column and two derived properties, and on a
    # MagicMock they are truthy objects. Left unset, `backup_email_state`
    # fails UserResponse's Literal and every /auth/me in the suite 500s.
    #
    # The default is a user who has FINISHED setup, so the gate never blocks
    # a test of something unrelated. The gate's own tests set these
    # deliberately — see test_account_setup_gate.py.
    u.backup_email = "backup@example.org"
    u.backup_email_verified_at = datetime.now(timezone.utc)
    u.account_gate_waived_at = None
    u.must_set_password = False
    u.backup_email_state = "verified"
    u.account_setup_required = False
    u.deleted_at = None
    return u


def _make_mock_db() -> MagicMock:
    """Return a fresh mock Session."""
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.return_value = None
    db.all.return_value = []
    db.add.return_value = None
    db.flush.return_value = None
    db.commit.return_value = None
    db.refresh.return_value = None
    db.close.return_value = None
    return db


@pytest.fixture
def mock_db():
    """Provide a fresh mock DB session for each test."""
    return _make_mock_db()


@pytest.fixture
def client(mock_db):
    """Return a TestClient with mocked DB and S3."""
    with patch("apps.api.services.s3_service.ensure_bucket_exists"):
        with patch("apps.api.services.s3_service.get_s3_client", return_value=MagicMock()):
            from fastapi.testclient import TestClient
            from apps.api.main import app
            from apps.api.database import get_db

            app.dependency_overrides[get_db] = lambda: mock_db
            client = TestClient(app, raise_server_exceptions=False)
            yield client
            app.dependency_overrides.clear()


@pytest.fixture
def staged_2fa_setup():
    """In-memory stand-in for §194b's Redis enrolment staging.

    A dict rather than a fakeredis: the three functions are the whole
    contract between /auth/2fa/setup and /auth/2fa/confirm-setup, and
    patching them keeps a test's assertions about what was staged readable
    as a dict rather than as a JSON blob under a key prefix.

    Yields the store itself, so a test can assert what setup staged and can
    plant a staged enrolment for a confirm it does not want to run setup
    for. Any test touching either endpoint needs this — without it the real
    functions reach for a Redis that is not there.
    """
    store = {}

    def _store(user_id, method, secret_encrypted):
        store[str(user_id)] = {"method": method, "secret": secret_encrypted}

    def _read(user_id):
        return store.get(str(user_id))

    def _clear(user_id):
        store.pop(str(user_id), None)

    # §204 — `clear_2fa_setup_code` is stubbed alongside the three staging
    # functions, for the same reason they are: confirm-setup now also drops
    # any outstanding ENROLMENT code, and an unstubbed call reaches a Redis
    # that is not there and 500s a confirm that had already committed.
    # Belongs here rather than in each test, exactly like
    # `clear_pending_2fa_setup` one line above it.
    with patch("apps.api.routers.auth.store_pending_2fa_setup", side_effect=_store), \
         patch("apps.api.routers.auth.read_pending_2fa_setup", side_effect=_read), \
         patch("apps.api.routers.auth.clear_pending_2fa_setup", side_effect=_clear), \
         patch("apps.api.routers.auth.clear_2fa_setup_code"):
        yield store


@pytest.fixture
def test_user(mock_db):
    """A mock user for use in auth-dependent tests."""
    return _make_user()


@pytest.fixture
def auth_headers(client, mock_db, test_user):
    """
    Simulate auth by:
    1. Patching get_user_by_email to return None on first call (no existing user)
       then the new user on subsequent calls.
    2. Letting the real hash/verify/JWT logic run.
    3. Returning Bearer headers.
    """
    from apps.api.services.auth_service import create_access_token, create_refresh_token
    # Directly generate a valid token for the test user
    token = create_access_token(str(test_user.id), test_user.token_version)

    # Make get_current_user resolve to test_user
    from apps.api.middleware.auth import get_current_user
    from apps.api.main import app

    app.dependency_overrides[get_current_user] = lambda: test_user
    yield {"Authorization": f"Bearer {token}"}
    # Cleanup: remove get_current_user override but keep get_db override
    app.dependency_overrides.pop(get_current_user, None)
