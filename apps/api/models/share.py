import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, ForeignKey, Boolean, func, Text, Index, JSON, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class SharePermission(str, PyEnum):
    view = "view"
    comment = "comment"
    approve = "approve"

class ShareVisibility(str, PyEnum):
    public = "public"
    secure = "secure"

class DownloadVariant(str, PyEnum):
    """Which rendering of an asset a download produces (CLAUDE.md §30/§30b).

    Six, not four: proxy resolution is the user's choice, and both rungs
    already exist in the transcode quality ladder, so exposing both costs
    no new encode settings.

    Stored as a list of these on a share link. An EMPTY list is the exact
    equivalent of the old `allow_download: False` — downloading genuinely
    unavailable, not merely hidden.
    """

    raw = "raw"
    raw_lut = "raw_lut"
    proxy_720p = "proxy_720p"
    proxy_720p_lut = "proxy_720p_lut"
    proxy_1080p = "proxy_1080p"
    proxy_1080p_lut = "proxy_1080p_lut"


#: What the legacy `allow_download: True` becomes. Every existing link
#: could download the original, and nothing restricted it further, so the
#: faithful translation is "all of them".
ALL_DOWNLOAD_VARIANTS: list[str] = [v.value for v in DownloadVariant]

#: Which variants burn a LUT, and which proxy rung each maps to. Kept
#: beside the enum so the export task and the permission checks read the
#: same table rather than re-deriving it from string suffixes.
VARIANT_USES_LUT: dict[str, bool] = {
    DownloadVariant.raw: False,
    DownloadVariant.raw_lut: True,
    DownloadVariant.proxy_720p: False,
    DownloadVariant.proxy_720p_lut: True,
    DownloadVariant.proxy_1080p: False,
    DownloadVariant.proxy_1080p_lut: True,
}

#: None means "no scaling" — the raw variants are the source resolution.
VARIANT_QUALITY: dict[str, str | None] = {
    DownloadVariant.raw: None,
    DownloadVariant.raw_lut: None,
    DownloadVariant.proxy_720p: "720p",
    DownloadVariant.proxy_720p_lut: "720p",
    DownloadVariant.proxy_1080p: "1080p",
    DownloadVariant.proxy_1080p_lut: "1080p",
}


class ShareLink(Base):
    __tablename__ = "share_links"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=True, index=True)
    folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True, index=True)
    project_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=True, index=True)
    token: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False, server_default="")
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    password_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    password_encrypted: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    permission: Mapped[SharePermission] = mapped_column(Enum(SharePermission), default=SharePermission.view)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, server_default="public")
    # §30 — replaces `allow_download: bool`. A list rather than six
    # columns: an empty list is an unambiguous "none", membership is the
    # whole server-side gate, and a seventh variant later needs no
    # migration. Validated by a Pydantic enum at the schema boundary, so it
    # cannot become a free-text field. Mirrors `appearance` below: a
    # structured JSON column with a typed model in front of it.
    allowed_download_variants: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default="[]"
    )
    show_versions: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    show_watermark: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    appearance: Mapped[dict] = mapped_column(JSON, nullable=False, server_default='{"layout":"grid","theme":"dark","accent_color":null,"open_in_viewer":true,"sort_by":"created_at"}')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(asset_id IS NOT NULL AND folder_id IS NULL) "
            "OR (folder_id IS NOT NULL AND asset_id IS NULL) "
            "OR (project_id IS NOT NULL AND asset_id IS NULL AND folder_id IS NULL)",
            name="ck_share_link_type"
        ),
    )

class ShareLinkItem(Base):
    __tablename__ = "share_link_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    share_link_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("share_links.id"), nullable=False, index=True)
    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=True)
    folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(asset_id IS NOT NULL AND folder_id IS NULL) OR (asset_id IS NULL AND folder_id IS NOT NULL)",
            name="ck_share_link_item_asset_or_folder"
        ),
    )


class AssetShare(Base):
    __tablename__ = "asset_shares"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=True, index=True)
    folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True, index=True)
    # CASCADE: a direct share to a since-deleted user is meaningless -- the
    # grant goes with them, rather than surviving as a share to no one.
    shared_with_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    shared_with_team_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    permission: Mapped[SharePermission] = mapped_column(Enum(SharePermission), default=SharePermission.view)
    shared_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(asset_id IS NOT NULL AND folder_id IS NULL) OR (asset_id IS NULL AND folder_id IS NOT NULL)",
            name="ck_asset_share_asset_or_folder"
        ),
    )

class ShareActivityAction(str, PyEnum):
    opened = "opened"
    viewed_asset = "viewed_asset"
    commented = "commented"
    approved = "approved"
    rejected = "rejected"
    downloaded = "downloaded"

class ShareLinkActivity(Base):
    __tablename__ = "share_link_activity"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    share_link_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("share_links.id"), nullable=False, index=True)
    action: Mapped[ShareActivityAction] = mapped_column(Enum(ShareActivityAction), nullable=False)
    actor_email: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    asset_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_share_activity_link_created", "share_link_id", created_at.desc()),
    )
