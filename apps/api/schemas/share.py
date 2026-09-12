from pydantic import BaseModel, Field
import uuid
from datetime import datetime
from typing import Optional, Literal
from ..models.share import SharePermission, ShareVisibility, DownloadVariant, FieldsVisibility


def variant_values(variants) -> list[str]:
    """Plain, de-duplicated, canonically-ordered strings for the JSON column.

    The schemas type this field as ``DownloadVariant`` so an unknown key is
    rejected at the boundary rather than persisted as free text. What gets
    STORED, though, must be ordinary strings: the column is JSON, and a list
    whose order or duplicates vary between two links that permit the same
    six things would compare unequal for no real reason.
    """
    seen = {v.value if isinstance(v, DownloadVariant) else str(v) for v in variants}
    return [v.value for v in DownloadVariant if v.value in seen]


class ShareLinkAppearance(BaseModel):
    layout: Literal["grid", "list"] = "grid"
    theme: Literal["dark", "light"] = "dark"
    accent_color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    open_in_viewer: bool = True
    sort_by: Literal["name", "created_at", "file_size"] = "created_at"
    card_size: Literal["s", "m", "l"] = "m"
    aspect_ratio: Literal["landscape", "square", "portrait"] = "landscape"
    thumbnail_scale: Literal["fit", "fill"] = "fill"
    show_card_info: bool = True


class ShareLinkCreate(BaseModel):
    permission: SharePermission = SharePermission.view
    visibility: str = "public"
    expires_at: Optional[datetime] = None
    password: Optional[str] = None
    allowed_download_variants: list[DownloadVariant] = []
    fields_visibility: FieldsVisibility = FieldsVisibility.disabled
    title: Optional[str] = None
    description: Optional[str] = None
    show_versions: bool = True
    show_watermark: bool = False
    appearance: ShareLinkAppearance = ShareLinkAppearance()


class MultiShareCreate(BaseModel):
    asset_ids: list[uuid.UUID] = []
    folder_ids: list[uuid.UUID] = []
    title: Optional[str] = None
    permission: SharePermission = SharePermission.view
    visibility: str = "public"
    expires_at: Optional[datetime] = None
    password: Optional[str] = None
    allowed_download_variants: list[DownloadVariant] = []
    fields_visibility: FieldsVisibility = FieldsVisibility.disabled
    show_versions: bool = True
    show_watermark: bool = False
    appearance: ShareLinkAppearance = ShareLinkAppearance()


class ShareLinkResponse(BaseModel):
    id: uuid.UUID
    asset_id: Optional[uuid.UUID] = None
    folder_id: Optional[uuid.UUID] = None
    project_id: Optional[uuid.UUID] = None
    token: str
    title: str
    description: Optional[str] = None
    is_enabled: bool
    permission: SharePermission
    visibility: str = "public"
    allowed_download_variants: list[DownloadVariant] = []
    fields_visibility: FieldsVisibility = FieldsVisibility.disabled
    show_versions: bool
    show_watermark: bool
    appearance: dict
    expires_at: Optional[datetime] = None
    created_at: datetime
    has_password: bool = False
    password_value: Optional[str] = None  # Decrypted password for admin display only
    model_config = {"from_attributes": True}


class ShareLinkValidateResponse(BaseModel):
    asset_id: Optional[uuid.UUID] = None
    folder_id: Optional[uuid.UUID] = None
    project_id: Optional[uuid.UUID] = None
    folder_name: Optional[str] = None
    project_name: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    permission: SharePermission = SharePermission.view
    allowed_download_variants: list[DownloadVariant] = []
    fields_visibility: FieldsVisibility = FieldsVisibility.disabled
    show_versions: bool = True
    show_watermark: bool = False
    appearance: Optional[dict] = None
    visibility: str = "public"
    requires_password: bool
    requires_auth: bool = False  # True when visibility=secure and user not authenticated
    created_by_name: Optional[str] = None
    viewer_name: Optional[str] = None  # Logged-in user's name (if authenticated)
    viewer_email: Optional[str] = None  # Logged-in user's email (if authenticated)
    asset: Optional[dict] = None  # Full asset details for asset shares
    branding: Optional[dict] = None  # Project branding info
    share_session: Optional[str] = None  # Session token for password-protected links


class ShareLinkUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    permission: Optional[SharePermission] = None
    visibility: Optional[str] = None
    is_enabled: Optional[bool] = None
    show_versions: Optional[bool] = None
    show_watermark: Optional[bool] = None
    appearance: Optional[ShareLinkAppearance] = None
    password: Optional[str] = None
    expires_at: Optional[datetime] = None
    allowed_download_variants: Optional[list[DownloadVariant]] = None
    fields_visibility: Optional[FieldsVisibility] = None


class ShareLinkListItem(BaseModel):
    id: uuid.UUID
    token: str
    title: str
    description: Optional[str] = None
    is_enabled: bool
    permission: SharePermission
    share_type: str
    target_name: str
    view_count: int = 0
    last_viewed_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class ShareLinkActivityResponse(BaseModel):
    id: uuid.UUID
    share_link_id: uuid.UUID
    action: str
    actor_email: str
    actor_name: Optional[str] = None
    asset_id: Optional[uuid.UUID] = None
    asset_name: Optional[str] = None
    created_at: datetime
    model_config = {"from_attributes": True}


class FolderShareAssetItem(BaseModel):
    id: uuid.UUID
    name: str
    asset_type: str
    thumbnail_url: Optional[str] = None
    file_size: Optional[int] = None
    duration_seconds: Optional[float] = None
    comment_count: int = 0
    created_by_name: Optional[str] = None
    created_at: datetime
    #: Which of the link's permitted variants apply to THIS asset (§30).
    download_variants: list[DownloadVariant] = []


class FolderShareSubfolder(BaseModel):
    id: uuid.UUID
    name: str
    item_count: int = 0
    thumbnail_urls: list[str] = []


class FolderShareAssetsResponse(BaseModel):
    assets: list[FolderShareAssetItem]
    subfolders: list[FolderShareSubfolder]
    #: Assets in this folder that the viewer may see — the whole link, not
    #: just the page in `assets`.
    total: int
    #: Bytes across all `total` assets, not just the loaded page. Defaults to
    #: 0 so an older client (or a cached response) reads "unknown" as zero
    #: rather than failing validation.
    total_size_bytes: int = 0
    page: int
    per_page: int


class ZipExportItem(BaseModel):
    """One file a batch download should contain."""

    asset_id: uuid.UUID
    #: Omit for "the latest ready version", which is what the UI sends when
    #: the viewer has not touched that file's version selector (§143.1).
    version_id: Optional[uuid.UUID] = None


#: What SHAPE of selection this batch is (§175, widened in §177). Carried
#: explicitly rather than inferred from item-count vs total-asset-count,
#: because those are indistinguishable for a link holding exactly one asset:
#: "all of it" and "the one I selected" are the same count. It is also the
#: only thing that survives the frontend flattening a folder click into a
#: bare list of asset ids — folder identity is gone by the time the request
#: is built, so the shape has to be stated, not reconstructed.
#:
#: - "all"              -> the whole scope, nothing excluded
#: - "selected"         -> loose files, or files mixed with folders
#: - "single_folder"    -> exactly one folder and nothing else
#: - "multiple_folders" -> two or more folders and no loose files
#:
#: "selection" is §175's original spelling of "selected", kept ACCEPTED (and
#: normalised away on arrival) rather than removed: a browser tab open across
#: the deploy still holds the old bundle, and rejecting its scope would turn
#: a rename into a failed download.
ZipScope = Literal["all", "selected", "single_folder", "multiple_folders", "selection"]

#: The scope a caller that says nothing gets. Labelling a partial archive
#: `{link}.zip` claims a completeness nothing verified; labelling a complete
#: one `{link}_Selected.zip` is merely less specific, so the default is the
#: second.
DEFAULT_ZIP_SCOPE = "selected"


class ZipExportRequest(BaseModel):
    items: list[ZipExportItem]
    #: One choice for the whole batch. Only variants backed by a stored
    #: object are accepted — a batch never triggers a render (§143 scope).
    variant: DownloadVariant = DownloadVariant.raw
    #: Only affects the download's FILENAME, never its contents.
    #:
    #: Defaults to "selected" on purpose: a caller that does not say cannot
    #: have its archive labelled as complete. Naming a partial archive
    #: `{link}.zip` would claim a completeness nothing verified, while naming
    #: a complete one `{link}_Selected.zip` is merely less specific.
    scope: ZipScope = DEFAULT_ZIP_SCOPE
    #: The folder's own name, for `scope="single_folder"` only — it is what
    #: `{base}_{FolderName}.zip` is built from. Sent by the client because
    #: the server never sees a folder id here: the selection arrives already
    #: flattened to asset ids. Ignored for every other scope.
    folder_name: Optional[str] = None


class ZipExportFile(BaseModel):
    asset_id: uuid.UUID
    asset_name: str
    #: Where this file sits inside the archive, folders included.
    path: str
    version_id: uuid.UUID
    variant: str
    #: Why this file is not the variant the batch asked for, when it isn't.
    #: Shown per file rather than substituted silently (§143.2).
    fallback_reason: Optional[str] = None
    #: Set only if the build could not read the file at all.
    skipped: Optional[str] = None


class ZipExportStatusResponse(BaseModel):
    export_id: uuid.UUID
    status: str
    #: True when a prior identical request already built this archive.
    reused: bool = False
    ready: bool = False
    url: Optional[str] = None
    file_count: int = 0
    files_done: int = 0
    total_bytes: int = 0
    #: Which half of the build is running: "gathering", "uploading", or null
    #: once it is neither (§147). Before this, a large build showed a full
    #: file bar for the entire upload, which is the longer half.
    phase: Optional[str] = None
    #: Bytes of the finished archive already sent to storage. Only meaningful
    #: while `phase == "uploading"`.
    bytes_done: int = 0
    error: Optional[str] = None
    files: list[ZipExportFile] = []


class ZipExportVersionOption(BaseModel):
    version_id: uuid.UUID
    version_number: int
    created_at: Optional[datetime] = None
    is_latest: bool = False


class ZipExportAssetOptions(BaseModel):
    asset_id: uuid.UUID
    asset_name: str
    #: Empty when the viewer gets no choice — either the asset has a single
    #: version, or the link has `show_versions` off. The UI hides the
    #: selector in both cases (§143's "collapsed if only one version").
    versions: list[ZipExportVersionOption] = []


class ZipExportOptionsResponse(BaseModel):
    """What the batch picker may offer for a given selection."""

    variants: list[DownloadVariant] = []
    assets: list[ZipExportAssetOptions] = []


class DirectShareCreate(BaseModel):
    permission: SharePermission = SharePermission.view
    user_id: Optional[uuid.UUID] = None
    team_id: Optional[uuid.UUID] = None
    email: Optional[str] = None  # Alternative to user_id — invite by email
    share_token: Optional[str] = None  # If sharing from a share link context, include token for email link


class DirectShareResponse(BaseModel):
    id: uuid.UUID
    asset_id: Optional[uuid.UUID] = None
    folder_id: Optional[uuid.UUID] = None
    shared_with_user_id: Optional[uuid.UUID]
    shared_with_team_id: Optional[uuid.UUID]
    permission: SharePermission
    created_at: datetime
    model_config = {"from_attributes": True}


class ShareFieldsResponse(BaseModel):
    """Asset metadata for a share-link viewer (§33).

    One route serves both levels: the `basic` keys are always present, and
    the two `full`-only keys are None unless the link permits them. That
    keeps "how much is visible" a single server-side decision rather than
    something each client re-derives.
    """

    level: FieldsVisibility
    name: str
    asset_type: str
    description: Optional[str] = None
    rating: Optional[int] = None
    due_date: Optional[datetime] = None
    keywords: list[str] = []
    #: full only — ffprobe/exiftool output for the primary media file.
    technical_metadata: Optional[dict] = None
    #: full only — parsed camera sidecar files (§20/§23).
    sidecars: Optional[list[dict]] = None
