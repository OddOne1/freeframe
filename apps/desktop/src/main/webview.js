// Embedded FreeFrame web view (§60b).
//
// WHY WebContentsView AND NOT <webview>:
//
// A <webview> tag would require `webviewTag: true` on the main window's
// webPreferences — the one window that deliberately runs sandboxed with no
// Node access because it drives real drives (see main.js's own comment on
// that block). Electron's own docs discourage the tag, and turning it on
// to embed a page would weaken the exact posture that comment defends.
// BrowserView is the other option, but it is deprecated as of Electron 30
// and this app is on 31.7.7. WebContentsView is the current API: a real
// child view of the window, its own webContents, its own preload, and the
// main window's security settings stay untouched.
//
// LIFETIME: created once, on the first switch to the FreeFrame page, then
// kept for the life of the window. Switching pages adds/removes it as a
// child view rather than destroying it, so scroll position, the open
// project and any in-flight upload survive a trip to the Offload page.
// Destroying and reloading on every switch would be cheaper to write and
// considerably worse to use.

const path = require("node:path");
const { WebContentsView, shell } = require("electron");

let view = null;
let attached = false;
let ownerWindow = null;
let loadedUrl = null;
// How far down the window the embedded page starts. The app's own header
// carries the page switcher, so the view must not cover it — and the
// header WRAPS (§25b), so its height is not a constant this process can
// assume. The renderer measures it and sends it in.
let insetTop = 0;

function boundsFor(win) {
  const [width, height] = win.getContentSize();
  return { x: 0, y: insetTop, width, height: Math.max(0, height - insetTop) };
}

function syncBounds() {
  if (!view || !attached || !ownerWindow || ownerWindow.isDestroyed()) return;
  view.setBounds(boundsFor(ownerWindow));
}

/**
 * Build the view, injecting the desktop's session via preload arguments.
 *
 * The tokens ride in as `additionalArguments` rather than being pushed in
 * after load, because the web app reads them while it boots — see
 * webview-preload.js for the timing argument.
 */
function create(win, { webUrl, accessToken, refreshToken }) {
  view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "webview-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--ff-access=${accessToken || ""}`,
        `--ff-refresh=${refreshToken || ""}`,
      ],
    },
  });

  // Anything that isn't the FreeFrame app opens in the real browser. An
  // OAuth page or a support link should not become a chromeless window
  // inside a file-copy tool with no address bar to check.
  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url, webUrl)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  loadedUrl = webUrl;
  view.webContents.loadURL(webUrl);
  return view;
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Update the top inset alone, for a header that has changed height. */
function setInset(top) {
  insetTop = Number.isFinite(top) && top > 0 ? Math.round(top) : 0;
  syncBounds();
  return { ok: true };
}

/** Show the embedded page, creating it on first use. */
function show(win, session, top = 0) {
  ownerWindow = win;
  insetTop = Number.isFinite(top) && top > 0 ? Math.round(top) : 0;
  if (!view) create(win, session);
  if (!attached) {
    win.contentView.addChildView(view);
    attached = true;
    win.on("resize", syncBounds);
  }
  syncBounds();
  return { ok: true, url: loadedUrl };
}

/** Reload the embedded app in place (§64). No-op when the view has never
 *  been created — Refresh on the Offload page must not build one. */
function reload() {
  if (!view) return { ok: false, reason: "not-created" };
  view.webContents.reload();
  return { ok: true };
}

/** Hide it without destroying it — see LIFETIME above. */
function hide() {
  if (view && attached && ownerWindow && !ownerWindow.isDestroyed()) {
    ownerWindow.contentView.removeChildView(view);
  }
  attached = false;
  return { ok: true };
}

/**
 * Tear the view down entirely.
 *
 * DECISION, asked for explicitly by the spec: logging out of the DESKTOP
 * app also clears the embedded view. One account, one backend, one visible
 * "Log out" — leaving a logged-in FreeFrame page one click away after the
 * user signed out would be a genuine security surprise, and there is no
 * reading of "log out" under which it should not apply to the window
 * showing that same account's files.
 *
 * The reverse is deliberately NOT symmetric: logging out INSIDE the web
 * view clears only the web view (its own localStorage/cookies, and the
 * preload does not re-inject — see its sessionStorage marker). The desktop
 * app keeps its own session, so browsing projects as a copy destination
 * keeps working. Detecting the web app's internal logout would mean
 * coupling to its implementation, and signing someone out of a running
 * transfer tool because they logged out of a page inside it would be the
 * worse surprise in that direction.
 */
function destroy() {
  hide();
  if (view) {
    try { view.webContents.close(); } catch { /* already gone */ }
  }
  view = null;
  ownerWindow = null;
  loadedUrl = null;
  return { ok: true };
}

const isAttached = () => attached;
const exists = () => Boolean(view);

module.exports = { show, hide, destroy, reload, setInset, syncBounds, sameOrigin, isAttached, exists };
