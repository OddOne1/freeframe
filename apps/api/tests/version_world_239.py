"""The world §239's delete-a-version tests run in, against a real schema.

NOT a test module (no `test_` prefix, so pytest collects nothing here).
Shared by `test_delete_version.py` and `test_version_storage_figures.py`,
which need the same fixture from two directions: one asks what the route
answers, the other asks what eight storage aggregates say afterwards.

Real Postgres, schema built by `alembic upgrade head` — not `create_all`,
and not SQLite as tests/test_purge.py uses. Three things here do not exist
on SQLite at all:

  * `SELECT … FOR UPDATE`, which is the whole concurrency story of §239
    (`with_for_update()` is silently a no-op on SQLite);
  * two sessions on two connections running at the same time, which is
    what the "two concurrent deletes of the last two versions" test is;
  * `uq_asset_versions_asset_version` spanning soft-deleted rows, which is
    what makes a retired version number retired (§236b).

    docker run -d --name ff239-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55449:5432 postgres:15
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55449/freeframe \\
      pytest apps/api/tests/test_delete_version.py

── The cast ───────────────────────────────────────────────────────────────
Six roles, because the matrix in §239 is role × state and five of the six
have to be refused somewhere:

  owner        project owner       may delete ANY version
  uploader     editor              uploaded v1 and v2 of `clip`
  other_editor editor              uploaded v3 of `clip`; may not touch v1/v2
  viewer       viewer              may not delete anything
  superadmin   global superadmin   may delete any version, no membership
  outsider     not a member        must not learn that any of it exists

── The files ──────────────────────────────────────────────────────────────
  clip       v1 (uploader, ready, 1 KiB)
             v2 (uploader, ready, 2 KiB)   ← comments + approval hang here
             v3 (other_editor, ready, 4 KiB)
  solo       v1 (uploader, ready, 8 KiB)   ← the last-remaining-version case
  busy       v1 (uploader, ready, 16 KiB)
             v2 (uploader, UPLOADING, 32 KiB)
             v3 (uploader, PROCESSING, 64 KiB)
  foreign    v1 (owner, ready, 128 KiB) in ANOTHER project

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

DOMAIN = "ff239.test"

#: Never verified — see `_user`. Shaped like a bcrypt hash so nothing
#: reading it mistakes it for a plaintext password.
_FAKE_PASSWORD_HASH = "$2b$12$fakehashfor239testsonlythisisnotreal0000000000000000"

KIB = 1024
#: Sizes, by (asset key, version number). Distinct powers of two.
SIZES = {
    ("clip", 1): 1 * KIB,
    ("clip", 2): 2 * KIB,
    ("clip", 3): 4 * KIB,
    ("solo", 1): 8 * KIB,
    ("busy", 1): 16 * KIB,
    ("busy", 2): 32 * KIB,
    ("busy", 3): 64 * KIB,
    ("foreign", 1): 128 * KIB,
}

#: What everything in `project` adds up to while nothing is deleted.
PROJECT_TOTAL = sum(v for (name, _), v in SIZES.items() if name != "foreign")


def unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}@{DOMAIN}"


def build_world(session):
    """Every role crossed with every version state. See the module docstring."""
    from apps.api.models.approval import Approval, ApprovalStatus
    from apps.api.models.asset import (
        Asset,
        AssetType,
        AssetVersion,
        FileType,
        MediaFile,
        ProcessingStatus,
    )
    from apps.api.models.comment import Annotation, Comment
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    from apps.api.models.share import ShareLink, SharePermission
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    # SetupGuardMiddleware reads the real database past any dependency
    # override and answers 503 to everything until a superadmin exists
    # (§207/§208's harness lesson, as share_world_234.py notes).
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
            # §200's gate blocks every route with 403
            # `account_setup_required` until BOTH halves are done, and
            # `must_set_password` is simply `password_hash is None`. The
            # hash is never verified here — nothing in these tests logs in
            # with a password — but it has to exist or the gate answers
            # before the route does.
            password_hash=_FAKE_PASSWORD_HASH,
            backup_email=unique_email(f"backup-{prefix}"),
            backup_email_verified_at=datetime.now(timezone.utc),
        )
        session.add(u)
        return u

    owner = _user("Olive", "Owner", "owner")
    uploader = _user("Uma", "Uploader", "uploader")
    other_editor = _user("Eddie", "Editor", "editor")
    viewer = _user("Vic", "Viewer", "viewer")
    superadmin = _user("Sam", "Admin", "superadmin", role=UserGlobalRole.superadmin)
    outsider = _user("Ozzy", "Outsider", "outsider")
    session.commit()

    project = Project(name=f"P239-{uuid.uuid4().hex[:8]}", created_by=owner.id)
    other_project = Project(name=f"O239-{uuid.uuid4().hex[:8]}", created_by=owner.id)
    session.add_all([project, other_project])
    session.commit()
    session.add_all([
        ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner),
        ProjectMember(project_id=project.id, user_id=uploader.id, role=ProjectRole.editor),
        ProjectMember(project_id=project.id, user_id=other_editor.id, role=ProjectRole.editor),
        ProjectMember(project_id=project.id, user_id=viewer.id, role=ProjectRole.viewer),
        ProjectMember(project_id=other_project.id, user_id=owner.id, role=ProjectRole.owner),
    ])
    session.commit()

    # One folder holding `clip`, so the folder size rollup has something to
    # be wrong about. `solo` and `busy` sit at the project root.
    folder = Folder(project_id=project.id, name="Day 1", created_by=owner.id)
    session.add(folder)
    session.commit()
    subfolder = Folder(
        project_id=project.id, name="Selects", parent_id=folder.id, created_by=owner.id
    )
    session.add(subfolder)
    session.commit()

    def _asset(name, *, proj=None, folder_=None):
        a = Asset(
            project_id=(proj or project).id,
            folder_id=folder_.id if folder_ is not None else None,
            name=f"{name}-{uuid.uuid4().hex[:6]}.mov",
            asset_type=AssetType.video,
            created_by=owner.id,
        )
        session.add(a)
        return a

    clip = _asset("clip", folder_=subfolder)
    solo = _asset("solo")
    busy = _asset("busy")
    foreign = _asset("foreign", proj=other_project)
    session.commit()

    assets = {"clip": clip, "solo": solo, "busy": busy, "foreign": foreign}

    plan = [
        ("clip", 1, uploader, ProcessingStatus.ready),
        ("clip", 2, uploader, ProcessingStatus.ready),
        ("clip", 3, other_editor, ProcessingStatus.ready),
        ("solo", 1, uploader, ProcessingStatus.ready),
        ("busy", 1, uploader, ProcessingStatus.ready),
        ("busy", 2, uploader, ProcessingStatus.uploading),
        ("busy", 3, uploader, ProcessingStatus.processing),
        ("foreign", 1, owner, ProcessingStatus.ready),
    ]
    versions = {}
    for name, number, author, state in plan:
        asset = assets[name]
        v = AssetVersion(
            asset_id=asset.id,
            version_number=number,
            processing_status=state,
            created_by=author.id,
            created_by_name=author.name,
        )
        session.add(v)
        session.commit()
        versions[(name, number)] = v
        session.add(MediaFile(
            version_id=v.id,
            file_type=FileType.video,
            original_filename=f"{name}-v{number}.mov",
            mime_type="video/quicktime",
            file_size_bytes=SIZES[(name, number)],
            s3_key_raw=f"raw/{project.id}/{asset.id}/{v.id}/original.mov",
            s3_key_processed=f"processed/{project.id}/{asset.id}/{v.id}/hls",
            s3_key_thumbnail=f"processed/{project.id}/{asset.id}/{v.id}/thumb.jpg",
        ))
        session.commit()

    # Content hanging off clip v2 — the version the tests delete. None of
    # it may be destroyed, and none of it may still be reachable.
    comment_v2 = Comment(
        asset_id=clip.id,
        version_id=versions[("clip", 2)].id,
        author_id=uploader.id,
        author_name=uploader.name,
        body="a note on v2",
    )
    comment_v3 = Comment(
        asset_id=clip.id,
        version_id=versions[("clip", 3)].id,
        author_id=other_editor.id,
        author_name=other_editor.name,
        body="a note on v3",
    )
    session.add_all([comment_v2, comment_v3])
    session.commit()
    reply_v2 = Comment(
        asset_id=clip.id,
        version_id=versions[("clip", 2)].id,
        parent_id=comment_v2.id,
        author_id=owner.id,
        author_name=owner.name,
        body="a reply on v2",
    )
    session.add(reply_v2)
    session.commit()
    annotation_v2 = Annotation(comment_id=comment_v2.id, drawing_data={"paths": []})
    approval_v2 = Approval(
        asset_id=clip.id,
        version_id=versions[("clip", 2)].id,
        user_id=owner.id,
        status=ApprovalStatus.approved,
    )
    session.add_all([annotation_v2, approval_v2])
    session.commit()

    link = ShareLink(
        token=uuid.uuid4().hex,
        created_by=owner.id,
        asset_id=clip.id,
        permission=SharePermission.comment,
        show_comments=True,
        show_versions=True,
        allowed_download_variants=["raw"],
    )
    session.add(link)
    session.commit()

    return {
        "session": session,
        "owner": owner,
        "uploader": uploader,
        "other_editor": other_editor,
        "viewer": viewer,
        "superadmin": superadmin,
        "outsider": outsider,
        "project": project,
        "other_project": other_project,
        "folder": folder,
        "subfolder": subfolder,
        "clip": clip,
        "solo": solo,
        "busy": busy,
        "foreign": foreign,
        "versions": versions,
        "comment_v2": comment_v2,
        "comment_v3": comment_v3,
        "reply_v2": reply_v2,
        "annotation_v2": annotation_v2,
        "approval_v2": approval_v2,
        "link": link,
    }


def teardown_world(world):
    """Delete exactly the rows this world created, children first.

    Named rows only, like share_world_234.py: this database may be
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
        ("owner", "uploader", "other_editor", "viewer", "superadmin", "outsider")
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
    wipe(Folder, Folder.project_id.in_(project_ids))
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


def live_numbers(session, asset_id) -> list[int]:
    """The version numbers of `asset_id` that are not deleted, descending —
    what `GET /assets/{id}/versions` is expected to agree with."""
    from apps.api.models.asset import AssetVersion

    return [
        v.version_number for v in session.query(AssetVersion)
        .filter(AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None))
        .order_by(AssetVersion.version_number.desc())
        .all()
    ]
