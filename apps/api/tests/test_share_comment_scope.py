"""§234 A–C — what a share token reaches, and what it may write.

The two public comment routes validated the TOKEN and then trusted the body.
Four consequences, all reproduced here against a real schema before they are
asserted away:

  * `GET /share/{token}/comments` used `validate_share_link`, not
    `validate_share_link_with_session`, so a PASSWORD-PROTECTED link listed
    its comments to anyone holding the token;
  * for a folder/project link, the caller's `asset_id` was used as given —
    any asset uuid on the instance, including one in another project;
  * `POST /share/{token}/comment` took `body.asset_id or link.asset_id`, so
    a client-supplied id OVERRODE the link's own asset: one commenting link
    could write a comment onto any asset;
  * `parent_id` and `version_id` went straight into the row.

And what became of §234 F1's option: §234b removed it. Internal comments
NEVER reach a share link — see `TestInternalComments` below and
test_share_internal_comments_removed.py — and a guest can never write one.

Refusals are asserted two ways on purpose — the status code, and that NO
row and NO notification appeared. A 400 over a committed row would look
identical from the client's side, and that is the mistake this file exists
to catch.

See tests/share_world_234.py for the fixture and how to run this.
"""

import uuid

import pytest
from unittest.mock import MagicMock, patch

from .share_world_234 import (
    LINK_PASSWORD,
    auth_header,
    build_world,
    guest_fields,
    open_password_session,
    realdb,
    realredis,
    teardown_world,
    PG_URL,
)

pytestmark = realdb


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def world(sessionmaker_):
    session = sessionmaker_()
    bag = build_world(session)
    try:
        yield bag
    finally:
        teardown_world(bag)


@pytest.fixture
def client(world):
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=MagicMock()
    ), patch(
        # The share-token limiter is §234 C and has its own file; these
        # tests post far more than 30 comments between them and are not
        # about it.
        "apps.api.middleware.rate_limit.check_rate_limit",
        return_value=(True, 0),
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


def comment_count(session, asset_id=None):
    from sqlalchemy import func

    from apps.api.models.comment import Comment

    q = session.query(func.count(Comment.id))
    if asset_id is not None:
        q = q.filter(Comment.asset_id == asset_id)
    return q.scalar()


def notification_count(session):
    from sqlalchemy import func

    from apps.api.models.activity import Notification

    return session.query(func.count(Notification.id)).scalar()


def bodies(payload):
    return [c["body"] for c in payload]


# ── A — the listing's scope ──────────────────────────────────────────────────


class TestTheListingStaysInsideTheLink:
    def test_a_single_asset_link_lists_its_own_asset(self, client, world):
        resp = client.get(f"/share/{world['link_asset'].token}/comments")
        assert resp.status_code == 200, resp.text
        assert bodies(resp.json()) == ["the public note"]

    def test_a_single_asset_link_ignores_a_foreign_asset_id(self, client, world):
        """The link's own asset wins — the parameter is not even consulted."""
        resp = client.get(
            f"/share/{world['link_asset'].token}/comments",
            params={"asset_id": str(world["asset_elsewhere"].id)},
        )
        assert resp.status_code == 200, resp.text
        assert bodies(resp.json()) == ["the public note"]

    def test_a_folder_link_lists_an_asset_in_its_subtree(self, client, world):
        resp = client.get(
            f"/share/{world['link_folder'].token}/comments",
            params={"asset_id": str(world["asset_in_a1"].id)},
        )
        assert resp.status_code == 200, resp.text
        assert bodies(resp.json()) == ["inside the folder"]

    @pytest.mark.parametrize(
        "link_key,asset_key",
        [
            # A sibling folder is not in the shared folder.
            ("link_folder", "asset_in_b"),
            # Nor is an asset with no folder at all.
            ("link_folder", "asset_elsewhere"),
            # Another project, through a project link.
            ("link_project", "asset_other_project"),
            # An items link shares a SELECTION, not the project around it.
            ("link_items", "asset_elsewhere"),
            ("link_items", "asset_in_b"),
            # Trashed content, and content under a trashed folder.
            ("link_project", "asset_trashed"),
            ("link_project", "asset_under_trashed_folder"),
        ],
    )
    def test_an_asset_outside_the_link_is_404(self, client, world, link_key, asset_key):
        resp = client.get(
            f"/share/{world[link_key].token}/comments",
            params={"asset_id": str(world[asset_key].id)},
        )
        assert resp.status_code == 404, resp.text
        # The same answer an unknown token gets: no oracle for "that asset
        # exists but is not in this link".
        assert resp.json()["detail"] == "Share link not found"

    def test_an_items_link_lists_its_own_item(self, client, world):
        resp = client.get(
            f"/share/{world['link_items'].token}/comments",
            params={"asset_id": str(world['asset_in_a1'].id)},
        )
        assert resp.status_code == 200, resp.text
        assert bodies(resp.json()) == ["inside the folder"]

    def test_an_unknown_asset_id_is_the_same_404(self, client, world):
        resp = client.get(
            f"/share/{world['link_project'].token}/comments",
            params={"asset_id": str(uuid.uuid4())},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Share link not found"

    def test_an_unknown_token_answers_identically(self, client):
        resp = client.get(f"/share/{uuid.uuid4().hex}/comments")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Share link not found"

    def test_a_folder_project_link_with_no_asset_id_is_an_empty_list(self, client, world):
        resp = client.get(f"/share/{world['link_folder'].token}/comments")
        assert resp.status_code == 200
        assert resp.json() == []


class TestALinkIntoTrashedContentStopsResolving:
    @pytest.mark.parametrize("link_key", ["link_trashed_project", "link_trashed_asset"])
    def test_the_listing_is_404(self, client, world, link_key):
        resp = client.get(f"/share/{world[link_key].token}/comments")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Share link not found"

    def test_and_so_is_posting(self, client, world):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world['link_trashed_asset'].token}/comment",
            json={"body": "hello?", **guest_fields()},
        )
        assert resp.status_code == 404
        session.expire_all()
        assert comment_count(session) == before

    def test_the_link_row_itself_is_untouched(self, client, world):
        """A restore brings the link back — this is a liveness check on the
        content, not a revocation."""
        from apps.api.models.share import ShareLink

        session = world["session"]
        link = world["link_trashed_asset"]
        client.get(f"/share/{link.token}/comments")
        session.expire_all()
        row = session.query(ShareLink).filter(ShareLink.id == link.id).one()
        assert row.deleted_at is None
        assert row.is_enabled is True

        # And it really does come back.
        world["asset_trashed"].deleted_at = None
        session.commit()
        assert client.get(f"/share/{link.token}/comments").status_code == 200


# ── B — the password gate ────────────────────────────────────────────────────


@realredis
class TestThePasswordGate:
    def test_listing_without_a_session_is_refused(self, client, world):
        resp = client.get(f"/share/{world['link_pw'].token}/comments")
        assert resp.status_code == 403
        assert resp.json()["detail"] == "Password required"

    def test_listing_with_a_session_works(self, client, world):
        token = world["link_pw"].token
        session_id = open_password_session(token)
        resp = client.get(
            f"/share/{token}/comments", params={"share_session": session_id}
        )
        assert resp.status_code == 200, resp.text
        assert bodies(resp.json()) == ["the public note"]

    def test_a_session_for_another_link_does_not_open_this_one(self, client, world):
        other = open_password_session(world["link_pw_folder"].token)
        resp = client.get(
            f"/share/{world['link_pw'].token}/comments",
            params={"share_session": other},
        )
        assert resp.status_code == 403

    def test_posting_without_a_session_writes_nothing(self, client, world):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world['link_pw'].token}/comment",
            json={"body": "past the gate?", **guest_fields()},
        )
        assert resp.status_code == 403
        session.expire_all()
        assert comment_count(session) == before

    def test_posting_with_a_session_works(self, client, world):
        token = world["link_pw"].token
        session_id = open_password_session(token)
        resp = client.post(
            f"/share/{token}/comment?share_session={session_id}",
            json={"body": "through the gate", **guest_fields()},
        )
        assert resp.status_code == 201, resp.text

    def test_the_creator_previewing_their_own_link_needs_no_password(
        self, client, world
    ):
        """Unchanged §188 behaviour — and they get the GUEST shape, not the
        authenticated one (§234 F2)."""
        resp = client.get(
            f"/share/{world['link_pw'].token}/comments",
            headers=auth_header(world["owner"]),
        )
        assert resp.status_code == 200, resp.text
        first = resp.json()[0]
        assert set(first) == {
            "id", "parent_id", "version_id", "timecode_start", "timecode_end",
            "body", "created_at", "updated_at", "annotation",
            "author_label", "author_initials", "author_color", "replies",
        }


# ── B — what a post may say ──────────────────────────────────────────────────


class TestPostingStaysInsideTheLink:
    def test_a_guest_can_comment_on_the_linked_asset(self, client, world):
        from apps.api.models.comment import Comment

        session = world["session"]
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={"body": "looks good", **guest_fields()},
        )
        assert resp.status_code == 201, resp.text
        row = session.query(Comment).filter(
            Comment.id == uuid.UUID(resp.json()["id"])
        ).one()
        assert row.asset_id == world["asset_single"].id
        assert row.visibility == "public"

    def test_a_body_asset_id_cannot_redirect_a_single_asset_link(self, client, world):
        """THE hole: `body.asset_id or link.asset_id` let any commenting link
        write onto any asset uuid."""
        from apps.api.models.comment import Comment

        session = world["session"]
        before = comment_count(session, world["asset_elsewhere"].id)
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": "filed against the wrong asset",
                "asset_id": str(world["asset_elsewhere"].id),
                **guest_fields(),
            },
        )
        assert resp.status_code == 201, resp.text
        session.expire_all()
        # Written, but against the LINK's asset — the parameter is ignored.
        assert comment_count(session, world["asset_elsewhere"].id) == before
        row = session.query(Comment).filter(
            Comment.id == uuid.UUID(resp.json()["id"])
        ).one()
        assert row.asset_id == world["asset_single"].id

    @pytest.mark.parametrize(
        "link_key,asset_key",
        [
            ("link_folder", "asset_in_b"),
            ("link_project", "asset_other_project"),
            ("link_items", "asset_elsewhere"),
            ("link_project", "asset_trashed"),
        ],
    )
    def test_a_foreign_asset_on_a_folder_or_project_link_is_404(
        self, client, world, link_key, asset_key
    ):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world[link_key].token}/comment",
            json={
                "body": "not my project",
                "asset_id": str(world[asset_key].id),
                **guest_fields(),
            },
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Share link not found"
        session.expire_all()
        assert comment_count(session) == before

    def test_an_asset_inside_a_folder_link_works(self, client, world):
        resp = client.post(
            f"/share/{world['link_folder'].token}/comment",
            json={
                "body": "inside the subtree",
                "asset_id": str(world["asset_in_a1"].id),
                **guest_fields(),
            },
        )
        assert resp.status_code == 201, resp.text

    def test_a_view_only_link_still_refuses_to_post(self, client, world):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world['link_view_only'].token}/comment",
            json={"body": "may I?", **guest_fields()},
        )
        assert resp.status_code == 403
        session.expire_all()
        assert comment_count(session) == before

    @pytest.mark.parametrize("link_key", ["link_expired", "link_disabled"])
    def test_an_expired_or_disabled_link_writes_nothing(self, client, world, link_key):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world[link_key].token}/comment",
            json={"body": "still open?", **guest_fields()},
        )
        assert resp.status_code in (403, 410)
        session.expire_all()
        assert comment_count(session) == before


class TestTheParentAndTheVersion:
    def test_a_reply_to_a_public_comment_on_this_asset_works(self, client, world):
        from apps.api.models.comment import Comment

        session = world["session"]
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": "replying",
                "parent_id": str(world["public_comment"].id),
                **guest_fields(),
            },
        )
        assert resp.status_code == 201, resp.text
        row = session.query(Comment).filter(
            Comment.id == uuid.UUID(resp.json()["id"])
        ).one()
        assert row.parent_id == world["public_comment"].id
        # The parent's version, not the body's — a reply belongs where what
        # it answers belongs.
        assert row.version_id == world["public_comment"].version_id

    @pytest.mark.parametrize(
        "parent_key", ["elsewhere_comment", "internal_comment", "deleted_comment"]
    )
    def test_a_parent_the_viewer_cannot_see_is_400_and_writes_nothing(
        self, client, world, parent_key
    ):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": "replying to something else",
                "parent_id": str(world[parent_key].id),
                **guest_fields(),
            },
        )
        assert resp.status_code == 400
        # Generic: it does not say which of the three reasons it was.
        assert resp.json()["detail"] == "Invalid comment target"
        session.expire_all()
        assert comment_count(session) == before

    def test_an_unknown_parent_is_400_not_500(self, client, world):
        """It used to go into the row and hit the foreign key."""
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": "replying to nothing",
                "parent_id": str(uuid.uuid4()),
                **guest_fields(),
            },
        )
        assert resp.status_code == 400

    def test_a_version_of_another_asset_is_400_and_writes_nothing(self, client, world):
        session = world["session"]
        before = comment_count(session)
        foreign_version = world["versions"][world["asset_elsewhere"].id]
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": "wrong version",
                "version_id": str(foreign_version.id),
                **guest_fields(),
            },
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid comment target"
        session.expire_all()
        assert comment_count(session) == before

    def test_the_asset_s_own_version_is_accepted(self, client, world):
        own = world["versions"][world["asset_single"].id]
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": "right version",
                "version_id": str(own.id),
                **guest_fields(),
            },
        )
        assert resp.status_code == 201, resp.text


# ── §234b — internal comments are never shown, and never writable here ──────


class TestInternalComments:
    """The option is gone (§234b). Only the absence is left to assert — on
    every kind of link, and whatever the dead column says."""

    @pytest.mark.parametrize(
        "link_key",
        ["link_asset", "link_internal_column_true"],
    )
    def test_they_are_absent_from_an_open_link(self, client, world, link_key):
        resp = client.get(f"/share/{world[link_key].token}/comments")
        assert resp.status_code == 200
        payload = resp.json()
        assert bodies(payload) == ["the public note"]
        # Including inside the thread: the internal REPLY is gone too.
        assert bodies(payload[0]["replies"]) == ["the reply"]
        assert "the internal" not in resp.text

    def test_there_is_no_visibility_field_to_read_at_all(self, client, world):
        """§234b removed it from `ShareCommentResponse`: every comment here
        is public, so the field could only ever say "public"."""
        resp = client.get(f"/share/{world['link_asset'].token}/comments")
        for comment in resp.json():
            assert "visibility" not in comment

    @pytest.mark.parametrize(
        "link_key",
        ["link_asset", "link_internal_column_true"],
    )
    def test_a_guest_cannot_post_an_internal_comment(self, client, world, link_key):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world[link_key].token}/comment",
            json={"body": "sneaking in", "visibility": "internal", **guest_fields()},
        )
        assert resp.status_code == 403
        session.expire_all()
        assert comment_count(session) == before

    def test_a_signed_in_project_editor_can(self, client, world):
        from apps.api.models.comment import Comment

        session = world["session"]
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={"body": "team only", "visibility": "internal"},
            headers=auth_header(world["member"]),
        )
        assert resp.status_code == 201, resp.text
        row = session.query(Comment).filter(
            Comment.id == uuid.UUID(resp.json()["id"])
        ).one()
        assert row.visibility == "internal"
        assert row.author_id == world["member"].id

    def test_a_signed_in_outsider_cannot(self, client, world):
        session = world["session"]
        before = comment_count(session)
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={"body": "not my project", "visibility": "internal"},
            headers=auth_header(world["outsider"]),
        )
        assert resp.status_code == 403
        session.expire_all()
        assert comment_count(session) == before

    def test_an_internal_post_is_refused_not_downgraded(self, client, world):
        """The field used to be dropped, which stored a member's internal
        note as PUBLIC. A guest's attempt must leave no row at all."""
        from apps.api.models.comment import Comment

        session = world["session"]
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={"body": "downgrade me", "visibility": "internal", **guest_fields()},
        )
        assert resp.status_code == 403
        session.expire_all()
        assert not session.query(Comment).filter(
            Comment.body == "downgrade me"
        ).count()

    def test_an_unknown_visibility_is_422(self, client, world):
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={"body": "what am I", "visibility": "secret", **guest_fields()},
        )
        assert resp.status_code == 422


# ── F2 — mentions from a share link reach members only ──────────────────────


class TestMentions:
    def test_a_member_is_mentioned_and_notified(self, client, world):
        from apps.api.models.activity import Mention, Notification
        from apps.api.models.comment import Comment

        session = world["session"]
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": f"@{world['member'].email} have a look",
                **guest_fields(),
            },
        )
        assert resp.status_code == 201, resp.text
        comment_id = uuid.UUID(resp.json()["id"])
        assert session.query(Mention).filter(
            Mention.comment_id == comment_id,
            Mention.mentioned_user_id == world["member"].id,
        ).count() == 1
        assert session.query(Notification).filter(
            Notification.comment_id == comment_id,
            Notification.user_id == world["member"].id,
        ).count() == 1

    def test_a_non_member_is_ignored_in_silence(self, client, world):
        from apps.api.models.activity import Mention, Notification

        session = world["session"]
        notifications_before = notification_count(session)
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": f"@{world['outsider'].email} psst",
                **guest_fields(),
            },
        )
        # No error, and no difference in the response: the comment lands.
        assert resp.status_code == 201, resp.text
        comment_id = uuid.UUID(resp.json()["id"])
        session.expire_all()
        assert session.query(Mention).filter(
            Mention.comment_id == comment_id
        ).count() == 0
        assert notification_count(session) == notifications_before
        assert session.query(Notification).filter(
            Notification.user_id == world["outsider"].id
        ).count() == 0

    def test_an_unknown_address_is_ignored_too(self, client, world):
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={"body": "@nobody@nowhere.test hi", **guest_fields()},
        )
        assert resp.status_code == 201, resp.text


# ── C — the limiter is actually on the route ────────────────────────────────


def test_the_post_route_carries_the_share_token_limiter():
    """Structural: the dependency is what makes §234 C true, and a route
    decorator is easy to drop in a merge."""
    from apps.api.main import app
    from apps.api.middleware.rate_limit import share_comment_rate_limit

    route = [
        r for r in app.routes
        if getattr(r, "path", None) == "/share/{token}/comment"
        and "POST" in getattr(r, "methods", set())
    ][0]
    assert any(
        d.call is share_comment_rate_limit for d in route.dependant.dependencies
    ), "POST /share/{token}/comment lost its share-token rate limit"
