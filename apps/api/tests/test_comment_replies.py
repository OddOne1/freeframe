"""Replies, authenticated and guest, against a real migrated schema (§209).

§208 made guest comments work and tested them — but only TOP-LEVEL ones.
Replies went untested on both paths, which is how §209's report ("replying
fails for a logged-in user AND for a guest") could arrive with nobody able to
say when it last worked.

The answer, from git history, is that the API was never the problem: the two
front-end call sites passed `onSubmitReply={async () => {}}`, a no-op, from
the commit that introduced them. This file is the other half of that finding —
it pins the server contract the fixed client relies on, so a future regression
lands on one side or the other and not in the gap between them.

Real Postgres, schema built by `alembic upgrade head`. Not `create_all`: a
schema derived from the models cannot disagree with them, which is exactly the
class of defect §208 fixed.

Skipped unless TEST_DATABASE_URL points at a migrated Postgres:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_comment_replies.py
"""

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

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
def world(sessionmaker_):
    """A project with one asset, one ready version, a member, and a
    comment-permitted share link — the smallest world in which both a
    logged-in reply and a guest reply are possible."""
    from apps.api.models.asset import (
        Asset,
        AssetType,
        AssetVersion,
        ProcessingStatus,
    )
    from apps.api.models.activity import ActivityLog, Mention, Notification
    from apps.api.models.comment import Comment
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    from apps.api.models.share import ShareLink, ShareLinkActivity, SharePermission
    from apps.api.models.user import GuestUser, User, UserGlobalRole, UserStatus
    from apps.api.services.auth_service import hash_password

    session = sessionmaker_()
    # §207/§208's own harness lesson: `middleware/setup_guard.py` reads the
    # real database past any dependency override and answers 503 to every
    # request when no superadmin exists.
    if (
        session.query(User)
        .filter(User.role == UserGlobalRole.superadmin, User.deleted_at.is_(None))
        .first()
        is None
    ):
        session.add(
            User(
                email="setup-guard@ff209.test",
                first_name="Setup",
                last_name="Guard",
                status=UserStatus.active,
                role=UserGlobalRole.superadmin,
                email_verified=True,
            )
        )
        session.commit()

    owner = User(
        email=f"{uuid.uuid4().hex[:12]}@ff209.test",
        first_name="Reply",
        last_name="Tester",
        password_hash=hash_password("Tf4#qRn8!vZw"),
        status=UserStatus.active,
        role=UserGlobalRole.user,
        email_verified=True,
        backup_email=f"{uuid.uuid4().hex[:12]}@backup209.test",
        backup_email_verified_at=datetime.now(timezone.utc),
    )
    session.add(owner)
    session.commit()

    project = Project(name=f"P{uuid.uuid4().hex[:8]}", created_by=owner.id)
    session.add(project)
    session.commit()
    member = ProjectMember(
        project_id=project.id, user_id=owner.id, role=ProjectRole.owner
    )
    asset = Asset(
        project_id=project.id,
        name=f"clip-{uuid.uuid4().hex[:6]}.mov",
        asset_type=AssetType.video,
        created_by=owner.id,
    )
    session.add_all([member, asset])
    session.commit()
    version = AssetVersion(
        asset_id=asset.id,
        version_number=1,
        processing_status=ProcessingStatus.ready,
        created_by=owner.id,
    )
    link = ShareLink(
        token=uuid.uuid4().hex,
        asset_id=asset.id,
        created_by=owner.id,
        permission=SharePermission.comment,
        show_comments=True,
    )
    session.add_all([version, link])
    session.commit()

    bag = {
        "session": session,
        "owner": owner,
        "project": project,
        "asset": asset,
        "version": version,
        "link": link,
    }
    try:
        yield bag
    finally:
        session.rollback()
        # Posting a comment also writes activity, notification and mention
        # rows that FK-reference the asset and the comment, so those have to
        # go first — the asset cannot be deleted while they point at it.
        rows = session.query(Comment).filter(Comment.asset_id == asset.id).all()
        comment_ids = [c.id for c in rows]
        # Only the guests THIS asset's comments created. A blanket delete by
        # email pattern would try to remove guests still referenced by another
        # test's comments and fail on the FK.
        guest_ids = {c.guest_author_id for c in rows if c.guest_author_id}
        if comment_ids:
            # Mention is keyed by comment, not by asset.
            session.query(Mention).filter(
                Mention.comment_id.in_(comment_ids)
            ).delete(synchronize_session=False)
        session.query(Notification).filter(
            Notification.asset_id == asset.id
        ).delete(synchronize_session=False)
        session.query(ActivityLog).filter(
            ActivityLog.asset_id == asset.id
        ).delete(synchronize_session=False)
        session.query(Comment).filter(Comment.asset_id == asset.id).delete(
            synchronize_session=False
        )
        session.query(ShareLinkActivity).filter(
            ShareLinkActivity.share_link_id == link.id
        ).delete(synchronize_session=False)
        session.query(ShareLink).filter(ShareLink.id == link.id).delete(
            synchronize_session=False
        )
        session.query(AssetVersion).filter(
            AssetVersion.asset_id == asset.id
        ).delete(synchronize_session=False)
        session.query(Asset).filter(Asset.id == asset.id).delete(
            synchronize_session=False
        )
        session.query(ProjectMember).filter(
            ProjectMember.project_id == project.id
        ).delete(synchronize_session=False)
        session.query(Project).filter(Project.id == project.id).delete(
            synchronize_session=False
        )
        if guest_ids:
            session.query(GuestUser).filter(
                GuestUser.id.in_(guest_ids)
            ).delete(synchronize_session=False)
        session.query(User).filter(User.id == owner.id).delete(
            synchronize_session=False
        )
        session.commit()
        session.close()


@pytest.fixture
def client(world):
    """The real app on the real session, with `get_current_user` left alone so
    a real bearer token has to actually authenticate."""
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=MagicMock()
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


def auth(user):
    from apps.api.services.auth_service import create_access_token

    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"}


def guest_fields(local="guest"):
    return {
        "guest_name": "Guest Reviewer",
        "guest_email": f"{local}-{uuid.uuid4().hex[:6]}@guest209.test",
    }


# ── A(d) — the authenticated reply path ────────────────────────────────────


class TestLoggedInReply:
    def test_a_reply_is_created_and_persisted_under_its_parent(self, client, world):
        from apps.api.models.comment import Comment

        session, owner, asset, version = (
            world["session"],
            world["owner"],
            world["asset"],
            world["version"],
        )

        parent = client.post(
            f"/assets/{asset.id}/comments",
            json={"version_id": str(version.id), "body": "the original note"},
            headers=auth(owner),
        )
        assert parent.status_code == 201, parent.text
        parent_id = parent.json()["id"]

        reply = client.post(
            f"/assets/{asset.id}/comments/{parent_id}/replies",
            json={"version_id": str(version.id), "body": "the reply"},
            headers=auth(owner),
        )
        assert reply.status_code == 201, reply.text
        assert reply.json()["parent_id"] == parent_id

        # Persisted, and parented — a 201 over a rolled-back session would
        # look identical from here.
        row = (
            session.query(Comment)
            .filter(Comment.id == uuid.UUID(reply.json()["id"]))
            .first()
        )
        assert row is not None
        assert str(row.parent_id) == parent_id
        # The endpoint forces the parent's version rather than trusting the
        # body — pinned because the client sends one and it is ignored.
        assert str(row.version_id) == parent.json()["version_id"]

    def test_the_reply_comes_back_nested_in_the_asset_listing(
        self, client, world
    ):
        """Part A item 3's server half: a refetch has to show the reply under
        its parent, or the client would have to assemble the tree itself."""
        owner, asset, version = world["owner"], world["asset"], world["version"]

        parent_id = client.post(
            f"/assets/{asset.id}/comments",
            json={"version_id": str(version.id), "body": "parent for nesting"},
            headers=auth(owner),
        ).json()["id"]
        client.post(
            f"/assets/{asset.id}/comments/{parent_id}/replies",
            json={"version_id": str(version.id), "body": "nested reply"},
            headers=auth(owner),
        )

        listed = client.get(f"/assets/{asset.id}/comments", headers=auth(owner))
        assert listed.status_code == 200, listed.text
        top = [c for c in listed.json() if c["id"] == parent_id]
        assert top, listed.json()
        assert [r["body"] for r in top[0]["replies"]] == ["nested reply"]

    def test_an_unknown_parent_is_404_not_a_silent_top_level_comment(
        self, client, world
    ):
        owner, asset, version = world["owner"], world["asset"], world["version"]
        res = client.post(
            f"/assets/{asset.id}/comments/{uuid.uuid4()}/replies",
            json={"version_id": str(version.id), "body": "orphan"},
            headers=auth(owner),
        )
        assert res.status_code == 404


# ── A(d) — the guest reply path ────────────────────────────────────────────


class TestGuestReply:
    def test_a_guest_can_reply_through_the_share_endpoint(self, client, world):
        from apps.api.models.comment import Comment

        session, link = world["session"], world["link"]

        parent = client.post(
            f"/share/{link.token}/comment",
            json={"body": "a guest's first note", **guest_fields("first")},
        )
        assert parent.status_code == 201, parent.text
        parent_id = parent.json()["id"]

        reply = client.post(
            f"/share/{link.token}/comment",
            json={
                "body": "a guest's reply",
                "parent_id": parent_id,
                **guest_fields("second"),
            },
        )
        assert reply.status_code == 201, reply.text
        assert reply.json()["parent_id"] == parent_id

        row = (
            session.query(Comment)
            .filter(Comment.id == uuid.UUID(reply.json()["id"]))
            .first()
        )
        assert row is not None and str(row.parent_id) == parent_id
        # Attributed to a guest, not to nobody.
        assert row.guest_author_id is not None

    def test_the_guest_reply_is_nested_when_the_share_comments_are_listed(
        self, client, world
    ):
        link = world["link"]
        parent_id = client.post(
            f"/share/{link.token}/comment",
            json={"body": "parent on a link", **guest_fields("p")},
        ).json()["id"]
        client.post(
            f"/share/{link.token}/comment",
            json={
                "body": "reply on a link",
                "parent_id": parent_id,
                **guest_fields("r"),
            },
        )

        listed = client.get(f"/share/{link.token}/comments")
        assert listed.status_code == 200, listed.text
        payload = listed.json()
        rows = payload if isinstance(payload, list) else payload.get("comments", [])
        top = [c for c in rows if c["id"] == parent_id]
        assert top, rows
        assert [r["body"] for r in top[0]["replies"]] == ["reply on a link"]


# ── B(i) — the server refuses an unidentified guest reply ──────────────────


class TestTheServerRequiresGuestIdentity:
    """Part B's server half. Already true before §209 — pinned, not added, so
    the client-side gate cannot be the only thing enforcing it."""

    def test_a_guest_reply_without_a_name_or_email_is_refused(self, client, world):
        link = world["link"]
        parent_id = client.post(
            f"/share/{link.token}/comment",
            json={"body": "parent", **guest_fields("pp")},
        ).json()["id"]

        res = client.post(
            f"/share/{link.token}/comment",
            json={"body": "anonymous reply", "parent_id": parent_id},
        )
        assert res.status_code == 400
        detail = res.json()["detail"]
        # Readable, and says what to supply — this reaches a real person.
        assert "guest_email" in detail and "guest_name" in detail

    def test_a_guest_TOP_LEVEL_comment_without_identity_is_refused_too(
        self, client, world
    ):
        res = client.post(
            f"/share/{world['link'].token}/comment", json={"body": "anonymous"}
        )
        assert res.status_code == 400

    def test_half_an_identity_is_not_enough(self, client, world):
        res = client.post(
            f"/share/{world['link'].token}/comment",
            json={"body": "half", "guest_name": "Only A Name"},
        )
        assert res.status_code == 400

    def test_a_signed_in_caller_needs_no_guest_fields(self, client, world):
        """The same endpoint, with a session: identity comes from the token,
        so the guest fields must NOT be demanded."""
        owner, link = world["owner"], world["link"]
        res = client.post(
            f"/share/{link.token}/comment",
            json={"body": "posted while signed in"},
            headers=auth(owner),
        )
        assert res.status_code == 201, res.text
        assert res.json()["guest_author"] is None
