"""Case-insensitive email lookup (CLAUDE.md §13a).

`users.email` is a plain case-sensitive unique column, so
`Mathias@yon.studio` and `mathias@yon.studio` were distinct accounts as far
as login was concerned — which is how one person ended up with two,
holding different project grants.

These run against a real engine rather than mocks: the fix is a SQL
expression (`func.lower(...)`), and a MagicMock query would return whatever
it was told to regardless of whether the comparison is case-sensitive.
SQLite's lower() matches Postgres for ASCII, which is all an email local
part needs here.
"""
import uuid

import pytest


@pytest.fixture
def db():
    pytest.importorskip("sqlalchemy")
    from sqlalchemy import create_engine
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.orm import sessionmaker

    @compiles(UUID, "sqlite")
    def _uuid_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _jsonb_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "TEXT"

    from apps.api.database import Base
    import apps.api.models  # noqa: F401

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _user(db, email, deleted=False):
    from apps.api.models.user import User, UserStatus, UserGlobalRole
    from datetime import datetime, timezone

    u = User(
        id=uuid.uuid4(), email=email, first_name="Mathias", last_name="Sonnleitner",
        password_hash="x", status=UserStatus.active, role=UserGlobalRole.superuser,
        email_verified=True,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    db.add(u)
    db.commit()
    return u


@pytest.mark.parametrize("typed", [
    "Mathias@yon.studio",   # exactly as stored
    "mathias@yon.studio",   # all lower — the case that used to miss
    "MATHIAS@YON.STUDIO",
    "MaThIaS@YoN.sTuDiO",
    "  mathias@yon.studio  ",  # pasted with whitespace
])
def test_finds_the_account_whatever_the_casing(db, typed):
    from apps.api.services.auth_service import get_user_by_email

    stored = _user(db, "Mathias@yon.studio")
    found = get_user_by_email(db, typed)
    assert found is not None, f"{typed!r} did not match the stored address"
    assert found.id == stored.id


def test_stored_capitalisation_is_never_rewritten(db):
    """The comparison is normalised, not the data. Lowercasing storage
    would change what people see as their own address."""
    from apps.api.services.auth_service import get_user_by_email

    _user(db, "Mathias@yon.studio")
    get_user_by_email(db, "mathias@yon.studio")
    row = db.query(__import__("apps.api.models.user", fromlist=["User"]).User).first()
    assert row.email == "Mathias@yon.studio"


def test_a_retired_duplicate_is_never_returned(db):
    """Load-bearing after the merge: the retired half of a merged pair
    keeps its lowercase address forever, and matches case-insensitively.
    Without the deleted_at filter this would authenticate someone into the
    dead account."""
    from apps.api.services.auth_service import get_user_by_email

    keeper = _user(db, "Mathias@yon.studio")
    _user(db, "mathias@yon.studio", deleted=True)

    for typed in ("mathias@yon.studio", "Mathias@yon.studio"):
        found = get_user_by_email(db, typed)
        assert found is not None
        assert found.id == keeper.id, "resolved to the retired account"


def test_unknown_address_still_returns_none(db):
    from apps.api.services.auth_service import get_user_by_email

    _user(db, "Mathias@yon.studio")
    assert get_user_by_email(db, "someone.else@example.com") is None


def test_case_sensitive_lookup_would_have_failed(db):
    """Guards the regression directly: the OLD `==` comparison must not
    find the row, or these tests would pass without the fix."""
    from apps.api.models.user import User

    _user(db, "Mathias@yon.studio")
    naive = db.query(User).filter(
        User.email == "mathias@yon.studio", User.deleted_at.is_(None)
    ).first()
    assert naive is None, "case-sensitive lookup matched — the fixture no longer reproduces the bug"
