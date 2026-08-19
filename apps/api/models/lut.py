"""Color LUTs (.cube), owned personally and shareable into projects.

Ownership is deliberately *personal-plus-shareable* rather than
project-scoped: a LUT belongs to the user who uploaded it and follows them
across every project they touch, and separately can be explicitly shared
into one project so that team can use it too. Hence two tables — a
project-scoped single table cannot express "my library, everywhere I go."
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, String, DateTime, ForeignKey, Integer, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class LutGroup(Base):
    """A folder for organizing a LUT library.

    **Exactly one level of nesting** (§45). A Main group (parent_group_id
    NULL) may hold Sub groups; a Sub group may not hold anything further.
    This was the "cheap column later" the original flat design anticipated,
    and the depth cap is enforced in routers/luts.py rather than by the
    schema -- Postgres cannot express "at most one level" on a
    self-referential FK.

    Two kinds, split by `is_platform` (§39):

    * personal (the default) -- owned by one user, listed only for them.
    * platform -- one shared set, listed identically for everyone and
      editable by any superadmin. `owner_id` still records who created it;
      it is not who may change it.

    The split mirrors Lut.is_platform_wide below rather than inventing a
    second mechanism: a flag alongside unchanged ownership, not a transfer
    and not a nullable owner. Keeping owner_id NOT NULL also means no
    existing query or FK had to be revisited.

    A LUT and its group must agree on that flag -- a platform LUT belongs
    to a platform group, a personal LUT to a personal one -- enforced in
    routers/luts.py::update_lut. That narrows this docstring's original
    claim that groups are entirely orthogonal to visibility: filing a
    platform-wide LUT under a personal group is no longer allowed. It was
    never actually reachable, since the Settings page lists a platform LUT
    only in the Platform section and never under the personal group its
    group_id pointed at.
    """
    __tablename__ = "lut_groups"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Shared/global rather than one user's. Any superadmin may create,
    # rename, delete and file into these; every user can see them.
    is_platform: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # NULL = a top-level Main group. SET NULL rather than CASCADE so
    # deleting a Main group promotes its Sub groups to top level instead of
    # taking them and their LUTs with it -- matching how Lut.group_id
    # already refuses to let a deleted group delete its members.
    parent_group_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("lut_groups.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class Lut(Base):
    """One uploaded .cube file in a user's personal library.

    Modeled on Collection (models/metadata.py) — the closest existing
    "small named user-owned thing" — but keyed to a user rather than a
    project.
    """
    __tablename__ = "luts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # CASCADE, not SET NULL: a personal library has no meaning without its
    # owner, and unlike an asset or a comment nobody else has built on top
    # of it. (Spec flagged this as worth confirming — see the report.)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    s3_key: Mapped[str] = mapped_column(String(1000), nullable=False)
    # Parsed out of the .cube header at upload time so the picker can warn
    # about unusually large LUTs without fetching the file itself.
    lut_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Third visibility tier, beyond personal-only and per-project-shared:
    # usable by every user in every project with no ProjectLutShare row at
    # all. Ownership is unchanged -- this is a visibility flag, not a
    # transfer -- and only a superadmin may set it (enforced in
    # routers/luts.py, not just hidden in the UI).
    is_platform_wide: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # At most one group, or none. SET NULL so deleting a group ungroups its
    # LUTs rather than taking them with it.
    group_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("lut_groups.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class ProjectLutShare(Base):
    """Makes one personal Lut visible to everyone on one project.

    Mirrors the ShareLinkItem join-table shape already in this codebase
    rather than inventing a new one. Deleting a row here unshares the LUT;
    it never touches the underlying Lut.
    """
    __tablename__ = "project_lut_shares"
    __table_args__ = (
        UniqueConstraint("project_id", "lut_id", name="uq_project_lut_shares_project_lut"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True
    )
    lut_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("luts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    shared_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
