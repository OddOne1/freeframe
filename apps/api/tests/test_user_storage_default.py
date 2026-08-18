"""Every new account starts at 200GB (CLAUDE.md §37).

Runs against a REAL Postgres, because the thing that failed was a
schema-level `server_default` -- which the mock session the rest of this
suite uses cannot express at all. A MagicMock DB reports whatever the test
asks it to, which is exactly how a real row reached production with
`storage_limit_bytes` NULL while `test_admin_user_storage_limit.py` stayed
green.

The four routers are called for real rather than having their `User(...)`
construction copied here. A copy would keep passing if someone later added
an explicit `storage_limit_bytes=None` to one of the real paths, which is
the regression worth catching.

Skipped unless TEST_DATABASE_URL points at a Postgres with the schema
already migrated:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_user_storage_default.py
"""

import os
import uuid

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; a column "
           "default is not something a mock session can express",
)

TWO_HUNDRED_GB = 200 * 1024 ** 3


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def db(sessionmaker_):
    session = sessionmaker_()
    created: list[uuid.UUID] = []
    try:
        yield session, created
    finally:
        # Named rows only. This database may be someone's scratch copy of a
        # real one; nothing here truncates a table.
        from apps.api.models.user import User
        session.rollback()
        if created:
            session.query(User).filter(User.id.in_(created)).delete(synchronize_session=False)
            session.commit()
        session.close()


def unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}@ffstoragetest.com"


@pytest.fixture(autouse=True)
def stub_side_effects(monkeypatch):
    """Redis and Celery only. Nothing that touches the User row is stubbed."""
    from apps.api.routers import auth as auth_router
    from apps.api.routers import users as users_router
    from apps.api.services import auth_service

    monkeypatch.setattr(auth_router, "store_magic_code", lambda *a, **k: None)
    monkeypatch.setattr(auth_router, "send_task_safe", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(users_router, "send_task_safe", lambda *a, **k: None)
    # bcrypt is slow, and two of the four paths hash a password on the way to
    # the INSERT this test is about.
    monkeypatch.setattr(auth_service, "hash_password", lambda pw: "$2b$12$stub")
    for module in (auth_router, users_router):
        if hasattr(module, "hash_password"):
            monkeypatch.setattr(module, "hash_password", lambda pw: "$2b$12$stub")
    from apps.api.routers import setup as setup_router
    monkeypatch.setattr(setup_router, "hash_password", lambda pw: "$2b$12$stub")


def fetch(session, email):
    from apps.api.models.user import User
    return session.query(User).filter(User.email == email).one()


# ─── the four creation paths ─────────────────────────────────────────────────

def test_magic_code_signup_gets_the_default(db):
    session, created = db
    from apps.api.routers.auth import send_magic_code
    from apps.api.schemas.auth import SendMagicCodeRequest

    email = unique_email("magic")
    send_magic_code(SendMagicCodeRequest(email=email), db=session)

    user = fetch(session, email)
    created.append(user.id)
    assert user.storage_limit_bytes == TWO_HUNDRED_GB


def test_legacy_register_gets_the_default(db):
    session, created = db
    from apps.api.routers.auth import register
    from apps.api.schemas.auth import RegisterRequest

    email = unique_email("register")
    user = register(
        RegisterRequest(email=email, name="Reg Ister", password="testpassword123"),
        db=session,
    )
    created.append(user.id)
    assert fetch(session, email).storage_limit_bytes == TWO_HUNDRED_GB


def test_admin_invite_gets_the_default(db):
    session, created = db
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    from apps.api.routers.users import invite_user
    from apps.api.schemas.auth import InviteRequest

    inviter = User(
        email=unique_email("inviter"),
        last_name="Inviter",
        status=UserStatus.active,
        role=UserGlobalRole.superadmin,
    )
    session.add(inviter)
    session.commit()
    created.append(inviter.id)

    email = unique_email("invited")
    user = invite_user(
        InviteRequest(email=email, name="In Vited"),
        db=session,
        current_user=inviter,
    )
    created.append(user.id)
    assert fetch(session, email).storage_limit_bytes == TWO_HUNDRED_GB


def test_initial_superadmin_setup_gets_the_default(db):
    session, created = db
    from apps.api.routers.setup import create_superadmin, CreateSuperAdminRequest

    email = unique_email("setup")
    create_superadmin(
        CreateSuperAdminRequest(
            email=email,
            first_name="Set",
            last_name="Up",
            password="testpassword123",
        ),
        db=session,
    )
    user = fetch(session, email)
    created.append(user.id)
    assert user.storage_limit_bytes == TWO_HUNDRED_GB


# ─── the default is a default, not a floor ───────────────────────────────────

def test_unlimited_can_still_be_set_deliberately(db):
    """NULL means unlimited and must stay reachable.

    The fix guarantees a value at INSERT; it must not make the column
    effectively NOT NULL, or a superadmin could never grant unlimited storage
    again.
    """
    session, created = db
    from apps.api.models.user import User, UserStatus

    user = User(email=unique_email("unlimited"), last_name="Nolimit", status=UserStatus.active)
    session.add(user)
    session.commit()
    created.append(user.id)
    assert user.storage_limit_bytes == TWO_HUNDRED_GB

    user.storage_limit_bytes = None
    session.commit()
    session.expire_all()
    assert fetch(session, user.email).storage_limit_bytes is None


def test_an_explicit_limit_is_not_overwritten_by_the_default(db):
    session, created = db
    from apps.api.models.user import User, UserStatus

    user = User(
        email=unique_email("explicit"),
        last_name="Explicit",
        status=UserStatus.active,
        storage_limit_bytes=5 * 1024 ** 3,
    )
    session.add(user)
    session.commit()
    created.append(user.id)
    assert fetch(session, user.email).storage_limit_bytes == 5 * 1024 ** 3
