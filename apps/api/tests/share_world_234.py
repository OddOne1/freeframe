"""The world §234's share-comment tests run in, against a real schema.

NOT a test module (no `test_` prefix, so pytest collects nothing here). It
exists because the §234/§234b files — `test_share_comment_scope.py`,
`test_share_comment_identity.py` and
`test_share_internal_comments_removed.py` — need the same unusually broad
fixture: every shape of share link crossed with content in and out of each
one's scope. Building that three times would be 400 duplicated lines whose
copies would drift the first time one of them needed a new row.

Real Postgres, schema built by `alembic upgrade head`, like
tests/test_comment_replies.py — not `create_all`, because a schema derived
from the models cannot disagree with them, and
`share_links.show_internal_comments` is exactly the kind of thing that has
to be shown arriving through the migration. §234b made that column dead
rather than dropping it, so two of the links below are created with it set
TRUE: that is now a link like any other, and the tests say so.

    docker run -d --name ff234-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55442:5432 postgres:15-alpine
    docker run -d --name ff234-redis -p 63791:6379 redis:7-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55442/freeframe \\
      TEST_REDIS_URL=redis://127.0.0.1:63791/0 \\
      pytest apps/api/tests/test_share_comment_scope.py
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")
REDIS_URL = os.environ.get("TEST_REDIS_URL")

realdb = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)
realredis = pytest.mark.skipif(
    not REDIS_URL or not REDIS_URL.startswith("redis"),
    reason="needs TEST_REDIS_URL pointing at a Redis: a password-gated share "
           "session is a real key, not a patched function",
)

#: The password on the password-protected links.
LINK_PASSWORD = "Rb6#tQn4!zWv"

#: Fixture strings the identity tests search the serialized JSON for. Kept
#: here so both files assert against the same values the world was built
#: with, rather than re-deriving them.
DOMAIN = "ff234.test"


def unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}@{DOMAIN}"


def _password_hash() -> str:
    return bcrypt.hashpw(LINK_PASSWORD.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def build_world(session):
    """Every link shape, and content inside and outside each one.

    Returned as a dict rather than an object so a test reads
    `world["link_folder"]` and a reader can see at the call site which of the
    eight links is meant.
    """
    from apps.api.models.asset import (
        Asset,
        AssetType,
        AssetVersion,
        ProcessingStatus,
    )
    from apps.api.models.comment import Comment
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    from apps.api.models.share import (
        ShareLink,
        ShareLinkItem,
        SharePermission,
    )
    from apps.api.models.user import GuestUser, User, UserGlobalRole, UserStatus

    # SetupGuardMiddleware reads the real database past any dependency
    # override and answers 503 to everything until a superadmin exists
    # (§207/§208's harness lesson, same as test_comment_replies.py).
    if (
        session.query(User)
        .filter(User.role == UserGlobalRole.superadmin, User.deleted_at.is_(None))
        .first()
        is None
    ):
        session.add(
            User(
                email=f"setup-guard@{DOMAIN}",
                first_name="Setup",
                last_name="Guard",
                status=UserStatus.active,
                role=UserGlobalRole.superadmin,
                email_verified=True,
            )
        )
        session.commit()

    def _user(first, last, prefix):
        u = User(
            email=unique_email(prefix),
            first_name=first,
            last_name=last,
            status=UserStatus.active,
            role=UserGlobalRole.user,
            email_verified=True,
            backup_email=unique_email(f"backup-{prefix}"),
            backup_email_verified_at=datetime.now(timezone.utc),
        )
        session.add(u)
        return u

    # Two members whose INITIALS collide ("MS"), for §234 F2's colour rule,
    # and whose first names differ, so the password-link label differs too.
    owner = _user("Mathias", "Sonnleitner", "owner")
    # Same initials, different first name.
    member = _user("Marta", "Steiner", "member")
    outsider = _user("Olivia", "Outsider", "outsider")
    session.commit()

    project = Project(name=f"P{uuid.uuid4().hex[:8]}", created_by=owner.id)
    other_project = Project(name=f"O{uuid.uuid4().hex[:8]}", created_by=owner.id)
    trashed_project = Project(name=f"T{uuid.uuid4().hex[:8]}", created_by=owner.id)
    session.add_all([project, other_project, trashed_project])
    session.commit()
    session.add_all([
        ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner),
        ProjectMember(project_id=project.id, user_id=member.id, role=ProjectRole.editor),
        ProjectMember(project_id=other_project.id, user_id=owner.id, role=ProjectRole.owner),
        ProjectMember(project_id=trashed_project.id, user_id=owner.id, role=ProjectRole.owner),
    ])

    folder_a = Folder(project_id=project.id, name="A", created_by=owner.id)
    folder_b = Folder(project_id=project.id, name="B", created_by=owner.id)
    session.add_all([folder_a, folder_b])
    session.commit()
    folder_a1 = Folder(
        project_id=project.id, name="A1", parent_id=folder_a.id, created_by=owner.id
    )
    folder_trashed = Folder(
        project_id=project.id,
        name="Gone",
        created_by=owner.id,
        deleted_at=datetime.now(timezone.utc),
    )
    session.add_all([folder_a1, folder_trashed])
    session.commit()
    # A live folder UNDER a trashed one: its own deleted_at is NULL, which is
    # why liveness cannot be read off one row.
    folder_under_trashed = Folder(
        project_id=project.id, name="Below", parent_id=folder_trashed.id, created_by=owner.id
    )
    session.add(folder_under_trashed)
    session.commit()

    def _asset(name, *, proj=None, folder=None, deleted=False):
        a = Asset(
            project_id=(proj or project).id,
            folder_id=folder.id if folder is not None else None,
            name=f"{name}-{uuid.uuid4().hex[:6]}.mov",
            asset_type=AssetType.video,
            created_by=owner.id,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        session.add(a)
        return a

    asset_single = _asset("single")
    asset_in_a1 = _asset("in-a1", folder=folder_a1)
    asset_in_b = _asset("in-b", folder=folder_b)
    asset_elsewhere = _asset("elsewhere")
    asset_trashed = _asset("trashed", deleted=True)
    asset_under_trashed_folder = _asset("under-trashed", folder=folder_under_trashed)
    asset_other_project = _asset("foreign", proj=other_project)
    asset_trashed_project = _asset("in-trashed-project", proj=trashed_project)
    session.commit()

    assets = [
        asset_single, asset_in_a1, asset_in_b, asset_elsewhere, asset_trashed,
        asset_under_trashed_folder, asset_other_project, asset_trashed_project,
    ]
    versions = {}
    for a in assets:
        v = AssetVersion(
            asset_id=a.id,
            version_number=1,
            processing_status=ProcessingStatus.ready,
            created_by=owner.id,
        )
        session.add(v)
        versions[a.id] = v
    session.commit()

    def _link(**kwargs):
        kwargs.setdefault("permission", SharePermission.comment)
        kwargs.setdefault("show_comments", True)
        link = ShareLink(token=uuid.uuid4().hex, created_by=owner.id, **kwargs)
        session.add(link)
        return link

    link_asset = _link(asset_id=asset_single.id)
    link_folder = _link(folder_id=folder_a.id)
    link_project = _link(project_id=project.id)
    link_items = _link(project_id=project.id)
    link_pw = _link(asset_id=asset_single.id, password_hash=_password_hash())
    link_pw_folder = _link(folder_id=folder_a.id, password_hash=_password_hash())
    link_view_only = _link(asset_id=asset_single.id, permission=SharePermission.view)
    link_expired = _link(
        asset_id=asset_single.id,
        expires_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    link_disabled = _link(asset_id=asset_single.id, is_enabled=False)
    link_trashed_project = _link(project_id=trashed_project.id)
    link_trashed_asset = _link(asset_id=asset_trashed.id)
    # §234b — two links whose DEAD `show_internal_comments` column is TRUE,
    # one open and one password-protected. Written through the model here;
    # test_share_internal_comments_removed.py also forces the column with
    # raw SQL, so neither path can be the reason it has no effect.
    link_internal_column_true = _link(
        asset_id=asset_single.id, show_internal_comments=True
    )
    link_pw_internal_column_true = _link(
        asset_id=asset_single.id,
        password_hash=_password_hash(),
        show_internal_comments=True,
    )
    session.commit()
    session.add(ShareLinkItem(share_link_id=link_items.id, asset_id=asset_in_a1.id))
    session.commit()

    def _comment(asset, *, body="a note", author=None, guest=None, parent=None,
                 visibility="public", deleted=False):
        c = Comment(
            asset_id=asset.id,
            version_id=versions[asset.id].id,
            parent_id=parent.id if parent is not None else None,
            author_id=author.id if author is not None else None,
            author_name=author.name if author is not None else None,
            guest_author_id=guest.id if guest is not None else None,
            body=body,
            visibility=visibility,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        session.add(c)
        session.commit()
        return c

    guest = GuestUser(email=unique_email("guest"), name="Dana Doe")
    session.add(guest)
    session.commit()

    public_comment = _comment(asset_single, body="the public note", author=owner)
    internal_comment = _comment(
        asset_single, body="the internal note", author=owner, visibility="internal"
    )
    reply = _comment(asset_single, body="the reply", guest=guest, parent=public_comment)
    internal_reply = _comment(
        asset_single,
        body="the internal reply",
        author=member,
        parent=public_comment,
        visibility="internal",
    )
    deleted_comment = _comment(asset_single, body="deleted", author=owner, deleted=True)
    # On an asset OUTSIDE every link's scope, so a scope failure is not
    # indistinguishable from an empty thread.
    elsewhere_comment = _comment(asset_elsewhere, body="not yours", author=owner)
    a1_comment = _comment(asset_in_a1, body="inside the folder", author=member)

    # Trashed last, so the rows above could be created in it.
    trashed_project.deleted_at = datetime.now(timezone.utc)
    session.commit()

    return {
        "session": session,
        "owner": owner,
        "member": member,
        "outsider": outsider,
        "guest": guest,
        "project": project,
        "other_project": other_project,
        "trashed_project": trashed_project,
        "folder_a": folder_a,
        "folder_a1": folder_a1,
        "folder_b": folder_b,
        "folder_trashed": folder_trashed,
        "folder_under_trashed": folder_under_trashed,
        "asset_single": asset_single,
        "asset_in_a1": asset_in_a1,
        "asset_in_b": asset_in_b,
        "asset_elsewhere": asset_elsewhere,
        "asset_trashed": asset_trashed,
        "asset_under_trashed_folder": asset_under_trashed_folder,
        "asset_other_project": asset_other_project,
        "asset_trashed_project": asset_trashed_project,
        "versions": versions,
        "link_asset": link_asset,
        "link_folder": link_folder,
        "link_project": link_project,
        "link_items": link_items,
        "link_pw": link_pw,
        "link_pw_folder": link_pw_folder,
        "link_view_only": link_view_only,
        "link_expired": link_expired,
        "link_disabled": link_disabled,
        "link_trashed_project": link_trashed_project,
        "link_trashed_asset": link_trashed_asset,
        "link_internal_column_true": link_internal_column_true,
        "link_pw_internal_column_true": link_pw_internal_column_true,
        "public_comment": public_comment,
        "internal_comment": internal_comment,
        "reply": reply,
        "internal_reply": internal_reply,
        "deleted_comment": deleted_comment,
        "elsewhere_comment": elsewhere_comment,
        "a1_comment": a1_comment,
    }


def teardown_world(world):
    """Delete exactly the rows this world created, children first.

    Named rows only, like §233's realdb fixtures: this database may be
    somebody's scratch copy of a real one, so nothing here truncates a table.
    """
    from apps.api.models.activity import ActivityLog, Mention, Notification
    from apps.api.models.asset import Asset, AssetVersion
    from apps.api.models.comment import Annotation, Comment
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectMember
    from apps.api.models.share import ShareLink, ShareLinkActivity, ShareLinkItem
    from apps.api.models.user import GuestUser, User

    session = world["session"]
    session.rollback()
    project_ids = [
        world["project"].id, world["other_project"].id, world["trashed_project"].id
    ]
    asset_ids = [
        a.id for a in session.query(Asset).filter(Asset.project_id.in_(project_ids)).all()
    ]
    comment_ids = [
        c.id for c in session.query(Comment).filter(Comment.asset_id.in_(asset_ids)).all()
    ] if asset_ids else []
    link_ids = [
        l.id for l in session.query(ShareLink).filter(
            ShareLink.created_by == world["owner"].id
        ).all()
    ]
    guest_ids = {
        c.guest_author_id
        for c in (session.query(Comment).filter(Comment.asset_id.in_(asset_ids)).all()
                  if asset_ids else [])
        if c.guest_author_id
    }
    guest_ids.add(world["guest"].id)

    def _delete(model, criterion):
        session.query(model).filter(criterion).delete(synchronize_session=False)

    if comment_ids:
        _delete(Annotation, Annotation.comment_id.in_(comment_ids))
        _delete(Mention, Mention.comment_id.in_(comment_ids))
        _delete(Notification, Notification.comment_id.in_(comment_ids))
    if asset_ids:
        _delete(Notification, Notification.asset_id.in_(asset_ids))
        _delete(ActivityLog, ActivityLog.asset_id.in_(asset_ids))
    if link_ids:
        _delete(ShareLinkActivity, ShareLinkActivity.share_link_id.in_(link_ids))
        _delete(ShareLinkItem, ShareLinkItem.share_link_id.in_(link_ids))
    if comment_ids:
        _delete(Comment, Comment.id.in_(comment_ids))
    if link_ids:
        _delete(ShareLink, ShareLink.id.in_(link_ids))
    if asset_ids:
        _delete(AssetVersion, AssetVersion.asset_id.in_(asset_ids))
        _delete(Asset, Asset.id.in_(asset_ids))
    _delete(Folder, Folder.project_id.in_(project_ids))
    _delete(ProjectMember, ProjectMember.project_id.in_(project_ids))
    _delete(ActivityLog, ActivityLog.project_id.in_(project_ids))
    _delete(Project, Project.id.in_(project_ids))
    if guest_ids:
        _delete(GuestUser, GuestUser.id.in_(list(guest_ids)))
    _delete(User, User.id.in_([
        world["owner"].id, world["member"].id, world["outsider"].id
    ]))
    session.commit()
    session.close()


def auth_header(user):
    from apps.api.services.auth_service import create_access_token

    return {
        "Authorization": "Bearer "
        + create_access_token(str(user.id), user.token_version or 0)
    }


def guest_fields(prefix="guest"):
    return {"guest_name": "Pat Visitor", "guest_email": unique_email(prefix)}


def open_password_session(token: str) -> str:
    """A share session for a password-protected link, in the real Redis —
    the same key `GET /share/{token}?password=…` would have written."""
    import secrets

    from apps.api.services.redis_service import create_share_session

    session_id = secrets.token_urlsafe(32)
    create_share_session(token, session_id)
    return session_id
