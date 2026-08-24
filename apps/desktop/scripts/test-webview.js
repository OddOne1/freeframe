#!/usr/bin/env node
// Embedded FreeFrame web view (CLAUDE.md §60b) — the parts that are
// answerable without a window.
//
// Three things here are worth pinning independently of the running app,
// because each one fails silently rather than loudly:
//   * the web URL is DERIVED from the same baseUrl the API calls use. A
//     second hardcoded copy would point a staging desktop at production
//     and nothing would look wrong until the wrong files appeared.
//   * the origin guard decides what stays inside a chromeless window with
//     no address bar. Getting it backwards is a phishing surface.
//   * the top inset is what keeps the page switcher reachable. An off-by-
//     a-header view covers its own way out.
//
// Run: node scripts/test-webview.js
const path = require("node:path");
const Module = require("node:module");

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

// ── A fake electron, so these modules load outside a real app ────────────
const windows = [];
class FakeView {
  constructor(opts) { this.opts = opts; this.bounds = null; this.webContents = fakeContents(); }
  setBounds(b) { this.bounds = b; }
}
function fakeContents() {
  return {
    loaded: null, handlers: {},
    loadURL(u) { this.loaded = u; },
    on(ev, fn) { this.handlers[ev] = fn; },
    setWindowOpenHandler(fn) { this.openHandler = fn; },
    close() { this.closed = true; },
  };
}
const opened = [];
const fakeElectron = {
  WebContentsView: FakeView,
  shell: { openExternal: async (u) => { opened.push(u); } },
  app: { getPath: () => "/tmp/ff-test" },
  safeStorage: { isEncryptionAvailable: () => false },
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "electron") return "electron-stub";
  return realResolve.call(this, req, ...rest);
};
require.cache["electron-stub"] = { id: "electron-stub", filename: "electron-stub", loaded: true, exports: fakeElectron };

const webview = require(path.join(__dirname, "..", "src", "main", "webview.js"));
const freeframe = require(path.join(__dirname, "..", "src", "main", "freeframe.js"));

// ── 1. The web URL comes off the API base URL ───────────────────────────
console.log("1. Web URL derivation");
(async () => {
  const s = await freeframe.webSession();
  check(s.webUrl === "https://frame.yon.studio",
    "the default API base URL yields the web app's origin", s.webUrl);
  check(!/\/api\/?$/.test(s.webUrl),
    "with the /api segment stripped rather than a second hardcoded constant");
  check(s.accessToken === null && s.refreshToken === null,
    "and no tokens when the desktop app is logged out — the embedded app then shows its own login");

  // ── 2. The origin guard ──
  console.log("2. Origin guard");
  const app = "https://frame.yon.studio";
  check(webview.sameOrigin(`${app}/projects/123`, app), "an in-app path stays inside");
  check(webview.sameOrigin(app, app), "so does the root");
  check(!webview.sameOrigin("https://evil.example/login", app),
    "another host does not — it would render with no address bar to check it against");
  check(!webview.sameOrigin("http://frame.yon.studio", app),
    "and neither does the same host over plain http: a downgrade is not the same origin");
  check(!webview.sameOrigin("javascript:alert(1)", app), "an unparseable URL is refused, not allowed through");
  check(!webview.sameOrigin("", app), "and so is an empty one");

  // ── 3. Bounds: the header must stay reachable ──
  console.log("3. Layout");
  const win = {
    getContentSize: () => [900, 600],
    contentView: {
      children: [],
      addChildView(v) { this.children.push(v); },
      removeChildView(v) { this.children = this.children.filter((c) => c !== v); },
    },
    isDestroyed: () => false,
    on() {},
  };
  webview.show(win, { webUrl: app, accessToken: "acc", refreshToken: "ref" }, 48);
  const view = win.contentView.children[0];
  check(Boolean(view), "showing attaches the view to the window");
  check(view.bounds && view.bounds.y === 48,
    "positioned below the app header, not over it — the page switcher lives there");
  check(view.bounds && view.bounds.height === 600 - 48,
    "and shortened by the same amount, so the bottom is not pushed off-screen");
  check(view.webContents.loaded === app, "loading the derived URL");

  check(view.opts.webPreferences.additionalArguments.includes("--ff-access=acc")
    && view.opts.webPreferences.additionalArguments.includes("--ff-refresh=ref"),
    "with the desktop's tokens handed to the preload");
  check(view.opts.webPreferences.contextIsolation === true
    && view.opts.webPreferences.nodeIntegration === false
    && view.opts.webPreferences.sandbox === true,
    "and the same sandboxed posture as the main window");

  webview.setInset(70);
  check(view.bounds.y === 70 && view.bounds.height === 530,
    "a header that reflows to a second row moves the view rather than being covered");

  // ── 4. Lifetime ──
  console.log("4. Lifetime");
  webview.hide();
  check(win.contentView.children.length === 0, "hiding detaches it");
  check(!view.webContents.closed,
    "but does NOT destroy it — a trip to the Offload page must not reload the page or drop an upload");
  webview.show(win, { webUrl: app }, 48);
  check(win.contentView.children[0] === view,
    "and switching back re-attaches the SAME view, so scroll position and open project survive");

  webview.destroy();
  check(win.contentView.children.length === 0 && view.webContents.closed,
    "logging out of the desktop app tears it down for real");
  webview.show(win, { webUrl: app, accessToken: "acc2", refreshToken: "ref2" }, 48);
  check(win.contentView.children[0] !== view,
    "and the next show builds a fresh one rather than resurrecting the logged-out session");
  check(win.contentView.children[0].opts.webPreferences.additionalArguments.includes("--ff-access=acc2"),
    "carrying the new session's tokens");

  // ── 5. Off-origin navigation leaves the window ──
  console.log("5. External navigation");
  const v2 = win.contentView.children[0];
  let prevented = false;
  v2.webContents.handlers["will-navigate"]({ preventDefault: () => { prevented = true; } }, "https://evil.example/");
  check(prevented && opened.includes("https://evil.example/"),
    "an off-origin navigation is blocked here and handed to the real browser");
  prevented = false;
  v2.webContents.handlers["will-navigate"]({ preventDefault: () => { prevented = true; } }, `${app}/projects/1`);
  check(!prevented, "an in-app navigation is left alone");
  check(v2.webContents.openHandler({ url: "https://example.com" }).action === "deny",
    "and a popup never becomes a second chromeless window");

  // ── 6. The preload's injection contract ──
  //
  // Run in a vm with fake storage rather than asserted by reading the
  // source: the keys have to match apps/web/lib/auth.ts exactly, and a
  // regex over the file would pass just as happily on a typo'd key.
  console.log("6. Token injection");
  const vm = require("node:vm");
  const src = require("node:fs").readFileSync(
    path.join(__dirname, "..", "src", "main", "webview-preload.js"), "utf8");

  function runPreload(argv, storage = {}, session = {}) {
    const cookies = [];
    const ctx = {
      process: { argv },
      localStorage: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = v; },
      },
      sessionStorage: {
        getItem: (k) => (k in session ? session[k] : null),
        setItem: (k, v) => { session[k] = v; },
      },
      document: { set cookie(v) { cookies.push(v); }, get cookie() { return cookies.join("; "); } },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return { storage, session, cookies };
  }

  const injected = runPreload(["electron", "--ff-access=AAA", "--ff-refresh=RRR"]);
  check(injected.storage.ff_access_token === "AAA" && injected.storage.ff_refresh_token === "RRR",
    "writes the exact localStorage keys apps/web/lib/auth.ts reads");
  check(injected.cookies.some((c) => c.startsWith("ff_access_token=AAA;"))
    && injected.cookies.some((c) => c.startsWith("ff_refresh_token=RRR;")),
    "and the matching cookies, so the Next middleware sees them server-side too");
  check(injected.cookies.every((c) => /path=\/;/.test(c) && /SameSite=Lax/.test(c) && /max-age=604800/.test(c)),
    "with the same path, max-age and SameSite that setTokens() uses");

  // Pinned against the web app's own source, not just against each other:
  // this repo's recurring failure is two copies of one rule drifting
  // (§30's _require_download_variant, §32's resolveStreamUrl).
  const authTs = require("node:fs").readFileSync(
    path.join(__dirname, "..", "..", "web", "lib", "auth.ts"), "utf8");
  const webKeys = [...authTs.matchAll(/^const (?:ACCESS|REFRESH)_TOKEN_KEY = '([^']+)'/gm)].map((m) => m[1]);
  check(webKeys.length === 2 && webKeys.every((k) => k in injected.storage),
    "and those keys are the ones apps/web/lib/auth.ts actually declares", webKeys.join(", "));

  const none = runPreload(["electron"]);
  check(Object.keys(none.storage).length === 0 && none.cookies.length === 0,
    "a logged-out desktop injects nothing — the embedded app shows its own login instead");
  const halfway = runPreload(["electron", "--ff-access=AAA", "--ff-refresh="]);
  check(Object.keys(halfway.storage).length === 0,
    "and a half-present session injects nothing rather than a token pair the app cannot refresh");

  const already = runPreload(["electron", "--ff-access=AAA", "--ff-refresh=RRR"], {},
    { ff_desktop_sso_injected: "1" });
  check(Object.keys(already.storage).length === 0,
    "injects ONCE per view, not per navigation: otherwise logging out inside the web view "
    + "would silently sign the user back in on their next click");

  const first = runPreload(["electron", "--ff-access=AAA", "--ff-refresh=RRR"]);
  check(first.session.ff_desktop_sso_injected === "1", "the marker that enforces that is set on injection");

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
