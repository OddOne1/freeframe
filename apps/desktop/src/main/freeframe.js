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
  const res = await rawRequest("POST", "/auth/refresh", {
    body: { refresh_token: state.refreshToken },
  });
  if (!res.ok) {
    // The refresh token is dead (expired/revoked) — drop the session
    // rather than retrying forever against a credential that can't work.
    await clearSession();
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

// ── Resources ────────────────────────────────────────────────────────────

const listProjects = () => apiRequest("GET", "/projects");
const folderTree = (projectId) => apiRequest("GET", `/projects/${projectId}/folder-tree`);

// ── Upload (multipart) ───────────────────────────────────────────────────

// Mirrors apps/web/stores/upload-store.ts's flow rather than inventing a
// second one: initiate -> presign each part -> PUT it -> complete with the
// collected {PartNumber, ETag} list.
const PART_SIZE = 16 * 1024 * 1024;
const CONCURRENT_PARTS = 3;

async function uploadFile({ projectId, filePath, assetName, folderId = null, onProgress = () => {} }) {
  const stat = await fsp.stat(filePath);
  const fileName = path.basename(filePath);

  const init = await apiRequest("POST", "/upload/initiate", {
    project_id: projectId,
    asset_name: assetName || fileName,
    original_filename: fileName,
    file_size_bytes: stat.size,
    mime_type: "application/octet-stream",
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
  loadSession,
  clearSession,
  login,
  status,
  refreshAccessToken,
  apiRequest,
  listProjects,
  folderTree,
  uploadFile,
  // Test seam: lets the harness drive the client without real credentials.
  __setState: (patch) => Object.assign(state, patch),
  __getState: () => ({ ...state }),
};
