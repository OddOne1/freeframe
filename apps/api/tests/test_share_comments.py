"""GET /share/{token}/comments — the shape of the answer, on a mocked session.

What this file used to pin was the OLD contract, and §234 deliberately broke
all three parts of it:

  * it patched `validate_share_link`, the validator with no password gate.
    The route now calls `validate_share_link_with_session`, so a
    password-protected link's comments are not listed without a session;
  * it asserted the route called `_build_comment_response`, i.e. answered
    with `CommentResponse` — author object, guest e-mail and all. The share
    routes now build `ShareCommentResponse` (§234 F2);
  * it passed `asset_id` for a folder/project share and expected it to be
    used as given, with nothing checking the asset was inside the link.

What survives unchanged is the part those tests were originally written for:
an ARRAY comes back, for an asset share and for a folder share, and an empty
array when a folder/project link is asked without an asset — the front end
reads `Array.isArray(json) ? json : json.comments`, so the array is a
contract. The scope, password and identity rules have their own files
(test_share_comment_scope.py, test_share_comment_identity.py), which run
against a real schema because that is the only place a row count means
anything.
"""

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch


def _link(asset_id=None, *, password=None):
    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = asset_id
    link.password_hash = password
    link.show_internal_comments = False
    return link


def _answer_once(mock_db, rows):
    """The first `.all()` is the top-level comment query; everything after it
    (replies, annotations, mentions) is empty. One mocked session answers
    every query in the route, so the order is all a mock can express — which
    is exactly why the scope, password and identity rules are tested against
    a real schema instead.
    """
    answers = iter([rows])
    mock_db.all.side_effect = lambda *a, **k: next(answers, [])


def _comment(asset_id, body="Looks good"):
    c = MagicMock()
    c.id = uuid.uuid4()
    c.asset_id = asset_id
    c.parent_id = None
    c.version_id = uuid.uuid4()
    c.timecode_start = None
    c.timecode_end = None
    c.body = body
    c.created_at = datetime.now(timezone.utc)
    c.updated_at = c.created_at
    c.visibility = "public"
    c.author_id = None
    c.guest_author_id = None
    return c


@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_returns_array_for_asset_share(
    mock_validate,
    mock_scope,
    client,
    mock_db,
):
    asset_id = uuid.uuid4()
    mock_validate.return_value = _link(asset_id)
    asset = MagicMock()
    asset.id = asset_id
    mock_scope.return_value = asset
    comment = _comment(asset_id)
    mock_db.order_by.return_value = mock_db
    _answer_once(mock_db, [comment])

    response = client.get("/share/some-token/comments")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert isinstance(payload, list)
    assert [c["body"] for c in payload] == ["Looks good"]
    # The scope check ran, with the link's own asset.
    mock_scope.assert_called_once()
    assert mock_scope.call_args.args[2] == asset_id


@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_returns_array_for_folder_or_project_share_asset(
    mock_validate,
    mock_scope,
    client,
    mock_db,
):
    asset_id = uuid.uuid4()
    mock_validate.return_value = _link(None)
    asset = MagicMock()
    asset.id = asset_id
    mock_scope.return_value = asset
    comment = _comment(asset_id, "Needs one tweak")
    mock_db.order_by.return_value = mock_db
    _answer_once(mock_db, [comment])

    response = client.get(f"/share/some-token/comments?asset_id={asset_id}")

    assert response.status_code == 200, response.text
    assert [c["body"] for c in response.json()] == ["Needs one tweak"]
    # §234 A — the asset the CLIENT named is the one checked against the
    # link's scope, rather than being used as given.
    assert mock_scope.call_args.args[2] == asset_id


@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_returns_empty_array_without_target_asset(
    mock_validate,
    client,
):
    mock_validate.return_value = _link(None)

    response = client.get("/share/some-token/comments")

    assert response.status_code == 200
    assert response.json() == []


@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_the_route_reads_the_share_session(mock_validate, client, mock_db):
    """§234 B — `share_session` is forwarded to the validator, which is the
    whole of the password gate. It reaches the route under the same query
    name every other public share endpoint uses."""
    mock_validate.return_value = _link(None)

    client.get("/share/some-token/comments?share_session=abc123")

    assert mock_validate.call_args.kwargs["share_session"] == "abc123"
