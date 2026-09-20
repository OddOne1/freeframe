"""GET /auth/invite/{token} never filled `org_name` (§199).

`InviteInfoResponse` has always declared the field and the endpoint never
set it, so it serialised as null and the invite screen rendered "You've been
invited to" followed by an empty line. The value comes from the same place
/auth/2fa/setup already takes its authenticator issuer from, so a
self-hosted install branded as something else says the same thing in both
places instead of "FreeFrame" in one of them.
"""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from apps.api.models.user import UserStatus

_ORG_NAME = "apps.api.routers.auth.instance_org_name"


def _invited(expires_in_days=7):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "invitee@example.com"
    u.status = UserStatus.pending_invite
    u.deleted_at = None
    u.invite_token = "tok"
    u.invite_token_expires_at = datetime.now(timezone.utc) + timedelta(
        days=expires_in_days
    )
    u.configure_mock(name="Invited Person")
    return u


def test_the_instance_name_is_returned(client, mock_db):
    mock_db.first.return_value = _invited()

    with patch(_ORG_NAME, return_value="Acme Studio"):
        body = client.get("/auth/invite/tok").json()

    assert body["org_name"] == "Acme Studio"


def test_it_comes_from_site_settings_not_a_hardcoded_string(client, mock_db):
    """A rebranded install must not be told it is joining FreeFrame."""
    mock_db.first.return_value = _invited()

    with patch(_ORG_NAME, return_value="Acme Studio") as org:
        client.get("/auth/invite/tok")

    org.assert_called_once()


def test_the_rest_of_the_response_is_unchanged(client, mock_db):
    user = _invited()
    mock_db.first.return_value = user

    with patch(_ORG_NAME, return_value="Acme Studio"):
        body = client.get("/auth/invite/tok").json()

    assert body["email"] == user.email
    assert body["name"] == "Invited Person"


def test_an_expired_invite_is_still_refused_before_any_lookup(client, mock_db):
    user = _invited(expires_in_days=-1)
    mock_db.first.return_value = user

    with patch(_ORG_NAME, return_value="Acme Studio") as org:
        resp = client.get("/auth/invite/tok")

    assert resp.status_code == 400
    org.assert_not_called()


def test_an_unknown_token_is_still_a_404(client, mock_db):
    mock_db.first.return_value = None

    assert client.get("/auth/invite/nope").status_code == 404
