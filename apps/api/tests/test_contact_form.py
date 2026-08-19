"""Settings -> Contact form (CLAUDE.md §47).

Real Postgres, because the 30-day count is a database question -- a mock
session cannot express "rows newer than a cutoff", which is the one piece
of behaviour here that is easy to get subtly wrong.

The router functions are called directly; the mail send is stubbed, since
what is under test is what gets recorded and who is allowed to see it, not
SES.

Skipped unless TEST_DATABASE_URL points at a migrated Postgres:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_contact_form.py
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def db(sessionmaker_):
    from apps.api.models.contact import ContactRequest
    from apps.api.models.email_settings import EmailSettings
    from apps.api.models.user import User

    session = sessionmaker_()
    made = {"users": [], "requests": []}
    try:
        # The settings singleton is shared, so put it back the way it was.
        row = session.query(EmailSettings).first()
        before = row.contact_target_email if row else None
        yield session, made
    finally:
        session.rollback()
        if made["requests"]:
            session.query(ContactRequest).filter(
                ContactRequest.id.in_(made["requests"])
            ).delete(synchronize_session=False)
        if made["users"]:
            session.query(User).filter(User.id.in_(made["users"])).delete(synchronize_session=False)
        row = session.query(EmailSettings).first()
        if row:
            row.contact_target_email = before
        session.commit()
        session.close()


@pytest.fixture(autouse=True)
def stub_mail(monkeypatch):
    """Only the send is stubbed. Everything that decides what is stored, or
    who may read it, runs for real."""
    sent = []
    from apps.api.routers import contact as contact_router

    class FakeMail:
        def send_email(self, to_email, subject, html_body, text_body=None):
            sent.append({"to": to_email, "subject": subject, "html": html_body, "text": text_body})
            return True

    monkeypatch.setattr(contact_router, "email_service", FakeMail())
    return sent


def make_user(session, made, superadmin=False):
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    user = User(
        email=f"{uuid.uuid4().hex[:12]}@ffcontact.com",
        first_name="Case",
        last_name="Tester",
        status=UserStatus.active,
        role=UserGlobalRole.superadmin if superadmin else UserGlobalRole.user,
    )
    session.add(user)
    session.commit()
    made["users"].append(user.id)
    return user


def set_target(session, admin, address):
    from apps.api.routers.contact import update_contact_settings
    from apps.api.schemas.contact import ContactSettingsUpdate
    return update_contact_settings(
        ContactSettingsUpdate(target_email=address), db=session, current_user=admin
    )


# ─── configuration ───────────────────────────────────────────────────────────

def test_submitting_with_no_target_configured_fails_clearly(db, stub_mail):
    session, made = db
    from apps.api.routers.contact import submit_contact_request
    from apps.api.schemas.contact import ContactRequestCreate

    admin = make_user(session, made, superadmin=True)
    set_target(session, admin, "")  # explicitly unconfigured
    user = make_user(session, made)

    with pytest.raises(HTTPException) as exc:
        submit_contact_request(ContactRequestCreate(message="hello"), db=session, current_user=user)
    assert exc.value.status_code == 400
    assert "configured" in exc.value.detail
    # And nothing was sent anywhere.
    assert stub_mail == []


def test_a_regular_user_learns_only_whether_the_form_works(db):
    session, made = db
    from apps.api.routers.contact import get_contact_settings

    admin = make_user(session, made, superadmin=True)
    set_target(session, admin, "support@example.com")
    user = make_user(session, made)

    out = get_contact_settings(db=session, current_user=user)
    assert out.configured is True
    # A support inbox and a submission count are admin data.
    assert out.target_email is None
    assert out.requests_last_30_days is None

    admin_view = get_contact_settings(db=session, current_user=admin)
    assert admin_view.target_email == "support@example.com"
    assert admin_view.requests_last_30_days is not None


def test_only_a_superadmin_can_set_the_target():
    """Asserted on the wiring, deliberately.

    The gate is `Depends(require_admin)`, which FastAPI resolves at request
    time -- calling the function directly, as every other test here does,
    bypasses it entirely and would pass no matter what. So this checks the
    dependency the route actually declares, and says that is what it is
    checking rather than pretending to exercise a 403.
    """
    import inspect
    from apps.api.routers.contact import update_contact_settings, get_contact_settings
    from apps.api.routers.users import require_admin
    from apps.api.middleware.auth import get_current_user

    def dependency_of(fn, name):
        return inspect.signature(fn).parameters[name].default.dependency

    assert dependency_of(update_contact_settings, "current_user") is require_admin
    # Reading is open to any authenticated user; the response itself is what
    # withholds the admin-only fields.
    assert dependency_of(get_contact_settings, "current_user") is get_current_user


# ─── sending ─────────────────────────────────────────────────────────────────

def test_a_submission_goes_to_the_configured_address_and_is_recorded(db, stub_mail):
    session, made = db
    from apps.api.models.contact import ContactRequest
    from apps.api.routers.contact import submit_contact_request
    from apps.api.schemas.contact import ContactRequestCreate

    admin = make_user(session, made, superadmin=True)
    set_target(session, admin, "first@example.com")
    user = make_user(session, made)

    out = submit_contact_request(
        ContactRequestCreate(message="the printer is on fire"), db=session, current_user=user
    )
    made["requests"].append(uuid.UUID(out.id))

    assert stub_mail[-1]["to"] == "first@example.com"
    # The sender's identity comes from the session, and rides along so the
    # recipient can reply.
    assert user.email in stub_mail[-1]["text"]

    row = session.query(ContactRequest).filter(ContactRequest.id == uuid.UUID(out.id)).one()
    assert row.sender_id == user.id
    assert row.sender_email == user.email
    assert row.message == "the printer is on fire"
    # Snapshotted, not looked up later: the configured address can change.
    assert row.target_email == "first@example.com"


def test_changing_the_target_redirects_the_next_submission(db, stub_mail):
    session, made = db
    from apps.api.routers.contact import submit_contact_request
    from apps.api.schemas.contact import ContactRequestCreate

    admin = make_user(session, made, superadmin=True)
    user = make_user(session, made)

    set_target(session, admin, "first@example.com")
    first = submit_contact_request(ContactRequestCreate(message="one"), db=session, current_user=user)
    made["requests"].append(uuid.UUID(first.id))

    set_target(session, admin, "second@example.com")
    second = submit_contact_request(ContactRequestCreate(message="two"), db=session, current_user=user)
    made["requests"].append(uuid.UUID(second.id))

    assert [m["to"] for m in stub_mail] == ["first@example.com", "second@example.com"]
    # The first row still says where it actually went.
    assert first.target_email == "first@example.com"
    assert second.target_email == "second@example.com"


def test_nothing_is_recorded_when_the_send_fails(db, monkeypatch):
    session, made = db
    from apps.api.routers import contact as contact_router
    from apps.api.routers.contact import submit_contact_request
    from apps.api.models.contact import ContactRequest
    from apps.api.schemas.contact import ContactRequestCreate

    admin = make_user(session, made, superadmin=True)
    set_target(session, admin, "support@example.com")
    user = make_user(session, made)

    class FailingMail:
        def send_email(self, **kwargs):
            return False

    monkeypatch.setattr(contact_router, "email_service", FailingMail())
    before = session.query(ContactRequest).count()

    with pytest.raises(HTTPException) as exc:
        submit_contact_request(ContactRequestCreate(message="lost"), db=session, current_user=user)
    assert exc.value.status_code == 502
    # The count is meant to say how much reached the inbox, not how many
    # times a button was pressed.
    assert session.query(ContactRequest).count() == before


def test_an_empty_message_is_refused(db):
    session, made = db
    from apps.api.routers.contact import submit_contact_request
    from apps.api.schemas.contact import ContactRequestCreate

    admin = make_user(session, made, superadmin=True)
    set_target(session, admin, "support@example.com")
    user = make_user(session, made)

    with pytest.raises(HTTPException) as exc:
        submit_contact_request(ContactRequestCreate(message="   "), db=session, current_user=user)
    assert exc.value.status_code == 400


def test_the_html_body_escapes_what_the_sender_typed(db, stub_mail):
    session, made = db
    from apps.api.routers.contact import submit_contact_request
    from apps.api.schemas.contact import ContactRequestCreate

    admin = make_user(session, made, superadmin=True)
    set_target(session, admin, "support@example.com")
    user = make_user(session, made)

    out = submit_contact_request(
        ContactRequestCreate(message="<script>alert(1)</script>"), db=session, current_user=user
    )
    made["requests"].append(uuid.UUID(out.id))

    assert "<script>" not in stub_mail[-1]["html"]
    assert "&lt;script&gt;" in stub_mail[-1]["html"]


# ─── the 30-day window ───────────────────────────────────────────────────────

def test_the_count_excludes_rows_older_than_thirty_days(db):
    session, made = db
    from apps.api.models.contact import ContactRequest
    from apps.api.routers.contact import get_contact_settings

    admin = make_user(session, made, superadmin=True)
    set_target(session, admin, "support@example.com")
    baseline = get_contact_settings(db=session, current_user=admin).requests_last_30_days

    now = datetime.now(timezone.utc)
    recent = ContactRequest(
        sender_id=admin.id, sender_email=admin.email, message="recent",
        target_email="support@example.com", created_at=now - timedelta(days=29),
    )
    stale = ContactRequest(
        sender_id=admin.id, sender_email=admin.email, message="stale",
        target_email="support@example.com", created_at=now - timedelta(days=31),
    )
    session.add_all([recent, stale])
    session.commit()
    made["requests"].extend([recent.id, stale.id])

    after = get_contact_settings(db=session, current_user=admin).requests_last_30_days
    # Exactly one of the two counts.
    assert after == baseline + 1
