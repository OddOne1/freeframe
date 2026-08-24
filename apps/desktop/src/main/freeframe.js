// FreeFrame API client — main process only.
//
// Deliberately lives here rather than in the renderer, for the same reason
// volumes and copying do: the renderer is sandboxed and untrusted, and this
// module holds an access token. The token never crosses the contextBridge.
// The renderer asks main to make calls; it cannot read the credential, and
// a compromised renderer can't exfiltrate it.
//
// Tokens are persisted with Electron's safeStorage (OS keychain-backed),
// not a plain JSON file. apps/web uses localStorage, which doesn't exist
// here and wouldn't be an acceptable substitute anyway.

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");

const DEFAULT_BASE_URL = "https://frame.yon.studio/api";

let state = {
  baseUrl: DEFAULT_BASE_URL,
  accessToken: null,
  refreshToken: null,
  user: null,
};

function tokenFile() {
  return path.join(app.getPath("userData"), "freeframe-session.bin");
}

// ── Persistence ──────────────────────────────────────────────────────────

async function saveSession() {
  const payload = JSON.stringify({
    baseUrl: state.baseUrl,
    refreshToken: state.refreshToken,
    user: state.user,
  });
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Refuse rather than silently downgrading to plaintext on disk. The
      // user simply logs in again next launch; a plaintext refresh token
      // is a worse outcome than that inconvenience.
      return;
    }
    await fsp.writeFile(tokenFile(), safeStorage.encryptString(payload));
  } catch {
    /* persistence is a convenience, never a hard failure */
  }
}

async function loadSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const buf = await fsp.readFile(tokenFile());
    const parsed = JSON.parse(safeStorage.decryptString(buf));
    state.baseUrl = parsed.baseUrl || DEFAULT_BASE_URL;
    state.refreshToken = parsed.refreshToken || null;
    state.user = parsed.user || null;
    // Only the refresh token is persisted; the access token is short-lived
    // (~15 min) so storing it would be pointless. Exchange it on startup.
    if (state.refreshToken) await refreshAccessToken();
  } catch {
    state.refreshToken = null;
    state.user = null;
  }
}

async function clearSession() {
  state = { baseUrl: state.baseUrl, accessToken: null, refreshToken: null, user: null };
  await fsp.unlink(tokenFile()).catch(() => {});
}

// ── HTTP ─────────────────────────────────────────────────────────────────

async function rawRequest(method, endpoint, { body, token, headers = {} } = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${state.baseUrl}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function readError(res) {
  try {
    const data = await res.json();
    const detail = data.detail ?? data.message;
    if (typeof detail === "string") return detail;
    // FastAPI returns 422 validation errors as an ARRAY of
    // { loc, msg, type } objects. Passing that straight through rendered
    // "[object Object]" to the user — useless, and it hides exactly the
    // message that says which field is wrong.
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          const field = Array.isArray(d.loc) ? d.loc.filter((x) => x !== "body").join(".") : "";
          return field ? `${field}: ${d.msg}` : d.msg;
        })
        .filter(Boolean)
        .join("; ") || `${res.status} ${res.statusText}`;
    }
    if (detail && typeof detail === "object") return JSON.stringify(detail);
    return `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** Exchange the refresh token for a new access token. */
async function refreshAccessToken() {
  if (!state.refreshToken) return null;
  let res;
  try {
    res = await rawRequest("POST", "/auth/refresh", {
      body: { refresh_token: state.refreshToken },
    });
  } catch {
    // The server was unreachable — offline, DNS, a tunnel still coming up.
    // That says nothing about whether the credential is valid, so the
    // stored session is left alone and the next call can retry. Deleting
    // it here would mean a laptop opened on a plane is permanently signed
    // out by the time it lands.
    return null;
  }
  if (!res.ok) {
    // Only an explicit rejection of the credential drops it. A 500 or a
    // 502 from a restarting container is a server problem, not a dead
    // token, and clearing on any non-ok (which this did) meant one bad
    // response at launch silently signed the user out for good — with the
    // token file deleted, so re-launching couldn't recover it either.
    if (res.status === 401 || res.status === 403) await clearSession();
    return null;
  }
  const data = await res.json();
  state.accessToken = data.access_token;
  if (data.refresh_token) state.refreshToken = data.refresh_token;
  await saveSession();
  return state.accessToken;
}

/**
 * Authenticated request with refresh-on-401-and-retry-once, mirroring
 * apps/web/lib/api.ts. The access token expires in ~15 minutes, so without
 * this the desktop app would silently start failing after a short idle —
 * exactly the failure the roadmap called out.
 */
async function apiRequest(method, endpoint, body) {
  if (!state.accessToken && state.refreshToken) await refreshAccessToken();
  let res = await rawRequest(method, endpoint, { body, token: state.accessToken });

  if (res.status === 401 && state.refreshToken) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await rawRequest(method, endpoint, { body, token: fresh });
  }

  if (!res.ok) throw new Error(await readError(res));
  if (res.status === 204) return null;
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────

async function login({ email, password, baseUrl }) {
  if (baseUrl) state.baseUrl = baseUrl.replace(/\/+$/, "");
  const res = await rawRequest("POST", "/auth/login", { body: { email, password } });
  if (!res.ok) {
    return { ok: false, error: await readError(res) };
  }
  const data = await res.json();
  state.accessToken = data.access_token;
  state.refreshToken = data.refresh_token;

  try {
    state.user = await apiRequest("GET", "/auth/me");
  } catch {
    state.user = { email };
  }
  await saveSession();
  return { ok: true, user: state.user, needsPassword: Boolean(data.needs_password) };
}

function status() {
  return {
    loggedIn: Boolean(state.accessToken || state.refreshToken),
    user: state.user,
    baseUrl: state.baseUrl,
    // Surfaced so the UI can warn rather than silently not persisting.
    encryptionAvailable: (() => {
      try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
    })(),
  };
}

/**
 * What the embedded web view needs to adopt this session (§60b).
 *
 * `webUrl` is derived from the SAME baseUrl the API calls use rather than
 * a second hardcoded copy — a desktop pointed at a staging API must not
 * open production's web app.
 *
 * Refreshes first when only a refresh token is in hand: the access token
 * is deliberately not persisted (see loadSession), so on a cold start
 * there is nothing to inject until one is minted.
 */
async function webSession() {
  if (!state.accessToken && state.refreshToken) {
    try { await refreshAccessToken(); } catch { /* fall through unauthenticated */ }
  }
  // Strip the API path segment; everything before it is the web app.
  const webUrl = state.baseUrl.replace(/\/api\/?$/, "") || "https://frame.yon.studio";
  return {
    webUrl,
    accessToken: state.accessToken || null,
    refreshToken: state.refreshToken || null,
  };
}

// ── Resources ────────────────────────────────────────────────────────────

const listProjects = () => apiRequest("GET", "/projects");
const folderTree = (projectId) => apiRequest("GET", `/projects/${projectId}/folder-tree`);

/**
 * Assets in a project, optionally scoped to one folder.
 *
 * There is no separate "list the files in this folder" endpoint and none
 * was needed: `GET /projects/{id}/assets` (apps/api/routers/assets.py)
 * already takes `folder_id` ("root" or a UUID) and `recursive`, and
 * `recursive=true` returns a whole subtree in a single call.
 *
 * Each asset carries `latest_version.files[]`, which has
 * `original_filename`, `file_size_bytes` and the version's
 * `processing_status` — so one request produces the complete manifest a
 * copy job needs, with no per-asset round trip to size anything.
 */
function listAssets(projectId, { folderId = null, recursive = true } = {}) {
  const params = new URLSearchParams();
  params.set("folder_id", folderId || "root");
  params.set("recursive", recursive ? "true" : "false");
  return apiRequest("GET", `/projects/${projectId}/assets?${params}`);
}

/**
 * A Node Readable of one asset's original bytes.
 *
 * `?download=true` matters: for video it resolves to `s3_key_raw`, the file
 * as it was uploaded, rather than the transcoded streaming proxy. Pulling a
 * project down and getting HLS renditions back instead of the camera
 * original would defeat the point.
 *
 * Two calls, because the API hands out a short-lived proxy URL rather than
 * the bytes: GET the URL, then GET the URL. The proxy path is relative, so
 * it's resolved against the signed-in server the same way apps/web resolves
 * it against its API origin.
 */
async function openAssetStream(assetId) {
  const { url } = await apiRequest("GET", `/assets/${assetId}/stream?download=true`);
  if (!url) throw new Error("No download URL returned");
  const absolute = url.startsWith("http") ? url : `${state.baseUrl}${url}`;

  // The proxy URL carries its own token, so this request is deliberately
  // unauthenticated — adding the bearer token would be harmless but is not
  // what makes it work, and pretending otherwise would mislead.
  const res = await fetch(absolute);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("Download returned an empty body");

  const { Readable, Transform } = require("node:stream");

  // Every chunk is COPIED before it leaves this function. This is not
  // defensive tidiness — without it the pull silently corrupts files.
  //
  // The engine hashes each chunk synchronously and then hands the same
  // object to fs.WriteStream.write(), which is asynchronous. Chunks coming
  // off a TLS fetch body are views into buffers the TLS layer reuses, so
  // once writes start queueing (i.e. as soon as there's any backpressure —
  // measured at 40 KB into a small file, 600 KB into a larger one) the
  // bytes behind an already-queued chunk get overwritten before they reach
  // the disk. The result is a file of exactly the right LENGTH whose
  // contents diverge partway through, differently on every run, while the
  // source hash stays stable and correct.
  //
  // Found by the end-to-end pull test, not by reading the code: two
  // consecutive pulls of the same asset produced identical source hashes
  // and two different files on disk. The verification pass is what caught
  // it — this is precisely the failure SECURE mode exists to refuse.
  //
  // The copy lives here rather than in copy-engine.js on purpose: chunks
  // from fs.createReadStream are already stable (each is a slice of a pool
  // that stays alive as long as the slice does), so making the engine copy
  // unconditionally would add a memcpy per 4 MiB chunk to every local
  // card offload to fix a problem local offloads don't have.
  const stable = new Transform({
    transform(chunk, _enc, cb) { cb(null, Buffer.from(chunk)); },
  });
  return Readable.fromWeb(res.body).pipe(stable);
}

// ── MIME detection ───────────────────────────────────────────────────────
//
// **This is load-bearing, not cosmetic.** Uploads used to send
// `application/octet-stream` for every file. The API accepts it, but
// `mime_to_asset_type` (apps/api/schemas/upload.py) maps octet-stream to
// AssetType.video *unconditionally* — so a JPEG or a WAV was created as a
// video asset, `process_asset` ran the ffmpeg HLS branch on it, that
// failed, and `list_assets` hides assets whose versions all failed
// (`include_failed` defaults to False). The bytes reached S3 and the row
// existed, but nothing appeared on the site: exactly the "zero files
// showing up" report.
//
// Every value below is checked against ALLOWED_MIME_TYPES in that same
// schema — sending a type the API rejects would turn a silent failure into
// a loud one, which is better, but still a failure.
const MIME_BY_EXT = {
  // Video
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".webm": "video/webm",
  ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv", ".3gp": "video/3gpp", ".3g2": "video/3gpp2",
  ".ogv": "video/ogg", ".mxf": "application/mxf",
  ".m2ts": "video/mp2t", ".mts": "video/mp2t", ".ts": "video/mp2t",
  // Audio
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
  ".aac": "audio/aac", ".ogg": "audio/ogg", ".m4a": "audio/x-m4a",
  ".aif": "audio/aiff", ".aiff": "audio/aiff",
  // Image
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".heic": "image/heic", ".tif": "image/tiff",
  ".tiff": "image/tiff", ".gif": "image/gif", ".dpx": "image/x-dpx",
  ".exr": "image/x-exr",
  // Camera-native. These are the formats the API's octet-stream fallback
  // was actually meant for, and they genuinely are video.
  ".braw": "application/x-braw", ".r3d": "application/x-r3d",
  ".ari": "application/x-arriraw", ".arx": "application/x-arriraw",
  ".cine": "application/x-cine", ".dng": "application/x-cinema-dng",
};

/**
 * MIME type for a filename, or null when the extension isn't recognised.
 *
 * Null rather than a guess: the caller decides what to do with an unknown
 * file, and octet-stream is not a safe default — it means "video" to this
 * API, which is how a text file becomes a failed video asset.
 */
function mimeForFilename(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

// ── Upload (multipart) ───────────────────────────────────────────────────

// Mirrors apps/web/stores/upload-store.ts's flow rather than inventing a
// second one: initiate -> presign each part -> PUT it -> complete with the
// collected {PartNumber, ETag} list.
const PART_SIZE = 16 * 1024 * 1024;
const CONCURRENT_PARTS = 3;

async function uploadFile({ projectId, filePath, assetName, folderId = null, onProgress = () => {} }) {
  const stat = await fsp.stat(filePath);
  const fileName = path.basename(filePath);

  const mimeType = mimeForFilename(fileName);
  if (!mimeType) {
    // Refused here rather than sent as octet-stream. The server would
    // accept octet-stream and then classify this as a video, transcode it
    // as one, fail, and hide the result — an upload that reports success
    // and produces nothing visible. Better to say we didn't upload it.
    throw new Error(
      `Unrecognised file type "${path.extname(fileName) || fileName}" — FreeFrame would file this as a video and fail to process it`
    );
  }

  const init = await apiRequest("POST", "/upload/initiate", {
    project_id: projectId,
    asset_name: assetName || fileName,
    original_filename: fileName,
    file_size_bytes: stat.size,
    mime_type: mimeType,
    folder_id: folderId,
  });

  const { s3_key, upload_id, asset_id, version_id } = init;
  const totalParts = Math.max(1, Math.ceil(stat.size / PART_SIZE));
  const parts = new Array(totalParts);
  let uploaded = 0;

  const fh = await fsp.open(filePath, "r");
  try {
    let next = 1;
    const worker = async () => {
      for (;;) {
        const partNumber = next++;
        if (partNumber > totalParts) return;

        const offset = (partNumber - 1) * PART_SIZE;
        const length = Math.min(PART_SIZE, stat.size - offset);
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, offset);

        const { presigned_url } = await apiRequest("POST", "/upload/presign-part", {
          s3_key, upload_id, part_number: partNumber,
        });
        const put = await fetch(presigned_url, { method: "PUT", body: buf });
        if (!put.ok) throw new Error(`Part ${partNumber} failed: ${put.status} ${put.statusText}`);

        parts[partNumber - 1] = { PartNumber: partNumber, ETag: put.headers.get("ETag") || "" };
        uploaded += length;
        onProgress({ uploaded, total: stat.size, part: partNumber, totalParts });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENT_PARTS, totalParts) }, worker));
  } finally {
    await fh.close();
  }

  await apiRequest("POST", "/upload/complete", {
    s3_key, upload_id, asset_id, version_id, parts,
  });

  return { assetId: asset_id, versionId: version_id, bytes: stat.size, fileName };
}

module.exports = {
  DEFAULT_BASE_URL,
  webSession,
  loadSession,
  clearSession,
  login,
  status,
  refreshAccessToken,
  apiRequest,
  listProjects,
  folderTree,
  listAssets,
  openAssetStream,
  uploadFile,
  mimeForFilename,
  // Test seam: lets the harness drive the client without real credentials.
  __setState: (patch) => Object.assign(state, patch),
  __getState: () => ({ ...state }),
};
