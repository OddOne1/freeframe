"""First-superadmin creation (CLAUDE.md §20).

POST /setup/create-superadmin was broken for every fresh install: it passed
`name=` to the User constructor, but User.name is a read-only @property
computed from first_name/last_name since the name-split migration, so
SQLAlchemy's declarative __init__ raised AttributeError and the endpoint
500'd. Independently, last_name (NOT NULL) was never passed at all, so even
a working `name` setter would have failed at commit.

Nothing caught it because an installed system never calls this endpoint
again -- the bug is invisible to every environment except a brand new one,
which is exactly the environment nobody has running.

The DB is mocked here the way the rest of this suite does it, so what these
pin is the request contract and the constructor kwargs. The "does a usable
account actually land in Postgres" half was verified separately against a
real disposable stack; see the commit.
"""
import pytest

from apps.api.models.user import UserGlobalRole, UserStatus


@pytest.fixture
def empty_system(mock_db):
    """No superadmin, and no existing account with this email -- both of
    create_superadmin's guards query through the same mock."""
    mock_db.query.return_value.filter.return_value.first.return_value = None
    return mock_db


def _captured_user(mock_db):
    assert mock_db.add.called, "no User was ever added"
    return mock_db.add.call_args[0][0]


def test_creates_a_superadmin_from_first_and_last_name(client, empty_system):
    resp = client.post("/setup/create-superadmin", json={
        "email": "founder@example.com",
        "first_name": "Ada",
        "last_name": "Lovelace",
        "password": "correct horse battery",
    })

    assert resp.status_code == 201, resp.text
    user = _captured_user(empty_system)
    assert user.first_name == "Ada"
    assert user.last_name == "Lovelace"
    assert user.role == UserGlobalRole.superadmin
    assert user.status == UserStatus.active
    # The regression itself: name is derived, never assigned.
    assert user.name == "Ada Lovelace"


def test_first_name_is_optional(client, empty_system):
    """Mirrors the column: first_name is nullable, last_name is not."""
    resp = client.post("/setup/create-superadmin", json={
        "email": "founder@example.com",
        "last_name": "Lovelace",
        "password": "correct horse battery",
    })

    assert resp.status_code == 201, resp.text
    user = _captured_user(empty_system)
    assert user.first_name is None
    assert user.last_name == "Lovelace"
    assert user.name == "Lovelace"


def test_blank_first_name_is_stored_as_null_not_empty_string(client, empty_system):
    """An empty string would make User.name render with a leading space."""
    resp = client.post("/setup/create-superadmin", json={
        "email": "founder@example.com",
        "first_name": "   ",
        "last_name": "Lovelace",
        "password": "correct horse battery",
    })

    assert resp.status_code == 201, resp.text
    assert _captured_user(empty_system).first_name is None


@pytest.mark.parametrize("last_name", ["", "   ", "\t"])
def test_rejects_a_blank_last_name(client, empty_system, last_name):
    """last_name is NOT NULL. Whitespace satisfies pydantic's `str` and would
    only fail later at commit, which is the second half of the original bug.
    Same rule routers/users.py already enforces on the same column."""
    resp = client.post("/setup/create-superadmin", json={
        "email": "founder@example.com",
        "last_name": last_name,
        "password": "correct horse battery",
    })

    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Last name cannot be empty"
    assert not empty_system.add.called


def test_last_name_is_required_not_defaulted(client, empty_system):
    resp = client.post("/setup/create-superadmin", json={
        "email": "founder@example.com",
        "password": "correct horse battery",
    })

    assert resp.status_code == 422, resp.text
    assert not empty_system.add.called


def test_the_old_single_name_field_is_no_longer_accepted_silently(client, empty_system):
    """A stale client posting {name: "Ada Lovelace"} must fail loudly on the
    missing last_name rather than creating a nameless account."""
    resp = client.post("/setup/create-superadmin", json={
        "email": "founder@example.com",
        "name": "Ada Lovelace",
        "password": "correct horse battery",
    })

    assert resp.status_code == 422, resp.text
    assert not empty_system.add.called
