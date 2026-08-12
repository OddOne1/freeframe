"""Deactivation is required before permanent user deletion (CLAUDE.md 17d).

These hit `POST /admin/users/{id}/purge` through the real FastAPI stack and
the real router function, rather than checking that the frontend hides its
button. The button was never the control — until this change the endpoint
had no status check at all, so a client that skipped the UI could
permanently delete a fully active account.

The prompt asked for a live curl against a superadmin session. That needs
credentials this machine doesn't have, so the endpoint is exercised here
instead: same route, same dependency graph, same handler, with the DB
mocked the way the rest of this suite does it.
"""
import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import UserStatus, UserGlobalRole


def _target(status: UserStatus, role: UserGlobalRole = UserGlobalRole.superuser):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.status = status
    u.role = role
    u.deleted_at = None
    u.name = "Target User"
    u.email = "target@example.com"
    return u


@pytest.fixture
def superadmin(test_user):
    """purge_user's first gate is _require_superadmin."""
    test_user.role = UserGlobalRole.superadmin
    return test_user


@pytest.mark.parametrize("status", [
    UserStatus.active,
    UserStatus.pending_invite,
    UserStatus.pending_verification,
])
def test_purge_refuses_a_user_who_is_not_deactivated(
    client, auth_headers, mock_db, superadmin, status,
):
    """Every non-deactivated status needs the same explicit first step —
    not just `active`. A pending invite is still someone's account."""
    target = _target(status)
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.post(f"/admin/users/{target.id}/purge", headers=auth_headers)

    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == (
        "User must be deactivated before they can be permanently deleted"
    )


def test_purge_refuses_before_doing_any_work(client, auth_headers, mock_db, superadmin):
    """The gate must sit ahead of the deletion itself, not alongside it —
    a 400 that has already started unlinking rows would be worse than no
    gate at all."""
    target = _target(UserStatus.active)
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.post(f"/admin/users/{target.id}/purge", headers=auth_headers)

    assert resp.status_code == 400
    mock_db.delete.assert_not_called()
    mock_db.commit.assert_not_called()


def test_purge_proceeds_once_the_user_is_deactivated(client, auth_headers, mock_db, superadmin):
    """The other half: deactivating must actually unblock it, or this is a
    wall rather than a speed bump."""
    target = _target(UserStatus.deactivated)
    mock_db.query.return_value.filter.return_value.first.return_value = target
    # No owned projects to hand over, no rows to walk.
    mock_db.query.return_value.filter.return_value.all.return_value = []

    resp = client.post(f"/admin/users/{target.id}/purge", headers=auth_headers)

    assert resp.status_code != 400, (
        f"deactivated user was still refused: {resp.text}"
    )


def test_the_earlier_gates_still_run_first(client, auth_headers, mock_db, superadmin):
    """Deleting yourself is refused for its own reason, not the new one —
    the new check must not shadow the checks above it."""
    superadmin.status = UserStatus.active
    mock_db.query.return_value.filter.return_value.first.return_value = superadmin

    resp = client.post(f"/admin/users/{superadmin.id}/purge", headers=auth_headers)

    assert resp.status_code == 400
    assert "your own account" in resp.json()["detail"].lower()


def test_a_non_superadmin_is_still_refused_outright(client, auth_headers, mock_db, test_user):
    """403 before the status check is ever reached."""
    test_user.role = UserGlobalRole.superuser
    target = _target(UserStatus.deactivated)
    mock_db.query.return_value.filter.return_value.first.return_value = target

    resp = client.post(f"/admin/users/{target.id}/purge", headers=auth_headers)
    assert resp.status_code == 403


def test_purge_preview_is_deliberately_NOT_gated(client, auth_headers, mock_db, superadmin):
    """Read-only, never mutates — the dialog calls it to show what WOULD be
    removed, so gating it would only stop a superadmin looking before they
    decide to deactivate."""
    target = _target(UserStatus.active)
    mock_db.query.return_value.filter.return_value.first.return_value = target
    mock_db.query.return_value.filter.return_value.all.return_value = []
    mock_db.query.return_value.filter.return_value.count.return_value = 0

    resp = client.get(f"/admin/users/{target.id}/purge-preview", headers=auth_headers)
    assert resp.status_code != 400, resp.text
