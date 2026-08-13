import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Boolean, Enum, DateTime, ForeignKey, BigInteger, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class ProjectType(str, PyEnum):
    personal = "personal"
    team = "team"

class ProjectRole(str, PyEnum):
    owner = "owner"
    admin = "admin"
    editor = "editor"
    reviewer = "reviewer"
    viewer = "viewer"

class Project(Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    project_type: Mapped[ProjectType] = mapped_column(Enum(ProjectType), default=ProjectType.personal)
    # Historical "who created this" pointer only -- NOT kept in sync with
    # current ownership (see ProjectMember.role == owner, unique per
    # project). Nullable + SET NULL so a deleted creator doesn't block.
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Snapshot of the creator's identity at creation time, so it survives
    # the User row being deleted/deactivated. Set once, never updated.
    created_by_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_by_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    poster_s3_key: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    # Small derivative of the poster (§19c). NULL for posters uploaded
    # before this existed, and for GIFs -- see upload_project_poster for
    # why animated posters deliberately have no thumbnail. Callers fall
    # back to poster_s3_key, so NULL is always safe.
    poster_thumb_s3_key: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    is_public: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    ratings_visible_to_all: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    storage_limit_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    # Human-readable S3 prefix (§14): keys become
    # raw/{storage_date_prefix}_{storage_slug}_{id}/... instead of
    # raw/{id}/... Both NULL until the project's first upload, which sets
    # them together and freezes them -- an in-flight multipart upload's key
    # must not be able to stop matching its project.
    #
    # unique=True is at the DB level on purpose: app-level checking alone
    # loses the race this feature is otherwise careful about, and the whole
    # point of the slug is telling projects apart at a glance.
    storage_slug: Mapped[Optional[str]] = mapped_column(String(40), nullable=True, unique=True)
    # YYMMDD of the FIRST UPLOAD, not of project creation -- a project can
    # sit empty for weeks, so creation date says little about the contents.
    # Also the lock sentinel: the slug may be set by hand well before any
    # upload, this is written only by lock_storage_prefix().
    storage_date_prefix: Mapped[Optional[str]] = mapped_column(String(6), nullable=True)
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    archived_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    @property
    def storage_locked(self) -> bool:
        """Is the S3 prefix frozen? (§14)

        A property rather than something each endpoint sets, because
        ProjectResponse is built in six places and the seventh would have
        forgotten. Pydantic's from_attributes picks it up like a column.
        """
        return self.storage_date_prefix is not None

class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    # CASCADE: a hard-deleted user can't remain "a member" of anything --
    # their membership rows go with them (see user_hard_delete_fk_policy).
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[ProjectRole] = mapped_column(Enum(ProjectRole), default=ProjectRole.viewer)
    invited_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    invited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
