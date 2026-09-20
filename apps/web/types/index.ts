// ─── Enums ───────────────────────────────────────────────────────────────────

export type AssetType = "image" | "image_carousel" | "audio" | "video";

export type AssetStatus = "draft" | "in_review" | "in_progress" | "approved" | "rejected" | "archived";

export type AssetVersionStatus = "uploading" | "processing" | "ready" | "failed";

export type OrgRole = "owner" | "admin" | "member";

export type TeamRole = "lead" | "member";

export type ProjectRole = "owner" | "admin" | "editor" | "reviewer" | "viewer";

export type UserGlobalRole = "superadmin" | "superuser" | "user";

export type ProjectType = "personal" | "team";

export type SharePermission = "view" | "comment" | "approve";

export type NotificationType = "mention" | "assignment" | "due_soon" | "comment" | "approval" | "new_version";

export type UserStatus = "active" | "deactivated" | "pending_invite" | "pending_verification";

export type ActivityAction =
  | "created"
  | "commented"
  | "mentioned"
  | "shared"
  | "assigned"
  | "approved"
  | "rejected";

export type FileType = "image" | "audio" | "video" | "document";

export type MetadataFieldType = "text" | "number" | "date" | "select" | "multi_select";

export type WatermarkPosition = "center" | "corner" | "tiled";

export type WatermarkContent = "email" | "name" | "custom_text";

export type ViewerLayout = "grid" | "reel";

export type ApprovalStatus = "approved" | "rejected" | "pending";

// ─── Core Entities ────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  first_name: string | null;
  last_name: string;
  avatar_url: string | null;
  status: UserStatus;
  role: UserGlobalRole;
  email_verified: boolean;
  invite_token?: string | null;
  preferences: Record<string, unknown>;
  created_at: string;
  deleted_at: string | null;
  storage_limit_bytes?: number | null;
  /** §197 — the user's own second-factor state, as /auth/me reports it.
   *  Read-only: enrolling and disabling go through /auth/2fa/*, which is
   *  where the proofs those actions require are enforced. Optional so an
   *  older cached /auth/me response still validates. */
  two_factor_enabled?: boolean;
  two_factor_method?: TwoFactorMethod | null;
  /** §200 — the onboarding gate, as /auth/me reports it.
   *
   *  Both are DERIVED server-side from the stored data, never from anything
   *  this app remembers, which is why the gate can be trusted: it disappears
   *  the moment the data is real and comes back if the data is cleared.
   *  Rendering the gate from these is presentation only — every protected
   *  route returns 403 `account_setup_required` on its own, so a client that
   *  ignored them would simply be a client that cannot load anything.
   *
   *  Optional so an older cached /auth/me response still validates. Absent is
   *  read as "not gated" at the call sites, matching the server's own
   *  behaviour for a row that predates the columns. */
  must_set_password?: boolean;
  backup_email_state?: BackupEmailState;
  /** The address itself, so the gate and settings can show what is on file.
   *  Only ever returned to the account's own session. */
  backup_email?: string | null;
}

export interface Team {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  added_at: string;
  deleted_at: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  // Historical creator pointer -- null once the creator has been hard-deleted
  // (see backend task 1); created_by_name/email are the resilient display
  // fields, not currently returned by this endpoint.
  created_by: string | null;
  org_id?: string;
  project_type: ProjectType;
  team_id?: string | null;
  poster_url?: string | null;
  // Small variant of the poster (§19c). Additive: poster_url still means
  // the full-size original. Falls back to the original server-side when no
  // thumbnail exists, so this is safe to use unconditionally wherever a
  // poster renders small.
  poster_thumb_url?: string | null;
  is_public?: boolean;
  created_at: string;
  deleted_at: string | null;
  asset_count?: number;
  storage_bytes?: number;
  storage_limit_bytes?: number | null;
  member_count?: number;
  role?: string | null;
  // §14 — the human-readable S3 prefix. Both null until the project's
  // first upload, which freezes them; `storage_locked` is the server's
  // own verdict rather than a rule the client re-derives.
  storage_slug?: string | null;
  storage_date_prefix?: string | null;
  storage_locked?: boolean;
  archived_at?: string | null;
  archived_by?: string | null;
  archived_by_is_superadmin?: boolean;
  ratings_visible_to_all?: boolean;
  /** §127 — what a NEW file's transcription toggle starts as in this
   *  project. null = never chosen, which falls through to the app default. */
  transcription_default?: boolean | null;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  invited_by: string | null;
  invited_at: string | null;
  deleted_at: string | null;
}

// ─── Admin (superadmin-only dashboards) ────────────────────────────────────

export interface AdminUserProjectSummary {
  project_id: string;
  project_name: string;
  role: ProjectRole;
}

export interface AdminUser extends User {
  projects: AdminUserProjectSummary[];
}

export interface PurgeUserOwnerCandidate {
  id: string;
  name: string;
  email: string;
}

export interface PurgeUserOwnedProject {
  project_id: string;
  project_name: string;
  candidates: PurgeUserOwnerCandidate[];
}

export interface PurgeUserPreviewResponse {
  owned_projects: PurgeUserOwnedProject[];
}

export interface AdminProject extends Project {
  owner_name: string | null;
  owner_email: string | null;
  current_user_role?: string | null;
}

// ─── Asset & Media Entities ───────────────────────────────────────────────────

export interface Asset {
  /** §108 — more than one version exists and this user has not opened the
   *  newest. Absent for anonymous callers, who have no seen-state. */
  has_unseen_version?: boolean;
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  asset_type: AssetType;
  status: AssetStatus;
  rating: number | null;
  assignee_id: string | null;
  folder_id: string | null;
  due_date: string | null;
  keywords: string[];
  /** The LUT the whole team sees on this shot. A LUT previewed locally but
   *  never shared into the project is deliberately NOT written here. */
  applied_lut_id?: string | null;
  // Null once the creator has been hard-deleted -- created_by_name is a
  // frozen snapshot from creation time, survives that.
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  avg_rating?: number | null;
  rating_count?: number;
  my_rating?: number | null;
}

export interface AssetVersion {
  id: string;
  asset_id: string;
  version_number: number;
  processing_status: AssetVersionStatus;
  /** §113 — 0-100 while processing, 100 when ready. Null when no progress was
   *  ever reported (an image, or a job not yet started) — distinct from 0,
   *  which means a running job that has not advanced. */
  processing_progress?: number | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  deleted_at: string | null;
  files?: MediaFile[];
}

/** Backend returns AssetResponse with latest_version embedded */
export interface AssetResponse extends Asset {
  latest_version: AssetVersion | null;
  /** §108 — more than one version exists and this user has not opened the newest. */
  has_unseen_version?: boolean;
  thumbnail_url: string | null;
}

/** Subset of ffprobe fields captured by parse_ffprobe_metadata() (packages/transcoder/base.py).
 *  Keys are simply omitted server-side when ffprobe doesn't report them, so every field here
 *  is optional rather than nullable. */
export interface TechnicalMetadata {
  video_codec?: string;
  video_bit_rate?: number;
  visual_bit_depth?: number;
  alpha_channel?: boolean;
  color_space?: string;
  dynamic_range?: string;
  // Raw values behind the HDR/SDR bucket above -- a colorist wants to know
  // it's specifically "smpte2084"/"bt2020", not just "HDR". Added 2026-07-30.
  color_transfer?: string;
  color_primaries?: string;
  video_codec_profile?: string;
  video_codec_level?: number;
  field_order?: string;
  display_aspect_ratio?: string;
  timecode?: string;
  rotation?: number;
  // Only populated when the source container carries these tags (most
  // reliable on QuickTime/MOV) -- not guaranteed for camera-native raw
  // formats (R3D/BRAW/ARRIRAW), which generic ffprobe parsing often can't
  // reach at all.
  camera_make?: string;
  camera_model?: string;
  creation_time?: string;
  encoder?: string;
  audio_codec?: string;
  audio_bit_rate?: number;
  audio_bit_depth?: number;
  audio_channels?: number;
  audio_sample_rate?: number;

  // ── EXIF pass (exiftool) ──
  // Captured by packages/transcoder/base.py::parse_exiftool_metadata.
  // The five *_hidden-by-omission fields below (ycbcr_positioning,
  // components_configuration, exif_version, interoperability_index,
  // interoperability_version) plus GPS are stored but deliberately left out
  // of TECHNICAL_METADATA_FIELDS, so they are typed here but never rendered.
  software?: string;
  exif_orientation?: string;
  date_time?: string;
  date_time_original?: string;
  date_time_digitized?: string;
  ycbcr_positioning?: string;
  compression?: string;
  x_resolution?: number | string;
  y_resolution?: number | string;
  resolution_unit?: string;
  exposure_time?: string | number;
  f_number?: number | string;
  exposure_program?: string;
  exif_version?: string;
  components_configuration?: string;
  compressed_bits_per_pixel?: number | string;
  exposure_bias?: number | string;
  max_aperture_value?: number | string;
  metering_mode?: string;
  flash?: string;
  focal_length?: string | number;
  flashpix_version?: string;
  exif_color_space?: string;
  file_source?: string;
  interoperability_index?: string;
  interoperability_version?: string;
  gps_latitude?: string | number;
  gps_longitude?: string | number;
  gps_altitude?: string | number;
  // Manufacturer-decoded MakerNote tags arrive under snake_cased names that
  // vary by camera (white_balance, lens_model, iso, af_points_in_focus...).
  // They are stored and typed loosely; only whitelisted keys render.
  [key: string]: unknown;
}

export interface MediaFile {
  id: string;
  version_id: string;
  file_type: FileType;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  s3_key_raw: string | null;
  s3_key_processed: string | null;
  s3_key_thumbnail: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  fps: number | null;
  sequence_order: number | null;
  technical_metadata: TechnicalMetadata | null;
  created_at: string;
}

export interface CarouselItem {
  id: string;
  version_id: string;
  media_file_id: string;
  position: number;
}

// ─── Comments & Annotations ───────────────────────────────────────────────────

export interface GuestUser {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

export interface CommentAuthor {
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface GuestAuthor {
  id: string;
  name: string;
  email?: string;
}

export interface Comment {
  id: string;
  asset_id: string;
  version_id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name?: string | null;
  guest_author_id: string | null;
  timecode_start: number | null;
  timecode_end: number | null;
  body: string;
  resolved: boolean;
  visibility: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  author?: CommentAuthor | null;
  guest_author?: GuestAuthor | null;
}

export interface Annotation {
  id: string;
  comment_id: string;
  drawing_data: Record<string, unknown>;
  frame_number: number | null;
  carousel_position: number | null;
}

export interface CommentAttachment {
  id: string;
  comment_id: string;
  file_type: FileType;
  s3_key: string;
  original_filename: string;
  file_size_bytes: number;
  created_at: string;
}

export interface CommentReaction {
  id: string;
  comment_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

// ─── Approvals & Sharing ──────────────────────────────────────────────────────

export interface Approval {
  id: string;
  asset_id: string;
  version_id: string;
  user_id: string;
  status: ApprovalStatus;
  note: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface ShareLinkAppearance {
  layout: "grid" | "list"
  theme: "dark" | "light"
  accent_color: string | null
  open_in_viewer: boolean
  sort_by: "name" | "created_at" | "file_size"
  card_size: "s" | "m" | "l"
  aspect_ratio: "landscape" | "square" | "portrait"
  thumbnail_scale: "fit" | "fill"
  show_card_info: boolean
}

/**
 * Which rendering of an asset a download produces (CLAUDE.md §30/§30b).
 * Mirrors `DownloadVariant` in apps/api/models/share.py — these strings
 * are the wire format, so the two lists must stay identical.
 */
export type DownloadVariant =
  | "raw"
  | "raw_lut"
  | "proxy_720p"
  | "proxy_720p_lut"
  | "proxy_1080p"
  | "proxy_1080p_lut";

/**
 * How much asset metadata a share link exposes (CLAUDE.md §33).
 * Mirrors `FieldsVisibility` in apps/api/models/share.py.
 */
export type FieldsVisibility = "disabled" | "basic" | "full";

/** Canonical order, used for both display and the all-on shorthand. */
export const ALL_DOWNLOAD_VARIANTS: DownloadVariant[] = [
  "raw",
  "raw_lut",
  "proxy_720p",
  "proxy_720p_lut",
  "proxy_1080p",
  "proxy_1080p_lut",
];

/** Human labels, in one place so the modal and the settings panels agree. */
export const DOWNLOAD_VARIANT_LABELS: Record<DownloadVariant, string> = {
  raw: "Original",
  raw_lut: "Original + LUT",
  proxy_720p: "Proxy 720p",
  proxy_720p_lut: "Proxy 720p + LUT",
  proxy_1080p: "Proxy 1080p",
  proxy_1080p_lut: "Proxy 1080p + LUT",
};

/** True when the variant burns in the asset's LUT. */
export const VARIANT_USES_LUT: Record<DownloadVariant, boolean> = {
  raw: false,
  raw_lut: true,
  proxy_720p: false,
  proxy_720p_lut: true,
  proxy_1080p: false,
  proxy_1080p_lut: true,
};

export interface ShareLink {
  id: string;
  asset_id: string | null;
  folder_id: string | null;
  project_id: string | null;
  token: string;
  title: string;
  description: string | null;
  created_by: string;
  expires_at: string | null;
  permission: SharePermission;
  allowed_download_variants: DownloadVariant[];
  /** How much asset metadata this link exposes (§33). */
  fields_visibility: FieldsVisibility;
  is_enabled: boolean;
  visibility: "public" | "secure";
  show_versions: boolean;
  /** §188 — whether a viewer may READ existing comments. Independent of
   *  `permission`, which decides whether they may POST one. Name matches
   *  the backend schema field exactly; a mismatch is silent (the field
   *  reads undefined) and falls back to showing comments. */
  show_comments: boolean;
  show_watermark: boolean;
  appearance: ShareLinkAppearance | null;
  created_at: string;
  deleted_at: string | null;
  has_password: boolean;
  password_value: string | null;
}

export interface AssetShare {
  id: string;
  asset_id: string;
  shared_with_user_id: string | null;
  shared_with_team_id: string | null;
  permission: SharePermission;
  shared_by: string;
  created_at: string;
  deleted_at: string | null;
}

export interface ShareLinkListItem {
  id: string
  token: string
  title: string
  description: string | null
  is_enabled: boolean
  permission: SharePermission
  share_type: "asset" | "folder"
  target_name: string
  view_count: number
  last_viewed_at: string | null
}

export type ShareActivityAction = "opened" | "viewed_asset" | "commented" | "approved" | "rejected" | "downloaded"

export interface ShareLinkActivity {
  id: string
  share_link_id: string
  action: ShareActivityAction
  actor_email: string
  actor_name: string | null
  asset_id: string | null
  asset_name: string | null
  created_at: string
}

export interface FolderShareAssetItem {
  id: string
  name: string
  asset_type: string
  thumbnail_url: string | null
  file_size: number | null
  duration_seconds: number | null
  comment_count: number
  created_by_name: string | null
  created_at: string
  /** Which of the link's permitted variants apply to THIS asset (§30). */
  download_variants?: DownloadVariant[]
}

export interface FolderShareSubfolder {
  id: string
  name: string
  item_count: number
  thumbnail_urls: string[]
}

/** §143 — server-built zip downloads. */
export interface ZipExportVersionOption {
  version_id: string
  version_number: number
  created_at?: string | null
  is_latest?: boolean
}

export interface ZipExportAssetOptions {
  asset_id: string
  asset_name: string
  /** Empty when there is no choice to make: one version, or the link hides
   *  versions. The UI hides the selector in both cases. */
  versions: ZipExportVersionOption[]
}

export interface ZipExportOptionsResponse {
  /** Only variants backed by a stored object — a batch never renders. */
  variants: DownloadVariant[]
  assets: ZipExportAssetOptions[]
}

export interface ZipExportFile {
  asset_id: string
  asset_name: string
  path: string
  version_id: string
  variant: string
  /** Why this file is not the variant the batch asked for, when it isn't. */
  fallback_reason?: string | null
  skipped?: string | null
}

export interface ZipExportStatusResponse {
  export_id: string
  status: 'pending' | 'building' | 'ready' | 'failed'
  /** True when an identical earlier request already built this archive. */
  reused: boolean
  ready: boolean
  url?: string | null
  file_count: number
  files_done: number
  total_bytes: number
  /** Which half of the build is running, or null once it is neither. */
  phase?: 'gathering' | 'uploading' | null
  /** Bytes of the finished archive uploaded so far; only meaningful while
   *  `phase === 'uploading'`. */
  bytes_done?: number
  error?: string | null
  files: ZipExportFile[]
}

export interface FolderShareAssetsResponse {
  assets: FolderShareAssetItem[]
  subfolders: FolderShareSubfolder[]
  /** Assets in this folder across the whole link, not just the loaded page. */
  total: number
  /**
   * Bytes across all `total` assets, not just the loaded page. Optional so a
   * response served by an API that predates this field type-checks; the
   * viewer falls back to summing what it has loaded.
   */
  total_size_bytes?: number
  page: number
  per_page: number
}

// ─── Metadata & Collections ───────────────────────────────────────────────────

export interface MetadataField {
  id: string;
  project_id: string;
  name: string;
  field_type: MetadataFieldType;
  options: unknown[] | null;
  required: boolean;
  created_at: string;
  deleted_at: string | null;
}

export interface AssetMetadata {
  id: string;
  asset_id: string;
  field_id: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export interface Collection {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  filter_rules: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

export interface CollectionShare {
  id: string;
  collection_id: string;
  token: string;
  permission: SharePermission;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

// ─── Activity, Mentions & Notifications ───────────────────────────────────────

export interface Mention {
  id: string;
  comment_id: string;
  mentioned_user_id: string;
  created_at: string;
}

export interface ActivityLog {
  id: string;
  user_id: string;
  asset_id: string;
  action: ActivityAction;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  comment_id: string | null;
  asset_id: string;
  type: NotificationType;
  read: boolean;
  created_at: string;
  asset_name: string | null;
  actor_name: string | null;
  comment_preview: string | null;
  project_id: string | null;
}

// ─── Branding & Watermarking ──────────────────────────────────────────────────

export interface ProjectBranding {
  id: string;
  project_id: string;
  logo_s3_key: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_title: string | null;
  custom_footer: string | null;
  viewer_layout: ViewerLayout;
  featured_field: string | null;
  created_at: string;
  updated_at: string;
}

export interface WatermarkSettings {
  id: string;
  project_id: string;
  share_link_id: string | null;
  enabled: boolean;
  position: WatermarkPosition;
  content: WatermarkContent;
  custom_text: string | null;
  opacity: number;
  created_at: string;
}

// ─── Folders ──────────────────────────────────────────────────────────────────

export interface Folder {
  id: string
  project_id: string
  parent_id: string | null
  name: string
  created_by: string | null
  created_at: string
  updated_at: string
  item_count: number
  total_size_bytes: number
}

export interface FolderTreeNode {
  id: string
  name: string
  parent_id: string | null
  item_count: number
  total_size_bytes: number
  children: FolderTreeNode[]
}

export interface TrashItem {
  id: string
  name: string
  type: string
  parent_id?: string | null
  folder_id?: string | null
  deleted_at: string | null
}

export interface TrashResponse {
  folders: TrashItem[]
  assets: TrashItem[]
}

// ─── API Response Wrappers ────────────────────────────────────────────────────

export interface ApiError {
  detail: string;
  status_code: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

export interface SetupStatus {
  needs_setup: boolean;
}

export interface MagicCodeResponse {
  message: string;
}

export interface VerifyCodeResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  needs_password: boolean;
  /** §191 — always present and always false on this arm. The backend adds
   *  it to the SUCCESS shape as well as the 2FA one on purpose: a
   *  discriminator that appears in only one arm is one a careless client
   *  reads as `undefined` and treats as falsy by accident rather than by
   *  decision. Required here for the same reason — the union below is only
   *  narrowable if both arms declare it. */
  requires_2fa: false;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  /** Present on every TokenResponse the API returns (§191). Optional here
   *  only because this type also describes endpoints whose response this
   *  app does not narrow on — /auth/accept-invite, /auth/refresh. Where the
   *  union matters, use LoginResponse. */
  requires_2fa?: false;
}

// ─── Two-factor authentication (§191-§195) ────────────────────────────────────

/** Which second factor a user enrolled with. "email" started as a fallback
 *  for a lost authenticator (§191) and became selectable as the primary
 *  method in §194. */
export type TwoFactorMethod = 'totp' | 'email';

/** Password (or magic code) accepted, second factor outstanding.
 *
 *  Carries no tokens: the caller holds a `pending_token` that is inert
 *  everywhere except /auth/2fa/verify-login and the enrolment endpoints. */
export interface TwoFactorRequiredResponse {
  requires_2fa: true;
  /** True when this user has NEVER enrolled and the instance requires it —
   *  the pending token has to be redeemed through enrolment, not through
   *  /auth/2fa/verify-login. */
  setup_required: boolean;
  pending_token: string;
  /** Which code to ask for. Null exactly when `setup_required` is true: the
   *  user has not chosen a method yet, and choosing is what the enrolment
   *  screen is for. */
  method: TwoFactorMethod | null;
  /** §194 — true when a code has ALREADY been mailed as part of this
   *  response (email-primary users only), so the screen can say "we've sent
   *  you a code" instead of offering to send one that is already in
   *  flight. */
  email_code_sent: boolean;
}

/** What /auth/login and /auth/verify-magic-code both return. Narrow on
 *  `requires_2fa` — never on whether `access_token` happens to be there. */
export type LoginResponse = VerifyCodeResponse | TwoFactorRequiredResponse;

export interface TwoFactorSetupRequest {
  /** Mid-login enrolment; omitted when an already-signed-in user enrols
   *  from settings. */
  pending_token?: string;
  method: TwoFactorMethod;
  /** §194b — proof of the CURRENT factor, required only when the user is
   *  already enrolled and is replacing what they have. */
  reauth_code?: string;
}

export interface TwoFactorSetupResponse {
  method: TwoFactorMethod;
  /** TOTP only. */
  provisioning_uri?: string;
  /** TOTP only — already a data: URI, usable directly as an <img src>. */
  qr_code_data_uri?: string;
  /** TOTP only — the secret in plaintext, for manual entry. */
  secret?: string;
  /** Email only. False when a code was already outstanding and this call
   *  therefore did not send a second one (§194's per-TTL idempotency). */
  email_code_sent: boolean;
}

export interface TwoFactorVerifyRequest {
  pending_token: string;
  code: string;
}

export interface TwoFactorConfirmRequest {
  pending_token?: string;
  code: string;
}

/** Proof that the caller still holds a second factor (§192).
 *
 *  Accepts any of the three forms the login path accepts — authenticator,
 *  emailed fallback, backup code — because the user does not reliably know
 *  which kind they are holding. Required by the two self-service actions
 *  that WEAKEN an account (disable, regenerate) and, since §194b, by
 *  starting a replacement enrolment. */
export interface TwoFactorReauthRequest {
  code: string;
}

/**
 * What POST /auth/set-password returns (§199).
 *
 * Everything /auth/me's User carries, plus a replacement token pair: setting
 * or changing a password bumps `token_version`, which ends every session the
 * user holds including the one that made the call.
 *
 * It also closes a mismatch that predates §199. `login-form.tsx` has always
 * typed this response as `AuthTokens` and called `setTokens(res.access_token,
 * res.refresh_token)` on it, while the endpoint returned only a user — so it
 * wrote the literal string "undefined" over the tokens the magic-code step
 * had set moments earlier. Those fields now genuinely exist.
 */
export interface SetPasswordResponse extends User {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface TwoFactorDisableResponse {
  /** Always false after the call. Returned rather than implied so a client
   *  updates from the response instead of assuming the write landed. */
  two_factor_enabled: boolean;
  /** §199 — a replacement pair for the session that made this call.
   *
   *  Disabling 2FA bumps the user's `token_version`, which ends every
   *  session they hold, including this one. Adopt these or the next request
   *  this tab makes is a 401. */
  tokens: AuthTokens | null;
}

export interface TwoFactorBackupCodesResponse {
  /** A fresh set, shown once. Replaces the previous set entirely — the old
   *  codes stop working the moment this returns. */
  backup_codes: string[];
  /** §199 — see TwoFactorDisableResponse.tokens; identical reasoning. */
  tokens: AuthTokens | null;
}

export interface TwoFactorConfirmResponse {
  /** Shown ONCE. Nothing can read them back — they are hashed server-side,
   *  so a screen that skips past them has destroyed them. */
  backup_codes: string[];
  method: TwoFactorMethod;
  /** §199 — now populated on BOTH branches, not only a forced first login.
   *  Confirming enrolment bumps `token_version`, so an already-signed-in
   *  user's existing tokens are stale as of this response and these are the
   *  replacements. Still typed nullable: a client that adopts them only when
   *  present keeps working against an older API. */
  tokens: AuthTokens | null;
}

// ─── Account security gate (§200) ─────────────────────────────────────────────

/** Where this account stands on having a usable password-reset channel.
 *
 *  "missing"  — no backup address at all.
 *  "pending"  — an address is stored but unproved. Still gated: a reset sent
 *               to an address that may not exist is worse than none, because
 *               it looks like a recovery path.
 *  "verified" — a code sent to it came back. The only state in which anything
 *               is ever mailed there. */
export type BackupEmailState = 'missing' | 'pending' | 'verified';

/** The detail string every protected route returns while the gate is up.
 *
 *  A stable token, not a sentence — `lib/api.ts` surfaces `detail` verbatim,
 *  and comparing against prose is a translation bug waiting to happen. */
export const ACCOUNT_SETUP_REQUIRED = 'account_setup_required';

export interface BackupEmailResponse {
  backup_email: string;
  state: BackupEmailState;
  /** True when this call actually sent a code. */
  code_sent: boolean;
  /** The backup address is on the same mail domain as the login address.
   *  Accepted, but worth saying out loud — one admin with domain-wide access
   *  can read both mailboxes, which is the thing the split exists to prevent.
   *  The wording lives in the UI; the server only reports the fact. */
  same_domain: boolean;
}

/** What GET /auth/password-policy serves. The NUMBERS live on the server;
 *  `lib/password-policy.ts` holds a fallback copy only for the moment before
 *  this arrives. */
export interface PasswordPolicy {
  min_length: number;
  min_strength_score: number;
  requires_upper: boolean;
  requires_lower: boolean;
  requires_digit: boolean;
  requires_special: boolean;
}

/** The live meter's verdict. Advisory — see lib/password-policy.ts. */
export interface PasswordStrength {
  /** zxcvbn 0-4. */
  score: number;
  label: 'weak' | 'medium' | 'strong';
  /** zxcvbn's own concrete finding, e.g. "This is similar to a commonly used
   *  password". Empty when it has nothing specific to say. */
  reason: string;
  /** Everything the BROWSER can check passes. Not "valid": the common-password
   *  blocklist and the personal-token rule exist only server-side, so a true
   *  here still leaves a submission that can be refused. */
  meetsPolicy: boolean;
  /** Which character classes are still missing, in the server's own wording. */
  missing: string[];
}

// ─── Site Settings ────────────────────────────────────────────────────────────

export interface SiteSettingsResponse {
  org_name: string;
  logo_dark_url: string | null;
  logo_light_url: string | null;
  logo_login_url: string | null;
  favicon_url: string | null;
  theme_colors: Record<string, unknown> | null;
  total_storage_limit_bytes?: number | null;
  /** IANA zone deciding when the daily maintenance jobs run (§182).
   *  Defaults to "UTC" server-side, so this is never absent in practice —
   *  optional only so an older cached response still validates. */
  timezone?: string;
  /** §191 — whether every user on this instance must have 2FA. Public: this
   *  endpoint is unauthenticated (it backs the login page's branding), and
   *  the login screen needs it to decide which sign-in method to offer. */
  require_2fa?: boolean;
  // Only populated for an authenticated superadmin caller -- null for
  // anonymous/non-superadmin requests (GET /site-settings is otherwise
  // public, backing the login page's branding).
  total_storage_used_bytes?: number | null;
}

// ─── Transcription ────────────────────────────────────────────────────────────

export type TranscriptionStatus = 'not_started' | 'processing' | 'ready' | 'failed'

export interface TranscriptSegment {
  id: number
  start: number
  end: number
  text: string
}

/** Mirrors TranscriptResponse in apps/api/schemas/asset.py. `segments` is
 *  only populated once transcription_status is 'ready'. */
export interface TranscriptResponse {
  transcription_status: TranscriptionStatus
  /** 0-100 while transcribing, null otherwise (§127). Sits at 0 for a while
   *  at the start — the model load and the VAD pass both happen before the
   *  first segment is yielded, so a flat 0 there is normal, not stuck. */
  transcription_progress: number | null
  /** The per-file toggle: should this file end up transcribed (§127). */
  transcription_enabled: boolean
  language: string | null
  captions_url: string | null
  text: string
  segments: TranscriptSegment[]
}

/** Mirrors TranscriptionToggleResponse in apps/api/schemas/asset.py. */
export interface TranscriptionToggleResponse {
  enabled: boolean
  transcription_status: TranscriptionStatus
  /** A run was actually stopped, as opposed to future runs merely declined. */
  cancelled: boolean
  started: boolean
}

// ─── LUTs ─────────────────────────────────────────────────────────────────────

/** Mirrors LutResponse in apps/api/schemas/lut.py. */
export interface LutGroup {
  id: string
  name: string
  /** Shared/global rather than one user's (§39). Sent on personal groups too,
   *  so a group never has to be identified by which endpoint it came from. */
  is_platform: boolean
  /** null = a top-level Main group; otherwise the Main group this Sub group
   *  sits under (§45). Exactly one level, enforced server-side. */
  parent_group_id: string | null
  created_at: string
}

export interface Lut {
  id: string
  name: string
  lut_size: number | null
  created_at: string
  /** Usable in every project with no share row — superadmin-set only. */
  is_platform_wide: boolean
  group_id: string | null
  /** Projects this LUT is currently shared into. Populated by GET /me/luts
   *  so the share popover can render toggles without a request per project. */
  shared_project_ids: string[]
  is_owner: boolean
  owner_name: string | null
  file_url: string | null
  /** Only set by GET /projects/{id}/luts. A LUT you own but haven't shared
   *  is listed with false — previewable locally, not applicable team-wide. */
  shared_with_project: boolean | null
}

export interface LutExportResponse {
  export_id: string
  asset_id: string
  version_id: string
  lut_id: string
}

// ─── Email / SMTP settings (superadmin-only) ─────────────────────────────────

/** How the SMTP connection is encrypted (§199). Three modes, because there
 *  are three real arrangements — the boolean this supplements could only
 *  express two, and read `false` as implicit TLS rather than as "no TLS",
 *  which made a plaintext relay unreachable. */
export type SmtpSecurity = 'starttls' | 'implicit_tls' | 'none'

/** Mirrors EmailSettingsResponse in apps/api/schemas/email_settings.py.
 *  Note there are no password fields — secrets are reported only as
 *  `*_set` booleans and never sent to the client. */
export interface EmailSettingsResponse {
  mail_provider: string | null
  mail_from_address: string | null
  mail_from_name: string | null
  aws_mail_access_key_id: string | null
  aws_mail_secret_access_key_set: boolean
  aws_mail_region: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_user: string | null
  smtp_password_set: boolean
  smtp_use_tls: boolean | null
  /** §199 — the STORED mode, or null when it has never been set explicitly. */
  smtp_security: SmtpSecurity | null
  /** And what would actually be used right now, after the env fallback and
   *  the smtp_use_tls derivation. An empty stored value must not be read as
   *  "no encryption" when the real answer is "STARTTLS, by default". */
  effective_smtp_security: SmtpSecurity | null
  /** What's actually in effect once DB-over-env precedence is applied. */
  effective_provider: string | null
  effective_from_address: string | null
  effective_smtp_host: string | null
  using_env_fallback: boolean
}

export interface EmailSettingsUpdate {
  mail_provider?: string | null
  mail_from_address?: string | null
  mail_from_name?: string | null
  aws_mail_access_key_id?: string | null
  aws_mail_secret_access_key?: string
  aws_mail_region?: string | null
  smtp_host?: string | null
  smtp_port?: number | null
  smtp_user?: string | null
  smtp_password?: string
  smtp_use_tls?: boolean | null
  smtp_security?: SmtpSecurity | null
  smtp_password_clear?: boolean
  aws_mail_secret_access_key_clear?: boolean
}

export interface TestEmailResponse {
  success: boolean
  detail: string
}

// ─── Sidecar files ────────────────────────────────────────────────────────────

export type SidecarType =
  | 'cdl'
  | 'ale'
  | 'camera_xml'
  | 'dji_srt'
  | 'panasonic_clipinfo'
  | 'nikon_nksc'
  | 'red_rmd'
  | 'sony_bim'
  | 'canon_cif'

/** Parser provenance, written into `parsed_metadata._meta` by every parser
 *  added in §23c. `best_effort` means the format is proprietary and only what
 *  could be verified from the bytes is shown — the UI must say so rather than
 *  presenting it as fact. */
export interface SidecarParserMeta {
  confidence: 'specified' | 'best_effort'
  note: string
  format?: string
}

/** Mirrors SidecarResponse in apps/api/schemas/sidecar.py. `parsed_metadata`
 *  shape varies by type: CDL gives { color_corrections: [...] }, ALE gives
 *  heading/columns/clips, camera XML gives a flat dotted-path dict. */
export interface SidecarFile {
  id: string
  asset_id: string
  sidecar_type: SidecarType
  original_filename: string
  parsed_metadata: Record<string, unknown>
  created_at: string
}
