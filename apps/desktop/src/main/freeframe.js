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

/**
 * The message AND, when the server sent one, a machine-readable code.
 *
 * §213 added structured error details — `{"code": "no_such_upload",
 * "message": "..."}` — because the uploader has to BRANCH on one of
 * them: a gone multipart session means "start a fresh upload", which is
 * a completely different action from "retry". Matching on prose is how
 * that breaks the first time someone improves the wording.
 *
 * One function reading the body, because a response body can only be
 * read once: `readError` below is the message-only view of this.
 */
async function readErrorParts(res) {
  const fallback = { message: `${res.status} ${res.statusText}`, code: null };
  try {
    const data = await res.json();
    const detail = data.detail ?? data.message;
    if (typeof detail === "string") return { message: detail, code: null };
    // FastAPI returns 422 validation errors as an ARRAY of
    // { loc, msg, type } objects. Passing that straight through rendered
    // "[object Object]" to the user — useless, and it hides exactly the
    // message that says which field is wrong.
    if (Array.isArray(detail)) {
      const joined = detail
        .map((d) => {
          const field = Array.isArray(d.loc) ? d.loc.filter((x) => x !== "body").join(".") : "";
          return field ? `${field}: ${d.msg}` : d.msg;
        })
        .filter(Boolean)
        .join("; ");
      return { message: joined || fallback.message, code: null };
    }
    if (detail && typeof detail === "object") {
      return {
        message: String(detail.message || detail.detail || JSON.stringify(detail)),
        code: typeof detail.code === "string" ? detail.code : null,
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function readError(res) {
  return (await readErrorParts(res)).message;
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

  if (!res.ok) {
    const { message, code } = await readErrorParts(res);
    const err = new Error(message);
    // §212 — the status, so a caller can tell a permanent refusal from
    // weather. `putPartWithRetry` uses it to stop retrying a presign that
    // comes back 403: being refused twice is just being refused.
    err.status = res.status;
    // §213 — and the code, where the server sent one. `no_such_upload` is
    // the one the uploader acts on: it starts a fresh upload rather than
    // failing the file.
    err.code = code;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────

/**
 * Everything that happens once a login is genuinely FINISHED (§198).
 *
 * ONE implementation, called by /auth/login, /auth/2fa/verify-login and
 * the enrolment that completes a forced first login. That is not tidiness:
 * this is the third surface in this series with the same fork, and the
 * first two both grew two copies that drifted — the API collapsed them into
 * `_login_outcome` (§193) and the web app into `handleLoginResponse`
 * (§196). A second copy here is how one path forgets to persist the
 * session, or forgets to fetch the user, and the symptom shows up a week
 * later as "it signs me out when I restart".
 */
async function adoptSession(tokens, { fallbackEmail } = {}) {
  state.accessToken = tokens.access_token;
  state.refreshToken = tokens.refresh_token;

  try {
    state.user = await apiRequest("GET", "/auth/me");
  } catch {
    // §197 put two_factor_enabled/two_factor_method on this response, so
    // the settings UI gets them for free — but only when the call lands.
    // The fallback is deliberately minimal rather than invented.
    if (fallbackEmail) state.user = { email: fallbackEmail };
  }
  await saveSession();
  return { ok: true, user: state.user, needsPassword: Boolean(tokens.needs_password) };
}

/** Re-read the signed-in user, for actions that change what /auth/me says
 *  about them (enrolling in 2FA from settings, turning it off). */
async function refreshUser() {
  try {
    state.user = await apiRequest("GET", "/auth/me");
    await saveSession();
  } catch {
    /* the action still succeeded; the cached user is just stale */
  }
}

async function login({ email, password, baseUrl }) {
  if (baseUrl) state.baseUrl = baseUrl.replace(/\/+$/, "");
  const res = await rawRequest("POST", "/auth/login", { body: { email, password } });
  if (!res.ok) {
    return { ok: false, error: await readError(res) };
  }
  const data = await res.json();

  // §198 — /auth/login answers 200 for BOTH a finished login and a second
  // factor still outstanding (§191's TwoFactorRequiredResponse), so `res.ok`
  // does not mean what this function used to assume. Unpacked blindly, a
  // challenge set accessToken to undefined, PERSISTED that, and reported
  // `{ ok: true }` — a false success that left the app claiming to be
  // signed in with nothing behind it. Branch on the discriminator, never on
  // whether a token happens to be present; same rule as apps/web (§196).
  //
  // Nothing is written to `state` and nothing is saved here: there is no
  // session yet. The pending token is inert everywhere except the /auth/2fa
  // endpoints, so handing it back to the caller grants nothing.
  if (data && data.requires_2fa) {
    return {
      ok: true,
      requiresTwoFactor: true,
      setupRequired: Boolean(data.setup_required),
      pendingToken: data.pending_token,
      method: data.method || null,
      emailCodeSent: Boolean(data.email_code_sent),
    };
  }

  return adoptSession(data, { fallbackEmail: email });
}

// ── Two-factor (§198) ────────────────────────────────────────────────────
//
// `rawRequest` for the calls that carry a pending_token — there is no
// session to authenticate with yet, by definition — and `apiRequest` for
// the ones a signed-in user makes from Settings. Several endpoints accept
// either, which is why the choice is made per call from what the caller
// supplied rather than by having two functions each.

/** Finish a login that stopped at the second factor. */
async function verifyTwoFactorLogin({ pendingToken, code }) {
  const res = await rawRequest("POST", "/auth/2fa/verify-login", {
    body: { pending_token: pendingToken, code },
  });
  if (!res.ok) return { ok: false, error: await readError(res) };
  return adoptSession(await res.json());
}

/**
 * Mail a fresh code to an email-primary user mid-login.
 *
 * force=True server-side: reaching this IS the user saying the code they
 * have did not arrive, so it replaces the outstanding one. Safe to call
 * more than once.
 */
async function sendTwoFactorEmailFallback({ pendingToken } = {}) {
  try {
    if (pendingToken) {
      const res = await rawRequest("POST", "/auth/2fa/send-email-fallback", {
        body: { pending_token: pendingToken },
      });
      if (!res.ok) return { ok: false, error: await readError(res) };
      return { ok: true };
    }
    await apiRequest("POST", "/auth/2fa/send-email-fallback", {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * Mail a code for confirming a CHANGE to two-factor settings (§206).
 *
 * The desktop's disable / regenerate / change-method prompts asked for a
 * code and sent nothing, so an email-factor user was asked for something
 * that could never arrive — the same dead end §205 fixed on the web, still
 * present here because that change never reached this app.
 *
 * Session-authenticated, so no pending token: this is a signed-in user
 * changing their own settings, not a half-finished login. `force` is false
 * when a prompt opens, so a code already in the inbox is not invalidated by
 * opening a panel, and true for the resend.
 *
 * The server sends only to email-factor users and answers the same
 * deliberately uninformative shape either way, so nothing here needs to
 * know the method to call it safely — but the renderer checks anyway, so a
 * TOTP user is not shown a "resend" for mail that is never sent.
 */
async function sendTwoFactorReauthCode({ force = false } = {}) {
  try {
    await apiRequest("POST", `/auth/2fa/send-reauth-code?force=${force ? "true" : "false"}`, {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * Begin enrolment. Does NOT enable anything — confirm does.
 *
 * `reauthCode` is for the session-authenticated case where the user is
 * ALREADY enrolled and is replacing their method: §194b makes the server
 * refuse that without proof of the current factor, because starting a
 * replacement decides what the account answers to next. Passed through
 * rather than filtered here — the server owns the gate, this just must not
 * make it unreachable.
 */
async function setupTwoFactor({ pendingToken, method = "totp", reauthCode } = {}) {
  const body = { method };
  if (pendingToken) body.pending_token = pendingToken;
  if (reauthCode) body.reauth_code = reauthCode;

  try {
    let data;
    if (pendingToken) {
      const res = await rawRequest("POST", "/auth/2fa/setup", { body });
      if (!res.ok) return { ok: false, error: await readError(res) };
      data = await res.json();
    } else {
      data = await apiRequest("POST", "/auth/2fa/setup", body);
    }
    return {
      ok: true,
      method: data.method,
      provisioningUri: data.provisioning_uri || null,
      qrCodeDataUri: data.qr_code_data_uri || null,
      secret: data.secret || null,
      emailCodeSent: Boolean(data.email_code_sent),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * Finish enrolment.
 *
 * Returns `backupCodes` — shown once, hashed server-side the instant they
 * are issued, never retrievable again. The caller must not move past
 * displaying them without an explicit acknowledgement.
 *
 * When this completed a FORCED first login the response carries real
 * tokens, and they are adopted here, through the same tail as every other
 * finished login. Deliberately NOT held back pending the UI's
 * acknowledgement: holding them would mean either handing tokens to the
 * renderer — which this whole module exists to avoid — or parking them in a
 * half-adopted limbo where main and the UI disagree about whether the user
 * is signed in. There is nothing to protect by waiting: the enrolment is
 * already complete server-side by the time this returns, so the account is
 * 2FA-on whether or not the user clicks. What the acknowledgement protects
 * is the CODES, and what protects those is not advancing the screen — which
 * the UI still enforces.
 */
async function confirmTwoFactorSetup({ pendingToken, code } = {}) {
  const body = { code };
  if (pendingToken) body.pending_token = pendingToken;

  try {
    let data;
    if (pendingToken) {
      const res = await rawRequest("POST", "/auth/2fa/confirm-setup", { body });
      if (!res.ok) return { ok: false, error: await readError(res) };
      data = await res.json();
    } else {
      data = await apiRequest("POST", "/auth/2fa/confirm-setup", body);
    }

    if (data.tokens) {
      await adoptSession(data.tokens);
    } else {
      // Enrolled from an existing session: the tokens in hand are still
      // valid, but what /auth/me says about this user just changed.
      await refreshUser();
    }

    return {
      ok: true,
      backupCodes: data.backup_codes || [],
      method: data.method,
      loggedIn: Boolean(data.tokens),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** Turn 2FA off, having proved the caller still holds a second factor. */
async function disableTwoFactor({ code } = {}) {
  try {
    const data = await apiRequest("POST", "/auth/2fa/disable", { code });
    await refreshUser();
    return { ok: true, twoFactorEnabled: Boolean(data && data.two_factor_enabled) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** A fresh set of backup codes, shown once. The old set stops working. */
async function regenerateBackupCodes({ code } = {}) {
  try {
    const data = await apiRequest("POST", "/auth/2fa/regenerate-backup-codes", { code });
    return { ok: true, backupCodes: (data && data.backup_codes) || [] };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
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
//
// §213 — the part size is now the SERVER'S (`part_size` on the initiate
// response, from services/upload_policy.py). This constant is the
// fallback for an api that predates §213: api and desktop ship
// separately, so for a while a new build talks to an old server, and a
// client that invented its own size again would reintroduce exactly the
// ceiling §213 removed.
const PART_SIZE = 16 * 1024 * 1024;
const CONCURRENT_PARTS = 3;

// How much part data may sit in RAM at once.
//
// Each worker holds one whole part in a Buffer, and that is not laziness:
// a presigned PUT needs a known Content-Length, and a Node stream body
// would be sent chunked, which S3 refuses for a presigned part. So with
// the server free to choose a 512 MiB part once §214 moves uploads off
// Cloudflare, a fixed three workers would mean 1.5 GiB resident for one
// file. Concurrency is derived from a budget instead: three workers at
// today's 16-90 MiB parts, one at 512 MiB.
const PART_BUFFER_BUDGET_BYTES = 512 * 1024 * 1024;

// S3's own hard limit on parts per upload. The ceiling it implies is now
// the SERVER's to enforce (it refuses an impossible size with 413 before
// creating anything); this is the client-side sanity check that a
// server's answer is actually usable.
const MAX_PARTS = 10000;

// §212/§213 — retry policy for a single part.
//
// Part PUTs go to S3_PUBLIC_ENDPOINT, which is behind Cloudflare, so a
// transient 502 over a multi-hour upload is not an anomaly: it is the
// expected weather. §212 gave that 12 attempts (~7 minutes) and then
// ABORTED the whole multipart upload — which, on the real 392 GiB job
// that prompted all of this, still meant losing hours of transfer to one
// bad minute.
//
// §213 removes the budget. The schedule is unchanged while it matters —
// 1s doubling to a 60s cap, full jitter — and then it simply CONTINUES at
// the cap, indefinitely, with the job showing a distinct "waiting for
// connection" state instead of a countdown to giving up. The only things
// that may end an upload are the user pressing Cancel, the server saying
// the session is gone, and the source file having changed.
//
// Jitter is full rather than partial because concurrent workers riding
// out the same outage must not retry in lockstep.
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 60000;

// A hung connection has to count as a failed attempt rather than block the
// whole job: 200 KiB/s is slow enough that no honest link trips it, and the
// 120s floor keeps a small part from timing out on a brief stall.
const PART_TIMEOUT_FLOOR_MS = 120000;
const PART_TIMEOUT_BYTES_PER_SEC = 200 * 1024;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * §213 — this multipart upload does not exist any more.
 *
 * Its own type because the ACTION is specific and must not be reached by
 * accident: start a fresh upload for this file. Everything else — a 502,
 * a reset connection, a 429, an expired login — waits.
 */
class UploadSessionGone extends Error {
  constructor(message) {
    super(message || "That upload session no longer exists");
    this.name = "UploadSessionGone";
  }
}

/**
 * How many parts may be in flight for a given part size.
 *
 * Exported so the test harness asserts the budget rather than re-deriving
 * it, and so the number in the §213 report ("worst case N x part_size")
 * comes from the code rather than from arithmetic in a comment.
 */
function workerCountFor(partSize, totalParts) {
  const byBudget = Math.max(1, Math.floor(PART_BUFFER_BUDGET_BYTES / Math.max(1, partSize)));
  return Math.max(1, Math.min(CONCURRENT_PARTS, byBudget, totalParts));
}

/**
 * §212 — was this error the user pressing Cancel?
 *
 * One predicate, because two places need the same answer and they must not
 * disagree: `uploadFile` throws it, and `runUpload`'s per-file catch has to
 * decide whether to record a failure. A cancelled file is not a failed one —
 * recording it as an error made every cancel report "1 file failed", and the
 * summary already carries `cancelled: true`.
 */
function isCancellationError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /upload cancelled|the operation was aborted/i.test(String(err.message || err));
}

/**
 * Is this attempt worth repeating?
 *
 * Split out and exported so the policy is one list rather than a condition
 * spread through the worker loop. `null` status means fetch itself threw —
 * network down, connection reset, DNS, or our own per-attempt timeout.
 *
 * §213 — 401 is NOT in here. An expired login that cannot refresh is not
 * weather and not a refusal either: the upload parks until the user signs
 * in, which is handled explicitly in `putPartWithRetry`.
 */
function isRetryablePartFailure(status) {
  if (status === null) return true;          // threw: network, reset, timeout
  if (status === 408 || status === 425) return true;
  if (status === 429) return true;           // throttled, not refused
  if (status >= 500) return true;            // 502/503/504 and friends
  return false;                              // every other 4xx is an answer
}

/**
 * §213 — which parts the store already holds for an upload.
 *
 * The SERVER's list, never a client-side record of what we think we sent:
 * a crash can lose the note without losing the bytes, and the expensive
 * mistake is re-sending 5,000 parts that are already there.
 */
async function listUploadParts(s3Key, uploadId) {
  const q = `/upload/parts?s3_key=${encodeURIComponent(s3Key)}`
    + `&upload_id=${encodeURIComponent(uploadId)}`;
  try {
    const res = await apiRequest("GET", q);
    return Array.isArray(res && res.parts) ? res.parts : [];
  } catch (err) {
    if (err && (err.code === "no_such_upload" || err.status === 404)) {
      throw new UploadSessionGone(err.message);
    }
    throw err;
  }
}

/**
 * §213 — does this recorded session still describe the file on disk?
 *
 * Size AND mtime. Resuming into a session whose source has been replaced
 * would splice two different files together into one object and complete
 * it as if it were whole — the one failure mode worse than re-uploading.
 */
function uploadSessionMatchesSource(session, stat) {
  if (!session || typeof session !== "object") return false;
  if (!session.s3Key || !session.uploadId) return false;
  if (Number(session.size) !== Number(stat.size)) return false;
  if (session.mtimeMs != null && Math.round(Number(session.mtimeMs)) !== Math.round(stat.mtimeMs)) {
    return false;
  }
  return true;
}

async function uploadFile({
  projectId,
  filePath,
  assetName,
  folderId = null,
  onProgress = () => {},
  // §212 — retries are surfaced, not hidden. A part on its fourth attempt
  // looks exactly like a frozen upload otherwise, which is what 38 minutes of
  // the real incident felt like from the panel.
  onRetry = () => {},
  // §213 — called with the multipart session as soon as it exists and
  // BEFORE the first part is sent, so a crash one second later still
  // leaves something to resume from. The caller journals it.
  onSession = () => {},
  // §213 — a session recorded by a previous, interrupted run. Used only
  // if it still matches the file on disk.
  resumeSession = null,
  // Cancel. Threaded from runUpload's _cancel so an in-flight PUT is aborted
  // rather than waited out — a 100 GB file used to mean hours.
  signal = null,
  // §213 — pause, at PART granularity. Awaited before a worker claims its
  // next part: parts already in flight finish (aborting them would throw
  // away bytes that are nearly there), nothing new starts, and the S3
  // session is kept so Resume continues from the next unclaimed part.
  waitIfPaused = null,
  // §213 — an expired login that `apiRequest` could not refresh. Awaited
  // instead of failing the upload: the file is still on disk and the parts
  // are still in the bucket, so the only correct response to "signed out"
  // is to wait for a sign-in.
  waitForAuth = null,
  // Injected only by tests, so a backoff schedule runs in milliseconds
  // instead of minutes. Production passes nothing.
  retry: retryOpts = {},
} = {}) {
  // §213 — `attempts` has NO production default any more (it is Infinity:
  // a transient failure never ends an upload). It stays injectable because
  // a test asserting what happens around the boundary needs a boundary.
  const attempts = retryOpts.attempts ?? Infinity;
  const baseMs = retryOpts.baseMs ?? RETRY_BASE_MS;
  const capMs = retryOpts.capMs ?? RETRY_CAP_MS;
  const sleep = retryOpts.sleep ?? defaultSleep;
  const random = retryOpts.random ?? Math.random;

  const stat = await fsp.stat(filePath);
  const fileName = path.basename(filePath);

  const mimeType = mimeForFilename(fileName);
  if (!mimeType) {
    // Refused here rather than sent as octet-stream. The server would
    // accept octet-stream and then classify this as a video, transcode it
    // as one, fail, and hide the result — an upload that reports success
    // and produces nothing visible. Better to say we didn't upload it.
    //
    // §212 — runUpload now asks `mimeForFilename` itself BEFORE calling this,
    // so a camera sidecar is a skip rather than a failure. This throw remains
    // as the backstop for any other caller.
    throw new Error(
      `Unrecognised file type "${path.extname(fileName) || fileName}" — FreeFrame would file this as a video and fail to process it`
    );
  }

  // §213 — a session whose source has CHANGED is not resumed. The stale
  // one is aborted rather than left: we know for certain it can never be
  // completed, so it is pure orphaned storage. (A session we might still
  // resume is never aborted — that is the whole point of §213.)
  let resume = null;
  let freshReason = null;
  if (resumeSession && resumeSession.s3Key && resumeSession.uploadId) {
    if (uploadSessionMatchesSource(resumeSession, stat)) {
      resume = resumeSession;
    } else {
      freshReason = "the source file changed since it was last uploaded";
      try {
        await apiRequest("POST", "/upload/abort", {
          s3_key: resumeSession.s3Key,
          upload_id: resumeSession.uploadId,
          version_id: resumeSession.versionId,
        });
      } catch {
        /* best effort — an un-abortable stale session is §215's problem */
      }
    }
  }

  // Two rounds at most: the second exists for the one case that genuinely
  // needs a different session — the server says this upload is gone.
  for (let round = 0; ; round++) {
    try {
      return await runSession(resume, freshReason);
    } catch (err) {
      if (err instanceof UploadSessionGone && round === 0) {
        resume = null;
        freshReason = "the previous upload session no longer existed on the server";
        continue;
      }
      throw err;
    }
  }

  async function runSession(resumeFrom, reasonForFresh) {
    let s3_key;
    let upload_id;
    let asset_id;
    let version_id;
    let partSize;
    let existing = new Map();   // partNumber -> ETag, already in the store

    if (resumeFrom) {
      s3_key = resumeFrom.s3Key;
      upload_id = resumeFrom.uploadId;
      asset_id = resumeFrom.assetId;
      version_id = resumeFrom.versionId;
      // The part size the ORIGINAL run used, not a freshly planned one.
      // The server's answer can legitimately change between runs (§214
      // raises the cap), and re-planning would renumber every remaining
      // part against bytes already stored under the old numbering.
      partSize = Number(resumeFrom.partSize) || PART_SIZE;
    } else {
      const init = await apiRequest("POST", "/upload/initiate", {
        project_id: projectId,
        asset_name: assetName || fileName,
        original_filename: fileName,
        file_size_bytes: stat.size,
        mime_type: mimeType,
        folder_id: folderId,
      });
      s3_key = init.s3_key;
      upload_id = init.upload_id;
      asset_id = init.asset_id;
      version_id = init.version_id;
      // The server's choice; our constant only if it is too old to have one.
      partSize = Number(init.part_size) > 0 ? Number(init.part_size) : PART_SIZE;
    }

    const totalParts = Math.max(1, Math.ceil(stat.size / partSize));

    // The client-side sanity check on the server's answer. The server
    // refuses an impossible size with 413 before creating anything, so
    // reaching here means the two disagree — which is worth saying out
    // loud rather than discovering at part 10,001 after several hours.
    if (totalParts > MAX_PARTS) {
      const gib = (n) => (n / 1024 / 1024 / 1024).toFixed(1);
      if (!resumeFrom) await disposeUpload("impossible part count", { s3_key, upload_id, version_id });
      throw new Error(
        `This file is ${gib(stat.size)} GiB, which needs ${totalParts} parts at the `
        + `${(partSize / 1024 / 1024).toFixed(0)} MiB part size the server chose — more than the `
        + `${MAX_PARTS} S3 allows. The server should have refused this; please report it.`
      );
    }

    const session = {
      s3Key: s3_key,
      uploadId: upload_id,
      assetId: asset_id,
      versionId: version_id,
      partSize,
      totalParts,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    // BEFORE the first part. A crash between initiate and part 1 otherwise
    // leaves a multipart upload nothing can ever find again.
    try { await onSession(session); } catch { /* journalling must not fail an upload */ }

    if (resumeFrom) {
      // The store's own answer about what it holds.
      const listed = await listUploadParts(s3_key, upload_id);
      for (const p of listed) {
        const n = Number(p.PartNumber);
        if (!(n >= 1 && n <= totalParts)) continue;      // from a different plan
        const expected = n < totalParts
          ? partSize
          : stat.size - (totalParts - 1) * partSize;
        // §213 — A PART IS NEVER TRUSTED ON ITS NUMBER ALONE. A short part
        // is a partial write, and completing an upload around one produces
        // a corrupt object that passes every other check we have.
        if (Number(p.Size) !== expected) continue;
        if (!p.ETag) continue;
        existing.set(n, p.ETag);
      }
    }

    const parts = new Array(totalParts);
    for (const [n, etag] of existing) parts[n - 1] = { PartNumber: n, ETag: etag };

    // Progress starts at the bytes already present, not at 0%. A resumed
    // 97 GiB upload that reports 0% is indistinguishable from one that
    // threw everything away.
    let uploaded = [...existing.keys()].reduce((sum, n) => sum + (
      n < totalParts ? partSize : stat.size - (totalParts - 1) * partSize
    ), 0);
    const resumedBytes = uploaded;

    /**
     * §212/§213 — the one place that gives up on a multipart upload.
     *
     * §212 created it because five failed attempts left 92.3 GiB of
     * orphaned parts in the bucket, invisible to the app and billed for.
     * §213 narrows WHO may call it to the only three cases where the
     * session is provably worthless:
     *
     *   - the user pressed Cancel
     *   - the source file changed, so this session can never be completed
     *   - the server and client disagree about the part plan
     *
     * A transient failure no longer aborts. That is the §213 contract, and
     * its cost is explicit: an upload interrupted and never resumed leaves
     * its parts in the bucket until something reaps them (§215).
     *
     * Best-effort by contract. A failing abort must never replace the error
     * that caused it — that would turn "part 1103 got a 502" into "abort
     * returned 500", which hides the actual problem.
     */
    async function disposeUpload(reason, target) {
      const t = target || { s3_key, upload_id, version_id };
      try {
        await apiRequest("POST", "/upload/abort", {
          s3_key: t.s3_key, upload_id: t.upload_id, version_id: t.version_id,
        });
      } catch (err) {
        console.error(
          `[upload] abort after ${reason} failed for ${fileName}: ${String(err && err.message || err)}`
        );
      }
    }

    /**
     * One part, with the whole retry policy around it.
     *
     * Re-presigns on EVERY attempt. A presigned URL carries its own expiry and
     * signature; reusing one across a long backoff is how a retry that
     * should have worked returns 403 instead.
     *
     * The buffer is read once by the caller and reused across attempts — a
     * retry must not re-read the disk.
     */
    async function putPartWithRetry(partNumber, buf) {
      let lastError = null;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal && signal.aborted) throw new Error("Upload cancelled");

        let status = null;
        let code = null;
        let detail = "";
        // An empty ETag arrives on an HTTP 200, so the status alone says
        // "don't retry" — `isRetryablePartFailure(200)` is false, correctly, for
        // every other purpose. This flag is how that one case overrides it.
        let forceRetry = false;
        try {
          const { presigned_url } = await apiRequest("POST", "/upload/presign-part", {
            s3_key, upload_id, part_number: partNumber,
          });

          // Per-attempt deadline, plus the caller's cancel. Two signals, so a
          // cancel aborts immediately rather than waiting out the timeout.
          // Scales with the part size, so a 512 MiB part is not judged
          // against a 16 MiB part's patience.
          const timeoutMs = Math.max(
            PART_TIMEOUT_FLOOR_MS,
            (buf.length / PART_TIMEOUT_BYTES_PER_SEC) * 1000
          );
          const ac = new AbortController();
          const onOuterAbort = () => ac.abort();
          if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
          const timer = setTimeout(() => ac.abort(), timeoutMs);

          let put;
          try {
            put = await fetch(presigned_url, { method: "PUT", body: buf, signal: ac.signal });
          } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", onOuterAbort);
          }

          if (signal && signal.aborted) throw new Error("Upload cancelled");

          if (put.ok) {
            const etag = put.headers.get("ETag") || "";
            if (etag) return etag;
            // An empty ETag is a failed attempt, not a success. It used to be
            // stored as "" and only surfaced hours later as a rejected
            // /upload/complete — by which point the whole file had been sent.
            status = put.status;
            detail = "no ETag in the response";
            forceRetry = true;
          } else {
            status = put.status;
            detail = `${put.status} ${put.statusText}`;
          }
        } catch (err) {
          // Our own cancel is not a retryable condition.
          if (signal && signal.aborted) throw new Error("Upload cancelled");
          // A presign (or any API call above) that came back with a permanent
          // 4xx is an answer, not a blip — carry its status through so the
          // policy below fails fast instead of backing off forever.
          status = typeof err?.status === "number" ? err.status : null;
          code = typeof err?.code === "string" ? err.code : null;
          detail = String(err && err.message || err);
        }

        // §213 — the session itself is gone. Nothing here can be retried
        // and there is nothing to abort; the file needs a NEW upload, which
        // `uploadFile`'s outer loop starts.
        if (status === 404 || code === "no_such_upload") {
          throw new UploadSessionGone(detail);
        }

        // §213 — signed out, and `apiRequest` could not refresh. The bytes
        // are on disk and the parts are in the bucket; the only wrong move
        // is to throw the upload away. Park, then try again — and do NOT
        // count this as a retry attempt, because the wait is not a backoff.
        if (status === 401) {
          onRetry({
            part: partNumber, attempt, of: null, delayMs: null,
            reason: detail, waitingFor: "auth",
          });
          if (waitForAuth) {
            await waitForAuth();
          } else {
            await sleep(Math.min(capMs, baseMs * 8));
          }
          attempt -= 1;   // the sign-in wait is not an attempt
          continue;
        }

        lastError = new Error(`Part ${partNumber} failed: ${detail}`);

        if (!forceRetry && !isRetryablePartFailure(status)) {
          // A 400/403 that survived a fresh presign is an answer, not
          // weather. Failing fast beats retrying a refusal forever.
          throw lastError;
        }
        if (attempt >= attempts) break;

        // Full jitter — a uniform pick from [0, window) rather than
        // window/2 + jitter: workers riding out the same outage must not
        // synchronise, and partial jitter keeps them loosely in step.
        //
        // The window doubles to the cap and then STAYS there. §213's change
        // is that the loop does not end when it gets there.
        const window = Math.min(capMs, baseMs * 2 ** (attempt - 1));
        const delay = Math.floor(random() * window);
        onRetry({
          part: partNumber,
          attempt,
          // null, not a denominator: there is no budget to count towards
          // any more, and "retrying 12/12" was a promise to stop.
          of: null,
          delayMs: delay,
          reason: detail,
          // The distinct state the panel renders. Once the window is at the
          // cap this is a connection problem, not a hiccup, and saying so
          // is the difference between "it is working on it" and "it is
          // stuck".
          waitingFor: window >= capMs ? "connection" : null,
          nextAttemptAt: Date.now() + delay,
        });
        await sleep(delay);
      }

      throw lastError || new Error(`Part ${partNumber} failed`);
    }

    /**
     * /upload/complete, with the same never-give-up policy as a part.
     *
     * A 502 on the way into complete used to abort the upload — throwing
     * away every byte over the one request that happened to be unlucky.
     */
    async function completeWithRetry() {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal && signal.aborted) throw new Error("Upload cancelled");
        try {
          await apiRequest("POST", "/upload/complete", {
            s3_key, upload_id, asset_id, version_id, parts,
          });
          return;
        } catch (err) {
          const status = typeof err?.status === "number" ? err.status : null;
          const code = typeof err?.code === "string" ? err.code : null;
          if (status === 404 || code === "no_such_upload") throw new UploadSessionGone(String(err.message || err));
          if (status === 401) {
            if (waitForAuth) await waitForAuth(); else await sleep(Math.min(capMs, baseMs * 8));
            attempt -= 1;
            continue;
          }
          if (!isRetryablePartFailure(status)) throw err;
          if (attempt >= attempts) throw err;
          const window = Math.min(capMs, baseMs * 2 ** (attempt - 1));
          const delay = Math.floor(random() * window);
          onRetry({
            part: null, attempt, of: null, delayMs: delay,
            reason: `completing the upload: ${String(err.message || err)}`,
            waitingFor: window >= capMs ? "connection" : null,
            nextAttemptAt: Date.now() + delay,
          });
          await sleep(delay);
        }
      }
      throw new Error("Could not complete the upload");
    }

    const missing = [];
    for (let n = 1; n <= totalParts; n++) if (!existing.has(n)) missing.push(n);

    if (missing.length) {
      const fh = await fsp.open(filePath, "r");
      let firstError = null;
      try {
        let nextIndex = 0;
        // §212 — the shared stop flag. `Promise.all` rejected on the first
        // failure while the other workers carried on against a file handle
        // `finally` was about to close: a read-after-close, and more parts
        // uploaded for a file already doomed.
        let failed = false;

        const worker = async () => {
          for (;;) {
            if (failed) return;
            if (signal && signal.aborted) return;
            // §213 — PAUSE, checked before CLAIMING. A part already claimed
            // runs to completion; nothing new is started while paused; the
            // session is untouched, so Resume continues from here.
            if (waitIfPaused) await waitIfPaused();
            if (failed) return;
            if (signal && signal.aborted) return;

            const idx = nextIndex++;
            if (idx >= missing.length) return;
            const partNumber = missing[idx];

            const offset = (partNumber - 1) * partSize;
            const length = Math.min(partSize, stat.size - offset);
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, offset);

            try {
              const etag = await putPartWithRetry(partNumber, buf);
              parts[partNumber - 1] = { PartNumber: partNumber, ETag: etag };
            } catch (err) {
              failed = true;
              if (!firstError) firstError = err;
              return;
            }

            uploaded += length;
            onProgress({
              uploaded, total: stat.size, part: partNumber, totalParts,
              resumedBytes,
            });
          }
        };

        // allSettled, not all: every worker must be finished before the handle
        // closes. The first real error is rethrown below, after the handle is
        // safely shut.
        await Promise.allSettled(
          Array.from({ length: workerCountFor(partSize, missing.length) }, worker)
        );
      } finally {
        await fh.close();
      }

      if (signal && signal.aborted) {
        // Cancel is one of the three things that may END an upload, so the
        // session is aborted and the bucket space freed.
        await disposeUpload("cancel");
        throw new Error("Upload cancelled");
      }
      if (firstError) {
        // §213 — NO ABORT. The parts that did land stay, and the session
        // stays resumable. This is the single change the whole task turns
        // on: a failure here used to cost everything already transferred.
        throw firstError;
      }
    } else if (signal && signal.aborted) {
      await disposeUpload("cancel");
      throw new Error("Upload cancelled");
    }

    await completeWithRetry();

    return {
      assetId: asset_id,
      versionId: version_id,
      bytes: stat.size,
      fileName,
      // §213 — what the caller reports and journals. A resumed file that
      // says nothing about having been resumed is how a 3-of-975 run looks
      // like a broken one.
      resumed: Boolean(resumeFrom),
      partSize,
      totalParts,
      partsAlreadyPresent: existing.size,
      resumedBytes,
      freshBecause: reasonForFresh || null,
    };
  }
}

/**
 * §97A — which of these assets does the server still have?
 *
 * ONE call per resumed job, with every id the journal claims uploaded.
 * The whole point of the journal is to avoid a round trip per file;
 * replacing per-file uploads with per-file checks would trade nothing for
 * nothing.
 *
 * Returns a Set of surviving ids. The caller re-uploads everything not in
 * it, so an unknown id, a deleted one and a permission failure all reach
 * the same, safe conclusion: do the work again.
 */
async function checkExistingAssets(assetIds) {
  const ids = [...new Set((assetIds || []).filter((x) => typeof x === "string" && x))];
  if (!ids.length) return new Set();
  const res = await apiRequest("POST", "/assets/check-existing", { asset_ids: ids });
  return new Set((res && res.existing_ids) || []);
}

module.exports = {
  DEFAULT_BASE_URL,
  webSession,
  loadSession,
  clearSession,
  login,
  adoptSession,
  verifyTwoFactorLogin,
  sendTwoFactorEmailFallback,
  sendTwoFactorReauthCode,
  setupTwoFactor,
  confirmTwoFactorSetup,
  disableTwoFactor,
  regenerateBackupCodes,
  status,
  refreshAccessToken,
  apiRequest,
  listProjects,
  folderTree,
  listAssets,
  openAssetStream,
  uploadFile,
  listUploadParts,
  checkExistingAssets,
  mimeForFilename,
  // §212 — exported for scripts/test-upload-resilience.js, which asserts the
  // policy as a table rather than inferring it from retry counts.
  isRetryablePartFailure,
  isCancellationError,
  // §213 — exported for the same reason: the resume harness has to be able
  // to recognise a gone session and to assert the concurrency budget
  // rather than re-deriving either.
  UploadSessionGone,
  uploadSessionMatchesSource,
  workerCountFor,
  MAX_PARTS,
  PART_SIZE,
  PART_BUFFER_BUDGET_BYTES,
  CONCURRENT_PARTS,
  // Test seam: lets the harness drive the client without real credentials.
  __setState: (patch) => Object.assign(state, patch),
  __getState: () => ({ ...state }),
};
