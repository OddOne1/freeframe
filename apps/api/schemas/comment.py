from pydantic import BaseModel, field_validator
import uuid
from datetime import datetime
from typing import Literal, Optional

from ..services.owned_keys import issued_avatar_url

class AnnotationData(BaseModel):
    drawing_data: dict  # Fabric.js canvas JSON
    frame_number: Optional[int] = None
    carousel_position: Optional[int] = None

class CommentCreate(BaseModel):
    version_id: uuid.UUID
    parent_id: Optional[uuid.UUID] = None
    timecode_start: Optional[float] = None
    timecode_end: Optional[float] = None
    body: str
    visibility: Optional[str] = "public"  # "public" or "internal"
    annotation: Optional[AnnotationData] = None
    mention_user_ids: list[uuid.UUID] = []  # Explicit mention IDs from frontend

class GuestCommentCreate(BaseModel):
    asset_id: Optional[uuid.UUID] = None  # Required for folder/project shares
    version_id: Optional[uuid.UUID] = None  # Auto-resolved if not provided
    parent_id: Optional[uuid.UUID] = None
    timecode_start: Optional[float] = None
    timecode_end: Optional[float] = None
    body: str
    annotation: Optional[AnnotationData] = None
    guest_email: Optional[str] = None  # Not needed if user is logged in
    guest_name: Optional[str] = None
    #: §234 B — accepted, and `internal` is REFUSED (403) unless the caller
    #: is signed in and passes the normal asset access check. The field used
    #: to be absent, so a project member commenting through a share link
    #: could not file an internal note at all; it is not a way for a guest
    #: to write one. Typed, so an unknown string is a 422 rather than a
    #: silently stored value.
    visibility: Literal["public", "internal"] = "public"

class CommentUpdate(BaseModel):
    body: str

class AnnotationResponse(BaseModel):
    id: uuid.UUID
    comment_id: uuid.UUID
    drawing_data: dict
    frame_number: Optional[int]
    carousel_position: Optional[int]
    model_config = {"from_attributes": True}

# ── Attachments ────────────────────────────────────────────────────────────────

class AttachmentUploadRequest(BaseModel):
    file_name: str
    file_size: int
    content_type: str

class AttachmentUploadResponse(BaseModel):
    upload_url: str
    attachment_id: uuid.UUID
    key: str

class AttachmentResponse(BaseModel):
    id: uuid.UUID
    file_name: str
    file_size: int
    content_type: str
    url: str  # presigned S3 GET URL, generated at response time

# ── Reactions ──────────────────────────────────────────────────────────────────

class ReactionCreate(BaseModel):
    emoji: str

    @field_validator("emoji")
    @classmethod
    def emoji_max_length(cls, v: str) -> str:
        if len(v) > 10:
            raise ValueError("emoji must be at most 10 characters")
        return v

class ReactionResponse(BaseModel):
    emoji: str
    count: int
    reacted: bool  # whether the current user has reacted with this emoji

# ── Author info ────────────────────────────────────────────────────────────────

class AuthorInfo(BaseModel):
    id: uuid.UUID
    name: str
    avatar_url: Optional[str] = None

    @field_validator("avatar_url", mode="before")
    @classmethod
    def _only_an_avatar_this_server_issued(cls, v):
        """§235 — same rule as schemas/auth.py::UserResponse: a value the
        avatar upload route did not mint is not shown. Comment authors are
        the widest audience an avatar reaches — every reviewer on a share
        link sees them."""
        return issued_avatar_url(v)

class GuestAuthorInfo(BaseModel):
    id: uuid.UUID
    name: str
    email: str

# ── Comments ───────────────────────────────────────────────────────────────────

class CommentResponse(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    version_id: uuid.UUID
    parent_id: Optional[uuid.UUID]
    author_id: Optional[uuid.UUID]
    author_name: Optional[str] = None
    guest_author_id: Optional[uuid.UUID]
    timecode_start: Optional[float]
    timecode_end: Optional[float]
    body: str
    resolved: bool
    visibility: str = "public"
    created_at: datetime
    updated_at: datetime
    author: Optional[AuthorInfo] = None
    guest_author: Optional[GuestAuthorInfo] = None
    annotation: Optional[AnnotationResponse] = None
    replies: list["CommentResponse"] = []
    attachments: list[AttachmentResponse] = []
    reactions: list[ReactionResponse] = []
    model_config = {"from_attributes": True}

CommentResponse.model_rebuild()


# ── What a share-link viewer gets (§234 F2) ───────────────────────────────────

class ShareCommentResponse(BaseModel):
    """A comment as an anonymous share-link holder may see it.

    A SEPARATE model, not `CommentResponse` with the identity stripped off
    at the route. The difference matters the day someone adds a field to
    `CommentResponse`: an allowlist cannot start leaking by itself, while a
    strip-list leaks everything nobody remembered to add to it.
    `CommentResponse` carries `author_id`, `author_name`, `guest_author_id`,
    an `author` object (id, name, avatar_url) and a `guest_author` object
    (id, name, e-mail) — all of which a share viewer may never see.

    Every field here is deliberate; tests/test_share_comment_identity.py
    fails if this model grows one that is not on the list. `author_label`,
    `author_initials` and `author_color` are built by
    services/share_identity.py and are the ONLY things said about a person.

    §234b removed `visibility` from this list. A share link never returns a
    comment whose visibility is "internal" — there is no option any more —
    so the field could only ever carry the one value "public", which says
    nothing and invites a page to branch on it.
    """

    id: uuid.UUID
    parent_id: Optional[uuid.UUID] = None
    version_id: uuid.UUID
    timecode_start: Optional[float] = None
    timecode_end: Optional[float] = None
    body: str
    created_at: datetime
    updated_at: datetime
    #: The drawing itself, which the share page needs to render an
    #: annotation over the frame. `AnnotationResponse` is (id, comment_id,
    #: drawing_data, frame_number, carousel_position) — no identity.
    annotation: Optional[AnnotationResponse] = None
    author_label: str
    #: §234b — always the initials, on both link types; equal to
    #: `author_label` on a link with no password. The share page paints the
    #: avatar chip with this and puts `author_label` next to it only when
    #: the two differ, so a password link reads "MS Mathias" and an open one
    #: just "MS".
    author_initials: str
    author_color: str
    replies: list["ShareCommentResponse"] = []

ShareCommentResponse.model_rebuild()
