"""The world §240's trash, delete-rule and restore tests run in.

NOT a test module (no `test_` prefix). Shared by test_trash_listing.py,
test_delete_restore_rules.py and test_version_restore.py, which ask three
different things of the same cast.

Real Postgres, schema built by `alembic upgrade head`, exactly as
version_world_239.py does and for the same reasons — `SELECT … FOR UPDATE`
(the version restore takes the asset lock), two sessions at once, and a
unique constraint that spans soft-deleted rows are all no-ops or absent on
SQLite. §240 adds a fourth: the trash listing is one statement built from
a recursive CTE, three `UNION ALL` branches, `COUNT(DISTINCT CASE …)` and
`IS DISTINCT FROM`, and testing that against anything but the real engine
would be testing a different query.

    docker run -d --name ff240-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55440:5432 postgres:15
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55440/freeframe \\
      pytest apps/api/tests/test_trash_listing.py

── The cast ───────────────────────────────────────────────────────────────
  owner        project owner    may delete and restore anything
  editor_a     editor           uploaded the `a_*` files, created `Day 1`
  editor_b     editor           uploaded the `b_*` files, created `Theirs`
  superadmin   global superadmin AND an editor member of the project — the
                                membership is not decoration: the trash
                                route's gate is `require_project_role(editor)`
                                and §240 deliberately did not widen it, so
                                a superadmin who is not a member still gets
                                the same 403 it has always given (asserted
                                in test_trash_listing.py)
  viewer       viewer           may not see the trash at all
  outsider     not a member     must not learn that any of it exists

── The content ────────────────────────────────────────────────────────────
  Day 1/                 (editor_a)
    Selects/             (editor_a)
      a_inside.mov       (editor_a)        4 KiB
  Shared/                (editor_a)  ← holds somebody else's file, so
    b_mixed.mov          (editor_b)        8 KiB   editor_a may NOT delete it
  Theirs/                (editor_b)                editor_a may NOT delete it
  a_alpha.mov            (editor_a) root   1 KiB
  b_beta.mov             (editor_b) root   2 KiB
  a_multi.mov            (editor_a) root   v1 16 KiB, v2 32 KiB, v3 64 KiB
  a_100%_raw.mov         (editor_a) root   128 KiB  ← LIKE wildcards in a name
  a_b_roll.mov           (editor_a) root   256 KiB  ← `_` in a name
  foreign.mov            (owner) in other_project   512 KiB

Sizes are distinct powers of two so a wrong total names the file that was
counted wrongly instead of just being wrong.
"""

import os
import uuid
from datetime import datetime, timezone

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

realdb = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)

DOMAIN = "ff240.test"

#: Never verified — see `_user` in version_world_239.py for why it exists.
_FAKE_PASSWORD_HASH = "$2b$12$fakehashfor240testsonlythisisnotreal0000000000000000"

KIB = 1024
SIZES = {
    ("a_alpha", 1): 1 * KIB,
    ("b_beta", 1): 2 * KIB,
    ("a_inside", 1): 4 * KIB,
    ("b_mixed", 1): 8 * KIB,
    ("a_multi", 1): 16 * KIB,
    ("a_multi", 2): 32 * KIB,
    ("a_multi", 3): 64 * KIB,
    ("a_pct", 1): 128 * KIB,
    ("a_underscore", 1): 256 * KIB,
    ("foreign", 1): 512 * KIB,
}

#: Names chosen so a search for `%` or `_` would match everything if the
#: pattern were not escaped (§233's helper is what stops that).
NAMES = {
    "a_alpha": "a_alpha.mov",
    "b_beta": "b_beta.mov",
    "a_inside": "a_inside.mov",
    "b_mixed": "b_mixed.mov",
    "a_multi": "a_multi.mov",
    "a_pct": "a_100%_raw.mov",
    "a_underscore": "a_b_roll.mov",
    "foreign": "foreign.mov",
}


def unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}@{DOMAIN}"


def build_world(session):
    from apps.api.models.asset import (
        Asset,
        AssetType,
        AssetVersion,
        FileType,
        MediaFile,
        ProcessingStatus,
    )
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    # SetupGuardMiddleware reads the real database past every dependency
    # override and answers 503 to everything until a superadmin exists.
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

    def _user(first, last, prefix, role=UserGlobalRole.user):
        u = User(
            email=unique_email(prefix),
            first_name=first,
            last_name=last,
            status=UserStatus.active,
            role=role,
            email_verified=True,
            password_hash=_FAKE_PASSWORD_HASH,
            backup_email=unique_email(f"backup-{prefix}"),
            backup_email_verified_at=datetime.now(timezone.utc),
        )
        session.add(u)
        return u

    owner = _user("Olive", "Owner", "owner")
    editor_a = _user("Ava", "Alpha", "editora")
    editor_b = _user("Ben", "Bravo", "editorb")
    superadmin = _user("Sam", "Admin", "superadmin", role=UserGlobalRole.superadmin)
    viewer = _user("Vic", "Viewer", "viewer")
    outsider = _user("Ozzy", "Outsider", "outsider")
    session.commit()

    project = Project(name=f"P240-{uuid.uuid4().hex[:8]}", created_by=owner.id)
    other_project = Project(name=f"O240-{uuid.uuid4().hex[:8]}", created_by=owner.id)
    session.add_all([project, other_project])
    session.commit()
    session.add_all([
        ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner),
        ProjectMember(project_id=project.id, user_id=editor_a.id, role=ProjectRole.editor),
        ProjectMember(project_id=project.id, user_id=editor_b.id, role=ProjectRole.editor),
        # See the module docstring: the gate is unchanged, so the
        # superadmin needs a membership to reach the route at all.
        ProjectMember(project_id=project.id, user_id=superadmin.id, role=ProjectRole.editor),
        ProjectMember(project_id=project.id, user_id=viewer.id, role=ProjectRole.viewer),
        ProjectMember(project_id=other_project.id, user_id=owner.id, role=ProjectRole.owner),
        ProjectMember(project_id=other_project.id, user_id=editor_a.id, role=ProjectRole.editor),
    ])
    session.commit()

    def _folder(name, creator, parent=None, proj=None):
        f = Folder(
            project_id=(proj or project).id,
            name=f"{name}-{uuid.uuid4().hex[:6]}",
            parent_id=parent.id if parent is not None else None,
            created_by=creator.id,
        )
        session.add(f)
        session.commit()
        return f

    day1 = _folder("Day 1", editor_a)
    selects = _folder("Selects", editor_a, parent=day1)
    shared = _folder("Shared", editor_a)
    theirs = _folder("Theirs", editor_b)

    def _asset(key, creator, folder_=None, proj=None):
        a = Asset(
            project_id=(proj or project).id,
            folder_id=folder_.id if folder_ is not None else None,
            name=NAMES[key],
            asset_type=AssetType.video,
            created_by=creator.id,
            created_by_name=creator.name,
        )
        session.add(a)
        session.commit()
        return a

    assets = {
        "a_alpha": _asset("a_alpha", editor_a),
        "b_beta": _asset("b_beta", editor_b),
        "a_inside": _asset("a_inside", editor_a, folder_=selects),
        "b_mixed": _asset("b_mixed", editor_b, folder_=shared),
        "a_multi": _asset("a_multi", editor_a),
        "a_pct": _asset("a_pct", editor_a),
        "a_underscore": _asset("a_underscore", editor_a),
        "foreign": _asset("foreign", owner, proj=other_project),
    }

    uploader_of = {
        "a_alpha": editor_a, "b_beta": editor_b, "a_inside": editor_a,
        "b_mixed": editor_b, "a_multi": editor_a, "a_pct": editor_a,
        "a_underscore": editor_a, "foreign": owner,
    }

    versions = {}
    for (key, number), size in SIZES.items():
        asset = assets[key]
        author = uploader_of[key]
        v = AssetVersion(
            asset_id=asset.id,
            version_number=number,
            processing_status=ProcessingStatus.ready,
            created_by=author.id,
            created_by_name=author.name,
            upload_completed_at=datetime.now(timezone.utc),
        )
        session.add(v)
        session.commit()
        versions[(key, number)] = v
        session.add(MediaFile(
            version_id=v.id,
            file_type=FileType.video,
            original_filename=f"{key}-v{number}.mov",
            mime_type="video/quicktime",
            file_size_bytes=size,
            s3_key_raw=f"raw/{asset.project_id}/{asset.id}/{v.id}/original.mov",
            s3_key_processed=f"processed/{asset.project_id}/{asset.id}/{v.id}/hls",
            s3_key_thumbnail=f"processed/{asset.project_id}/{asset.id}/{v.id}/thumb.jpg",
        ))
        session.commit()

    return {
        "session": session,
        "owner": owner,
        "editor_a": editor_a,
        "editor_b": editor_b,
        "superadmin": superadmin,
        "viewer": viewer,
        "outsider": outsider,
        "project": project,
        "other_project": other_project,
        "day1": day1,
        "selects": selects,
        "shared": shared,
        "theirs": theirs,
        "assets": assets,
        "versions": versions,
    }


def teardown_world(world):
    """Delete exactly the rows this world created, children first.

    Named rows only, like version_world_239.py: this database may be
    somebody's scratch copy of a real one, so nothing here truncates a
    table.
    """
    from apps.api.models.activity import ActivityLog, AssetView, Mention, Notification
    from apps.api.models.approval import Approval
    from apps.api.models.asset import Asset, AssetVersion, CarouselItem, MediaFile
    from apps.api.models.comment import (
        Annotation,
        Comment,
        CommentAttachment,
        CommentReaction,
    )
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectMember
    from apps.api.models.share import ShareLink, ShareLinkActivity, ShareLinkItem
    from apps.api.models.user import User

    session = world["session"]
    session.rollback()
    project_ids = [world["project"].id, world["other_project"].id]
    asset_ids = [
        a.id for a in session.query(Asset).filter(Asset.project_id.in_(project_ids)).all()
    ]
    version_ids = [
        v.id for v in session.query(AssetVersion)
        .filter(AssetVersion.asset_id.in_(asset_ids)).all()
    ] if asset_ids else []
    comment_ids = [
        c.id for c in session.query(Comment).filter(Comment.asset_id.in_(asset_ids)).all()
    ] if asset_ids else []
    user_ids = [
        world[k].id for k in
        ("owner", "editor_a", "editor_b", "superadmin", "viewer", "outsider")
    ]

    def wipe(model, where):
        session.query(model).filter(where).delete(synchronize_session=False)

    if comment_ids:
        wipe(Annotation, Annotation.comment_id.in_(comment_ids))
        wipe(CommentAttachment, CommentAttachment.comment_id.in_(comment_ids))
        wipe(CommentReaction, CommentReaction.comment_id.in_(comment_ids))
        wipe(Mention, Mention.comment_id.in_(comment_ids))
        wipe(Notification, Notification.comment_id.in_(comment_ids))
    if asset_ids:
        wipe(Notification, Notification.asset_id.in_(asset_ids))
        wipe(Comment, Comment.asset_id.in_(asset_ids))
        wipe(Approval, Approval.asset_id.in_(asset_ids))
        wipe(AssetView, AssetView.asset_id.in_(asset_ids))
        wipe(ActivityLog, ActivityLog.asset_id.in_(asset_ids))
        wipe(ShareLinkActivity, ShareLinkActivity.asset_id.in_(asset_ids))
        wipe(ShareLinkItem, ShareLinkItem.asset_id.in_(asset_ids))
    if version_ids:
        wipe(CarouselItem, CarouselItem.version_id.in_(version_ids))
        wipe(MediaFile, MediaFile.version_id.in_(version_ids))
        wipe(AssetVersion, AssetVersion.id.in_(version_ids))
    link_ids = [
        l.id for l in session.query(ShareLink)
        .filter(ShareLink.created_by.in_(user_ids)).all()
    ]
    if link_ids:
        wipe(ShareLinkActivity, ShareLinkActivity.share_link_id.in_(link_ids))
        wipe(ShareLinkItem, ShareLinkItem.share_link_id.in_(link_ids))
        wipe(ShareLink, ShareLink.id.in_(link_ids))
    if asset_ids:
        wipe(Asset, Asset.id.in_(asset_ids))
    # Children before parents: `folders.parent_id` is NO ACTION.
    for _ in range(4):
        session.query(Folder).filter(
            Folder.project_id.in_(project_ids),
            ~Folder.id.in_(
                session.query(Folder.parent_id)
                .filter(Folder.project_id.in_(project_ids), Folder.parent_id.isnot(None))
            ),
        ).delete(synchronize_session=False)
    wipe(ProjectMember, ProjectMember.project_id.in_(project_ids))
    wipe(Project, Project.id.in_(project_ids))
    wipe(User, User.id.in_(user_ids))
    session.commit()
    session.close()


def auth_header(user):
    from apps.api.services.auth_service import create_access_token

    return {
        "Authorization": "Bearer "
        + create_access_token(str(user.id), user.token_version or 0)
    }


def row_state(session, model, row_id):
    """`(deleted_at, deleted_by, deleted_by_name)` straight from the database.

    Every refusal test reads this: a 403 over a committed `deleted_at`
    looks identical to the client, so "no row changed" has to be asserted
    against the row and not against the response.
    """
    session.expire_all()
    row = session.query(model).filter(model.id == row_id).first()
    if row is None:
        return "ROW GONE"
    return (row.deleted_at, row.deleted_by, row.deleted_by_name)
