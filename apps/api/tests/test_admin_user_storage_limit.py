"""Per-user storage limit endpoint (CLAUDE.md §19a).

User.storage_limit_bytes has been enforced since task 12 -- it caps what a
user may allocate across the projects they own -- but until this endpoint
existed nothing could write it. Not admin.py's four user routes, not
users.py's PATCH /{user_id}. The only way to change someone's quota was an
UPDATE against the database by hand.

These hit the real route through the real FastAPI stack, with the DB mocked
the way the rest of this suite does it. The point worth pinning down is the
NULL semantics: `null` means UNLIMITED here, matching what
_check_owner_storage_allocation already does with a NULL personal limit and
what the web UI already renders. It does NOT mean "reset to the 200GB
default" -- that 200GB is a column server_default which only applies when a
row is INSERTed. Getting that backwards would silently hand out unlimited
storage to someone an admin meant to put back on the basic plan, which is
exactly the kind of thing nobody notices until the disk is full.
"""
import uuid
from unittest.mock import MagicMock

import pytest

from apps.api.models.user import UserStatus, UserGlobalRole

TWO_HUNDRED_GB = 200 * 1024 ** 3


def _target(limit=TWO_HUNDRED_GB):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.status = UserStatus.active
    u.role = UserGlobalRole.superuser
    u.deleted_at = None
    u.name = "Target User"
    u.email = "target@example.com"
    u.first_name = "Target"
    u.last_name = "User"
    u.avatar_url = None
    u.email_verified = True
    u.invite_token = None
    u.preferences = {}
    u.storage_limit_bytes = limit
    return u


@pytest.fixture
def superadmin(test_user):
    test_user.role = UserGlobalRole.superadmin
    return test_user


def test_sets_a_concrete_limit(client, auth_headers, mock_db, superadmin):
    target = _target()
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.patch(
        f"/admin/users/{target.id}/storage-limit",
        json={"storage_limit_bytes": 500 * 1024 ** 3},
        headers=auth_headers,
    )

    assert resp.status_code == 200, resp.text
    assert target.storage_limit_bytes == 500 * 1024 ** 3
    assert mock_db.commit.called


def test_null_means_unlimited_not_the_200gb_default(
    client, auth_headers, mock_db, superadmin,
):
    """The whole reason this endpoint's contract is worth a test.

    If null were ever quietly turned into the 200GB server_default, there
    would be no way to grant unlimited storage at all -- and an admin
    clearing the field would get the opposite of what the rest of the
    codebase means by NULL.
    """
    target = _target()
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.patch(
        f"/admin/users/{target.id}/storage-limit",
        json={"storage_limit_bytes": None},
        headers=auth_headers,
    )

    assert resp.status_code == 200, resp.text
    assert target.storage_limit_bytes is None
    assert target.storage_limit_bytes != TWO_HUNDRED_GB


def test_zero_is_allowed_and_is_not_confused_with_null(
    client, auth_headers, mock_db, superadmin,
):
    """0 and None are different answers: "no storage at all" versus
    "unlimited". A falsy-check anywhere on this path would collapse them."""
    target = _target()
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.patch(
        f"/admin/users/{target.id}/storage-limit",
        json={"storage_limit_bytes": 0},
        headers=auth_headers,
    )

    assert resp.status_code == 200, resp.text
    assert target.storage_limit_bytes == 0
    assert target.storage_limit_bytes is not None


def test_rejects_a_negative_limit(client, auth_headers, mock_db, superadmin):
    target = _target()
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.patch(
        f"/admin/users/{target.id}/storage-limit",
        json={"storage_limit_bytes": -1},
        headers=auth_headers,
    )

    assert resp.status_code == 400, resp.text
    assert target.storage_limit_bytes == TWO_HUNDRED_GB
    assert not mock_db.commit.called


def test_requires_superadmin(client, auth_headers, mock_db, test_user):
    """test_user is a plain superuser here -- deliberately not promoted."""
    test_user.role = UserGlobalRole.superuser
    target = _target()
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.patch(
        f"/admin/users/{target.id}/storage-limit",
        json={"storage_limit_bytes": 1024},
        headers=auth_headers,
    )

    assert resp.status_code == 403, resp.text
    assert target.storage_limit_bytes == TWO_HUNDRED_GB
    assert not mock_db.commit.called


def test_404_for_an_unknown_or_deleted_user(
    client, auth_headers, mock_db, superadmin,
):
    mock_db.query.return_value.filter.return_value.first.return_value = None

    resp = client.patch(
        f"/admin/users/{uuid.uuid4()}/storage-limit",
        json={"storage_limit_bytes": 1024},
        headers=auth_headers,
    )

    assert resp.status_code == 404, resp.text
    assert not mock_db.commit.called


def test_the_field_is_required_rather_than_defaulting(
    client, auth_headers, mock_db, superadmin,
):
    """An empty body must not be read as "set unlimited". Omitting the field
    and explicitly sending null are different intentions, and only one of
    them should ever wipe a limit."""
    target = _target()
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.patch(
        f"/admin/users/{target.id}/storage-limit",
        json={},
        headers=auth_headers,
    )

    assert resp.status_code == 422, resp.text
    assert target.storage_limit_bytes == TWO_HUNDRED_GB
