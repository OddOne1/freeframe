import re
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..middleware.rate_limit import share_comment_rate_limit
from ..models.asset import Asset
from ..models.project import ProjectMember, ProjectRole
from ..models.comment import Annotation, Comment, CommentAttachment, CommentReaction
from ..models.activity import Mention, Notification, NotificationType, ActivityLog, ActivityAction
from ..models.user import User, GuestUser
from ..models.share import ShareLink, ShareLinkActivity, ShareActivityAction, SharePermission
from ..schemas.comment import (
    AnnotationResponse,
    AttachmentResponse,
    AttachmentUploadRequest,
    AttachmentUploadResponse,
    AuthorInfo,
    GuestAuthorInfo,
    CommentCreate,
    CommentResponse,
    CommentUpdate,
    GuestCommentCreate,
    ReactionCreate,
    ReactionResponse,
    ShareCommentResponse,
)
from ..services import s3_service
from .hls_proxy import proxy_url_for
from ..services.permissions import (
    can_access_asset,
    get_project_member,
    require_asset_access,
    validate_asset_in_share,
    validate_share_link_with_session,
)
from ..services.share_identity import ANONYMOUS_MENTION, ShareAuthorStyles
from ..services.asset_versions import live_version
from ..services.asset_visibility import version_is_live
from ..tasks.email_tasks import send_mention_email, send_comment_email
from ..services.notification_prefs import should_create_notification, should_send_email
from ..tasks.celery_app import send_task_safe

router = APIRouter(tags=["comments"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_asset(db: Session, asset_id: uuid.UUID) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


def _get_comment(db: Session, comment_id: uuid.UUID) -> Comment:
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    return comment


def _build_attachment_response(attachment: CommentAttachment) -> AttachmentResponse:
    url = proxy_url_for(attachment.s3_key, expires_hours=1)
    return AttachmentResponse(
        id=attachment.id,
        file_name=attachment.original_filename,
        file_size=attachment.file_size_bytes,
        content_type=attachment.file_type,
        url=url,
    )


def _build_reaction_responses(
    reactions: list[CommentReaction],
    current_user_id: uuid.UUID | None,
) -> list[ReactionResponse]:
    counts: dict[str, int] = defaultdict(int)
    reacted: dict[str, bool] = defaultdict(bool)
    for r in reactions:
        counts[r.emoji] += 1
        if current_user_id and r.user_id == current_user_id:
            reacted[r.emoji] = True
    return [
        ReactionResponse(emoji=emoji, count=cnt, reacted=reacted[emoji])
        for emoji, cnt in counts.items()
    ]


def _build_comment_response(
    comment: Comment,
    db: Session,
    current_user_id: uuid.UUID | None = None,
    depth: int = 5,
) -> CommentResponse:
    annotation = db.query(Annotation).filter(Annotation.comment_id == comment.id).first()
    replies_raw = []
    if depth > 0:
        replies_raw = db.query(Comment).filter(
            Comment.parent_id == comment.id,
            Comment.deleted_at.is_(None),
        ).order_by(Comment.created_at).all()

    # Load attachments
    attachments_raw = db.query(CommentAttachment).filter(
        CommentAttachment.comment_id == comment.id,
    ).all()
    attachments = [_build_attachment_response(a) for a in attachments_raw]

    # Load reactions
    reactions_raw = db.query(CommentReaction).filter(
        CommentReaction.comment_id == comment.id,
    ).all()
    reactions = _build_reaction_responses(reactions_raw, current_user_id)

    # Load author info
    author_info = None
    if comment.author_id:
        author = db.query(User).filter(User.id == comment.author_id).first()
        if author:
            author_info = AuthorInfo(id=author.id, name=author.name, avatar_url=author.avatar_url)

    guest_author_info = None
    if comment.guest_author_id:
        guest = db.query(GuestUser).filter(GuestUser.id == comment.guest_author_id).first()
        if guest:
            guest_author_info = GuestAuthorInfo(id=guest.id, name=guest.name, email=guest.email)

    resp = CommentResponse.model_validate(comment)
    resp.author = author_info
    resp.guest_author = guest_author_info
    resp.annotation = AnnotationResponse.model_validate(annotation) if annotation else None
    resp.replies = [
        _build_comment_response(r, db, current_user_id=current_user_id, depth=depth - 1)
        for r in replies_raw
    ]
    resp.attachments = attachments
    resp.reactions = reactions
    return resp


def _get_annotations_map(comment_ids: list[uuid.UUID], db: Session) -> dict:
    """Batch-load annotations for a list of comment IDs."""
    if not comment_ids:
        return {}
    annotations = db.query(Annotation).filter(Annotation.comment_id.in_(comment_ids)).all()
    return {a.comment_id: a for a in annotations}


def _parse_mentions(body: str) -> list[str]:
    """Extract @email mentions from comment body."""
    return re.findall(r"@([\w.+-]+@[\w.-]+\.\w+)", body)


def _create_mentions(db: Session, comment: Comment, asset: Asset, body: str, author_name: str, mention_user_ids: list | None = None) -> None:
    """Create Mention + Notification records and send emails.
    Uses explicit mention_user_ids if provided, else falls back to parsing @email from body."""
    from ..services.auth_service import get_user_by_email
    from ..config import settings

    mentioned_users = []

    if mention_user_ids:
        # Use explicit user IDs from frontend
        for uid in set(mention_user_ids):
            user = db.query(User).filter(User.id == uid).first()
            if user and user.id != comment.author_id:
                mentioned_users.append(user)
    else:
        # Fallback: parse @email from body
        emails = _parse_mentions(body)
        for email in set(emails):
            user = get_user_by_email(db, email)
            if user and user.id != comment.author_id:
                mentioned_users.append(user)

    for user in mentioned_users:
        # The Mention row itself is a fact about the comment, not a
        # notification: it is what @-highlights the name when anyone reads
        # the thread. It is written regardless of preferences.
        mention = Mention(comment_id=comment.id, mentioned_user_id=user.id)
        db.add(mention)

        # §108 — the settings page has offered these controls all along and
        # nothing read them back.
        if should_create_notification(user, "mentions"):
            db.add(Notification(
                user_id=user.id,
                type=NotificationType.mention,
                asset_id=asset.id,
                comment_id=comment.id,
            ))

        if should_send_email(user, "mentions"):
            asset_link = f"{settings.frontend_url}/projects/{asset.project_id}/assets/{asset.id}"
            send_task_safe(send_mention_email,
                to_email=user.email,
                mentioner_name=author_name,
                asset_name=asset.name,
                comment_preview=body[:200],
                asset_link=asset_link,
            )


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/assets/{asset_id}/comments", response_model=list[CommentResponse])
def list_comments(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = None,
    visibility: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    # Top-level comments only (parent_id is None)
    query = db.query(Comment).filter(
        Comment.asset_id == asset_id,
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
        # §239 — a deleted version's comments are hidden WITH it. This
        # listing is scoped to the asset and `version_id` is optional, so
        # dropping the deleted version's own rows is the only thing that
        # makes "hidden with the version" true for a caller that omits it
        # (the app always sends it; the route does not require it).
        version_is_live(Comment.version_id),
    )
    if version_id:
        query = query.filter(Comment.version_id == version_id)
    if visibility and visibility in ("public", "internal"):
        query = query.filter(Comment.visibility == visibility)
    top_level = query.order_by(Comment.created_at).all()
    return [_build_comment_response(c, db, current_user_id=current_user.id) for c in top_level]


@router.post("/assets/{asset_id}/comments", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def create_comment(
    asset_id: uuid.UUID,
    body: CommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)

    # §239 — the version has to be one of THIS asset's live versions.
    # `version_id` is required by the schema and was written straight onto
    # the row unchecked, so this route would file a comment against another
    # asset's version (the share route has refused that since §234) or
    # against a version someone had just deleted. 400 and the same message
    # the share route uses: the version is not a valid target, and which of
    # the three reasons it is not is none of the caller's business.
    if not live_version(db, asset_id, body.version_id):
        raise HTTPException(status_code=400, detail="Invalid comment target")

    comment = Comment(
        asset_id=asset_id,
        version_id=body.version_id,
        parent_id=body.parent_id,
        author_id=current_user.id,
        author_name=current_user.name,
        timecode_start=body.timecode_start,
        timecode_end=body.timecode_end,
        body=body.body,
        visibility=body.visibility or "public",
    )
    db.add(comment)
    db.flush()

    if body.annotation:
        annotation = Annotation(
            comment_id=comment.id,
            drawing_data=body.annotation.drawing_data,
            frame_number=body.annotation.frame_number,
            carousel_position=body.annotation.carousel_position,
        )
        db.add(annotation)

    _create_mentions(db, comment, asset, body.body, current_user.name, body.mention_user_ids)

    # Notify asset creator about the comment (unless they're the commenter)
    if asset.created_by and asset.created_by != current_user.id:
        owner = db.query(User).filter(User.id == asset.created_by).first()
        if should_create_notification(owner, "general_comments"):
            db.add(Notification(
                user_id=asset.created_by,
                type=NotificationType.comment,
                asset_id=asset_id,
                comment_id=comment.id,
            ))

    # Activity log
    activity = ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.commented)
    db.add(activity)

    db.commit()
    db.refresh(comment)
    return _build_comment_response(comment, db, current_user_id=current_user.id)


@router.post("/assets/{asset_id}/comments/{comment_id}/replies", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def reply_to_comment(
    asset_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: CommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    parent = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not parent:
        raise HTTPException(status_code=404, detail="Parent comment not found")
    # §239 — a reply inherits the parent's version, so a parent on a
    # DELETED version is how a new comment lands on one. The parent is not
    # listed any more either, so the same answer as a missing parent is
    # also the honest one.
    if not live_version(db, asset_id, parent.version_id):
        raise HTTPException(status_code=404, detail="Parent comment not found")

    # Force body's version_id to match parent
    reply = Comment(
        asset_id=asset_id,
        version_id=parent.version_id,
        parent_id=comment_id,
        author_id=current_user.id,
        author_name=current_user.name,
        body=body.body,
    )
    db.add(reply)
    db.flush()
    _create_mentions(db, reply, asset, body.body, current_user.name, body.mention_user_ids)

    # Notify parent comment author about the reply (unless they're the replier)
    if parent.author_id and parent.author_id != current_user.id:
        parent_author = db.query(User).filter(User.id == parent.author_id).first()
        if should_create_notification(parent_author, "comment_replies"):
            db.add(Notification(
                user_id=parent.author_id,
                type=NotificationType.comment,
                asset_id=asset_id,
                comment_id=reply.id,
            ))

    db.commit()
    db.refresh(reply)
    return _build_comment_response(reply, db, current_user_id=current_user.id)


@router.patch("/comments/{comment_id}", response_model=CommentResponse)
def update_comment(
    comment_id: uuid.UUID,
    body: CommentUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    # Allow comment owner or project owner to edit
    if comment.author_id != current_user.id:
        asset = _get_asset(db, comment.asset_id)
        member = db.query(ProjectMember).filter(
            ProjectMember.project_id == asset.project_id,
            ProjectMember.user_id == current_user.id,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).first()
        if not member:
            raise HTTPException(status_code=403, detail="Can only edit your own comments")
    comment.body = body.body
    comment.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(comment)
    return _build_comment_response(comment, db, current_user_id=current_user.id)


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    # Allow comment owner or project owner to delete
    if comment.author_id != current_user.id:
        asset = _get_asset(db, comment.asset_id)
        member = db.query(ProjectMember).filter(
            ProjectMember.project_id == asset.project_id,
            ProjectMember.user_id == current_user.id,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).first()
        if not member:
            raise HTTPException(status_code=403, detail="Can only delete your own comments")
    comment.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.post("/comments/{comment_id}/resolve", response_model=CommentResponse)
def resolve_comment(
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)
    comment.resolved = not comment.resolved
    db.commit()
    db.refresh(comment)
    return _build_comment_response(comment, db, current_user_id=current_user.id)


# ── Attachments ────────────────────────────────────────────────────────────────

@router.post(
    "/comments/{comment_id}/attachments",
    response_model=AttachmentUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_attachment(
    comment_id: uuid.UUID,
    body: AttachmentUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)

    # Generate S3 key
    key = f"comment-attachments/{comment_id}/{uuid.uuid4()}/{body.file_name}"

    # Generate presigned PUT URL
    s3 = s3_service.get_s3_client()
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": body.content_type,
        },
        ExpiresIn=3600,
    )

    # Save attachment record
    attachment = CommentAttachment(
        comment_id=comment_id,
        file_type=body.content_type,
        s3_key=key,
        original_filename=body.file_name,
        file_size_bytes=body.file_size,
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)

    return AttachmentUploadResponse(
        upload_url=upload_url,
        attachment_id=attachment.id,
        key=key,
    )


@router.delete(
    "/comments/{comment_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_attachment(
    comment_id: uuid.UUID,
    attachment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)

    attachment = db.query(CommentAttachment).filter(
        CommentAttachment.id == attachment_id,
        CommentAttachment.comment_id == comment_id,
    ).first()
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Must be comment author OR project owner/editor
    from ..models.project import ProjectRole
    from ..services.permissions import get_project_member
    is_comment_author = comment.author_id == current_user.id
    if not is_comment_author:
        pm = get_project_member(db, asset.project_id, current_user.id)
        if not pm or pm.role not in (ProjectRole.owner, ProjectRole.editor):
            raise HTTPException(status_code=403, detail="Not authorized to delete this attachment")

    # Delete from S3
    try:
        s3_service.delete_object(attachment.s3_key)
    except Exception:
        pass  # Best-effort S3 deletion

    db.delete(attachment)
    db.commit()


# ── Reactions ──────────────────────────────────────────────────────────────────

@router.post("/comments/{comment_id}/react", status_code=status.HTTP_204_NO_CONTENT)
def toggle_reaction(
    comment_id: uuid.UUID,
    body: ReactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)

    existing = db.query(CommentReaction).filter(
        CommentReaction.comment_id == comment_id,
        CommentReaction.user_id == current_user.id,
        CommentReaction.emoji == body.emoji,
    ).first()

    if existing:
        db.delete(existing)
    else:
        reaction = CommentReaction(
            comment_id=comment_id,
            user_id=current_user.id,
            emoji=body.emoji,
        )
        db.add(reaction)

    db.commit()


@router.get("/comments/{comment_id}/reactions", response_model=list[ReactionResponse])
def list_reactions(
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)

    reactions_raw = db.query(CommentReaction).filter(
        CommentReaction.comment_id == comment_id,
    ).all()
    return _build_reaction_responses(reactions_raw, current_user.id)


# ── Deep link ──────────────────────────────────────────────────────────────────

@router.get("/assets/{asset_id}/comments/{comment_id}/link")
def comment_deep_link(
    asset_id: uuid.UUID,
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    # Verify comment belongs to this asset
    comment = db.query(Comment).filter(
        Comment.id == comment_id,
        Comment.asset_id == asset_id,
        Comment.deleted_at.is_(None),
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    url = f"{settings.frontend_url}/assets/{asset_id}?comment={comment_id}"
    return {"url": url}


# ── Guest comments (via share link) ───────────────────────────────────────────
#
# §234 — the two public comment routes. Both were the same two mistakes: they
# validated the TOKEN and then trusted the body. `validate_share_link` alone
# skipped the password gate `validate_share_link_with_session` exists for, and
# a client-supplied `asset_id` was used as given — on the listing it read any
# asset on the instance, and on the POST it OVERRODE the link's own asset, so
# any commenting link could write a comment onto any asset uuid.
#
# What a share viewer may see about the people in the thread is
# services/share_identity.py and `ShareCommentResponse`; see
# `_build_share_comment_response` below.


def _share_visibility_filter(link: ShareLink):
    """Which comments this link is allowed to show: the PUBLIC ones. Always.

    §234b, the owner's decision, which replaces §234 F1's option: a share
    link NEVER returns a comment marked internal. "Internal" means the
    team's own notes, invisible to anyone holding a link, password or not —
    so there is nothing here to configure, and nothing read off the link.

    `link` is still the argument because the caller has one and the filter
    belongs to it conceptually; `share_links.show_internal_comments` is
    deliberately NOT consulted. That column is dead (§234b C) and stays in
    the database only until a later migration drops it; a link whose column
    is TRUE from before this change gets exactly this filter.

    The authenticated listing filters `visibility` on request; this one is
    not a request, it is the rule.
    """
    return Comment.visibility == "public"


def _share_comment_tree(db: Session, link: ShareLink, asset_id: uuid.UUID, depth: int = 5):
    """Every comment this link may show for `asset_id`, as (top_level, replies_by_parent).

    The visibility filter is applied at EVERY level, replies included: an
    internal note nested under a public comment is still an internal note, and
    §234 F2's whole point is that it does not leave the team by being deep in
    a thread. Replies go through `_share_visibility_filter` — the same one
    object, not a second copy of the rule that could drift from it.
    """
    vis = _share_visibility_filter(link)
    # §239 — and the deleted version's comments, at every level, for the
    # same reason the visibility filter is applied at every level: a share
    # listing is per ASSET, so a comment on a deleted version would
    # otherwise still be published to the link.
    live = version_is_live(Comment.version_id)
    top_level = db.query(Comment).filter(
        Comment.asset_id == asset_id,
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
        vis,
        live,
    ).order_by(Comment.created_at).all()

    replies_by_parent: dict[uuid.UUID, list[Comment]] = {}
    level = top_level
    for _ in range(depth):
        ids = [c.id for c in level]
        if not ids:
            break
        children = db.query(Comment).filter(
            Comment.parent_id.in_(ids),
            Comment.deleted_at.is_(None),
            vis,
            live,
        ).order_by(Comment.created_at).all()
        for child in children:
            replies_by_parent.setdefault(child.parent_id, []).append(child)
        level = children
    return top_level, replies_by_parent


def _flatten_share_comments(top_level, replies_by_parent) -> list[Comment]:
    out: list[Comment] = []
    stack = list(top_level)
    while stack:
        comment = stack.pop()
        out.append(comment)
        stack.extend(replies_by_parent.get(comment.id, []))
    return out


def _share_author_styles(db: Session, link: ShareLink, comments: list[Comment]) -> ShareAuthorStyles:
    """Labels and colours for every author in this listing (§234 F2).

    Names are read here and used ONLY to derive a label — initials, or a
    first name on a password-protected link. Neither the name nor the id
    they were looked up by reaches the response.
    """
    styles = ShareAuthorStyles(link)
    user_ids = {c.author_id for c in comments if c.author_id}
    guest_ids = {c.guest_author_id for c in comments if c.guest_author_id}
    user_names: dict[uuid.UUID, str] = {}
    guest_names: dict[uuid.UUID, str] = {}
    if user_ids:
        # Whole rows, not (id, name): `User.name` is a property derived from
        # first_name/last_name, not a column, so it cannot be selected.
        user_names = {
            u.id: u.name for u in db.query(User).filter(User.id.in_(user_ids)).all()
        }
    if guest_ids:
        guest_names = {
            g.id: g.name
            for g in db.query(GuestUser).filter(GuestUser.id.in_(guest_ids)).all()
        }
    for comment in comments:
        if comment.author_id:
            styles.add("user", comment.author_id, user_names.get(comment.author_id), comment.created_at)
        elif comment.guest_author_id:
            styles.add("guest", comment.guest_author_id, guest_names.get(comment.guest_author_id), comment.created_at)
    return styles


def _share_mention_labels(db: Session, comments: list[Comment], styles: ShareAuthorStyles) -> dict:
    """comment id -> {lower-cased e-mail: label} for the mentions in it.

    Only addresses that really produced a `Mention` row are labelled, and
    §234 B only writes those for members of the asset's project. Anything
    else in the body that looks like `@someone@example.com` is replaced with
    `@someone` instead — so a guest cannot type an address into a comment and
    read the response to find out who, outside the project, holds it.
    """
    ids = [c.id for c in comments]
    if not ids:
        return {}
    rows = db.query(Mention.comment_id, User).join(
        User, User.id == Mention.mentioned_user_id
    ).filter(Mention.comment_id.in_(ids)).all()
    out: dict[uuid.UUID, dict[str, str]] = {}
    for comment_id, user in rows:
        if user.email:
            out.setdefault(comment_id, {})[user.email.lower()] = styles.label_for(user.name)
    return out


def _rewrite_share_body(body: str, mention_labels: dict) -> str:
    """The comment's own text, with e-mail mentions turned into labels.

    `_parse_mentions` means an @-mention IS an e-mail address in the body, so
    the body carries identity even when every field around it has been
    stripped. A mention of a project member becomes `@MS` / `@Mathias` (the
    same rule as the author chip); anything else becomes `@someone`.

    FREE-TYPED NAMES ARE NOT TOUCHED. If a commenter writes "ask Sabine about
    the grade", that is their own sentence and this cannot tell it from the
    rest of the note; scrubbing prose is not something a filter can do
    honestly. What a share viewer reads is what the commenter chose to write.
    """
    def _replace(match: "re.Match[str]") -> str:
        email = match.group(1)
        label = mention_labels.get(email.lower())
        return f"@{label}" if label else ANONYMOUS_MENTION

    return re.sub(r"@([\w.+-]+@[\w.-]+\.\w+)", _replace, body or "")


def _build_share_comment_response(
    comment: Comment,
    *,
    link: ShareLink,
    styles: ShareAuthorStyles,
    replies_by_parent: dict,
    annotations: dict,
    mention_labels: dict,
    depth: int = 5,
) -> ShareCommentResponse:
    """One comment, in the share-viewer shape (§234 F2).

    Built field by field into an allowlist model rather than by stripping
    `CommentResponse`: `resolved`, `asset_id`, the reaction list, the
    attachment list and every author field simply have nowhere to go here.
    `author_label`/`author_initials`/`author_color` are the only statements
    about a person, and the link creator previewing their own link gets
    exactly the same shape — these routes never switch to the authenticated
    one. `visibility` has nowhere to go here either, since §234b: every
    comment in a share listing is public by construction.
    """
    kind, author_id = (
        ("user", comment.author_id) if comment.author_id else ("guest", comment.guest_author_id)
    )
    label, color = styles.style(kind, author_id)
    annotation = annotations.get(comment.id)
    replies = replies_by_parent.get(comment.id, []) if depth > 0 else []
    return ShareCommentResponse(
        id=comment.id,
        parent_id=comment.parent_id,
        version_id=comment.version_id,
        timecode_start=comment.timecode_start,
        timecode_end=comment.timecode_end,
        body=_rewrite_share_body(comment.body, mention_labels.get(comment.id, {})),
        created_at=comment.created_at,
        updated_at=comment.updated_at,
        annotation=AnnotationResponse.model_validate(annotation) if annotation else None,
        author_label=label,
        # §234b — the chip's letters, the same on both link types. Derived
        # from the name `styles` already read, never from the label: taking
        # letters off a first name gives "MA" for "Mathias".
        author_initials=styles.initials_for(kind, author_id),
        author_color=color,
        replies=[
            _build_share_comment_response(
                r,
                link=link,
                styles=styles,
                replies_by_parent=replies_by_parent,
                annotations=annotations,
                mention_labels=mention_labels,
                depth=depth - 1,
            )
            for r in replies
        ],
    )


@router.get("/share/{token}/comments", response_model=list[ShareCommentResponse])
def list_share_comments(
    token: str,
    asset_id: Optional[uuid.UUID] = None,
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Public endpoint — the comments a share link shows for one asset.

    §234 A/B — three gates this route did not have:

    * the link's PASSWORD, via `share_session`, exactly as the other public
      share endpoints read it. It used to list a password-protected link's
      comments to anyone holding the token;
    * the asset's SCOPE: for a folder or project link the caller names the
      asset, and `validate_asset_in_share` is what makes that name mean an
      asset inside the link rather than any uuid on the instance. The link's
      own `asset_id` still wins where it has one;
    * VISIBILITY: internal comments are the team's, and this answered all of
      them to anonymous callers. Since §234b they NEVER come back here —
      not on any link, with or without a password, whatever
      `share_links.show_internal_comments` says. See
      `_share_visibility_filter`.
    """
    link = validate_share_link_with_session(
        db, token, share_session=share_session, current_user=current_user
    )

    # The link's own asset always wins; `asset_id` is only consulted for a
    # folder/project/items link, which has no single asset of its own.
    target_asset_id = link.asset_id or asset_id
    if not target_asset_id:
        return []
    asset = validate_asset_in_share(db, link, target_asset_id)

    top_level, replies_by_parent = _share_comment_tree(db, link, asset.id)
    comments = _flatten_share_comments(top_level, replies_by_parent)
    styles = _share_author_styles(db, link, comments)
    annotations = _get_annotations_map([c.id for c in comments], db)
    mention_labels = _share_mention_labels(db, comments, styles)
    return [
        _build_share_comment_response(
            c,
            link=link,
            styles=styles,
            replies_by_parent=replies_by_parent,
            annotations=annotations,
            mention_labels=mention_labels,
        )
        for c in top_level
    ]


@router.post(
    "/share/{token}/comment",
    response_model=ShareCommentResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(share_comment_rate_limit)],
)
def guest_comment(
    token: str,
    body: GuestCommentCreate,
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Post a comment through a share link — the one anonymous write here.

    §234 B/C. What changed, in the order it is enforced:

    * the share-token rate limit (§234 C), a route dependency so it runs
      before anything is validated and cannot be used to probe tokens;
    * the link's password, via `share_session`;
    * the asset: `link.asset_id or body.asset_id`, not the other way round.
      `body.asset_id` used to OVERRIDE the link's own asset, so one
      commenting link could write onto any asset uuid on the instance. For a
      folder/project link the body's asset still has to pass the scope check;
    * `parent_id` and `version_id`, which were stored exactly as given — a
      reply under another asset's comment, or under an internal one, and a
      version belonging to a different asset, were all accepted;
    * `internal`, which only a signed-in caller with real access to the asset
      may file. A guest cannot, by any route;
    * mentions, which now reach project MEMBERS only.
    """
    link = validate_share_link_with_session(
        db, token, share_session=share_session, current_user=current_user
    )

    # Check share link permission allows commenting
    if link.permission == SharePermission.view:
        raise HTTPException(status_code=403, detail="This share link does not allow commenting")

    # Resolve the asset: the link's own if it has one, else the body's —
    # validated against the link's scope either way.
    target_asset_id = link.asset_id or body.asset_id
    if not target_asset_id:
        raise HTTPException(status_code=400, detail="asset_id is required for folder/project shares")
    asset = validate_asset_in_share(db, link, target_asset_id)

    # A reply has to answer something a holder of this link can actually see:
    # a live, public comment on the asset the link resolved to. Since §234b
    # that is the only kind of comment a link lists at all, so this check
    # and the listing agree by construction. The message is generic: a share
    # caller learns only that this parent is not available to them.
    parent = None
    if body.parent_id:
        parent = db.query(Comment).filter(
            Comment.id == body.parent_id,
            Comment.asset_id == asset.id,
            Comment.deleted_at.is_(None),
            Comment.visibility == "public",
        ).first()
        if not parent:
            raise HTTPException(status_code=400, detail="Invalid comment target")
        # §239 — and its version must still be live: a reply takes the
        # parent's `version_id` below, which is the one way a guest can
        # post onto a deleted version.
        if not live_version(db, asset.id, parent.version_id):
            raise HTTPException(status_code=400, detail="Invalid comment target")

    from ..models.asset import AssetVersion, ProcessingStatus

    version_id = body.version_id
    if version_id:
        # Existing is not the same as belonging: comments are selected by
        # version_id elsewhere, so a version from another asset files this
        # comment into that asset's thread.
        owned = db.query(AssetVersion).filter(
            AssetVersion.id == version_id,
            AssetVersion.asset_id == asset.id,
            AssetVersion.deleted_at.is_(None),
        ).first()
        if not owned:
            raise HTTPException(status_code=400, detail="Invalid comment target")

    if parent:
        # A reply belongs to the same version as what it answers.
        version_id = parent.version_id
    elif not version_id:
        latest = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset.id,
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status == ProcessingStatus.ready,
        ).order_by(AssetVersion.version_number.desc()).first()
        if latest:
            version_id = latest.id
        else:
            raise HTTPException(status_code=400, detail="No ready version found for this asset")

    # An internal comment is the team's. Only a signed-in caller who would
    # pass the normal asset check may file one here — refused, not silently
    # downgraded to public, because a member who meant "internal" must never
    # discover it was published to the link instead.
    visibility = body.visibility or "public"
    if visibility == "internal":
        if not current_user or not can_access_asset(db, asset, current_user):
            raise HTTPException(
                status_code=403,
                detail="Internal comments require access to the asset",
            )

    # Determine author: logged-in user or guest
    author_id = None
    guest_author_id = None
    if current_user:
        author_id = current_user.id
    else:
        if not body.guest_email or not body.guest_name:
            raise HTTPException(status_code=400, detail="guest_email and guest_name required for anonymous comments")
        guest_email = body.guest_email.lower()
        guest = db.query(GuestUser).filter(GuestUser.email == guest_email).first()
        if not guest:
            guest = GuestUser(email=guest_email, name=body.guest_name)
            db.add(guest)
            db.flush()
        guest_author_id = guest.id

    comment = Comment(
        asset_id=asset.id,
        version_id=version_id,
        parent_id=parent.id if parent else None,
        author_id=author_id,
        guest_author_id=guest_author_id,
        timecode_start=body.timecode_start,
        timecode_end=body.timecode_end,
        body=body.body,
        visibility=visibility,
    )
    db.add(comment)
    db.flush()

    # Mentions, from a link holder. §234 F2 — only a MEMBER of the asset's
    # project is mentioned or notified: a notification carries an asset id,
    # and sending one to someone who cannot open that asset both tells them
    # about work they have no part in and tells the sender that the address
    # they typed belongs to a real account here. Everyone else is ignored in
    # silence — no error, no notification, and no difference in the response.
    for email in set(_parse_mentions(body.body)):
        from ..services.auth_service import get_user_by_email
        user = get_user_by_email(db, email)
        if not user or not get_project_member(db, asset.project_id, user.id):
            continue
        mention = Mention(comment_id=comment.id, mentioned_user_id=user.id)
        db.add(mention)
        if should_create_notification(user, "mentions"):
            db.add(Notification(
                user_id=user.id,
                type=NotificationType.mention,
                asset_id=asset.id,
                comment_id=comment.id,
            ))

    if body.annotation:
        annotation = Annotation(
            comment_id=comment.id,
            drawing_data=body.annotation.drawing_data,
            frame_number=body.annotation.frame_number,
            carousel_position=body.annotation.carousel_position,
        )
        db.add(annotation)

    db.commit()
    db.refresh(comment)

    # Log share link activity. This log is the LINK CREATOR's own view of
    # their link (GET /share/{token}/activity is creator-only), which is why
    # it still records who commented; §234 F2 is about what a link VIEWER
    # sees, and a viewer never reads this.
    actor_email = current_user.email if current_user else (body.guest_email or "anonymous")
    actor_name = current_user.name if current_user else body.guest_name
    activity = ShareLinkActivity(
        share_link_id=link.id,
        action=ShareActivityAction.commented,
        actor_email=actor_email,
        actor_name=actor_name,
        asset_id=asset.id,
        asset_name=asset.name,
    )
    db.add(activity)
    db.commit()

    # The author gets their own comment back in the share shape — no echo
    # carrying the name or e-mail they just typed.
    styles = _share_author_styles(db, link, [comment])
    annotations = _get_annotations_map([comment.id], db)
    return _build_share_comment_response(
        comment,
        link=link,
        styles=styles,
        replies_by_parent={},
        annotations=annotations,
        mention_labels=_share_mention_labels(db, [comment], styles),
    )
