// Byte formatting, the viewer's-own-OS way (§190).
//
// One implementation, matching the principle panel.js already states for
// the docked/detached split — applied here to the byte maths itself, which
// had been written TWICE inside this app alone (panel.js's `fmtBytes` and
// an inline `formatBytes` in index.html) and a third and fourth time in
// apps/web. All four divided by 1024 and labelled the result "MB", which by
// SI definition means 1000-based.
//
// Found against real data: a 135,458,109-byte file that macOS Finder calls
// "135,5 MB" showed as "129.2 MB". The byte count was never wrong.
//
// "Just use decimal" is wrong too, because file managers disagree:
//
//   macOS / iOS / Android / GNOME Files   decimal (1000), labelled MB
//   Windows Explorer                      BINARY (1024), still labelled MB
//   KDE Dolphin                           binary, labelled MiB
//
// So the convention follows the platform. On Electron that is
// `process.platform`, which is exact — no user-agent guessing, and no
// SSR/hydration problem, because nothing here is server-rendered.
//
// Plain script, no module system: the renderer has no bundler, so this is
// loaded with a <script> tag and hangs one object off window, the same way
// panel.js and icons.js already are. It is also require()-able from Node so
// the test script can exercise it directly.
(function (root) {
  /**
   * @param {string} platform - a `process.platform` value.
   * @returns {'binary'|'decimal'}
   */
  function byteUnitModeFor(platform) {
    return platform === "win32" ? "binary" : "decimal";
  }

  /**
   * @param {number|null|undefined} bytes
   * @param {'binary'|'decimal'} mode
   * @returns {string} e.g. "135.5 MB", or "—" when there is no size.
   */
  function formatBytesIn(bytes, mode) {
    if (bytes == null) return "—";
    if (!bytes) return "0 B";
    const base = mode === "binary" ? 1024 : 1000;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let n = Math.abs(bytes);
    while (n >= base && i < units.length - 1) {
      n /= base;
      i += 1;
    }
    if (i === 0) return `${Math.round(bytes)} B`;
    return `${(bytes < 0 ? -n : n).toFixed(1)} ${units[i]}`;
  }

  /**
   * The renderer's entry point. Resolved once per call rather than cached
   * at load: `platform` is injected through the preload contextBridge
   * (contextIsolation is on and nodeIntegration off — the renderer has no
   * `process` of its own), and the bridge may not be attached yet when this
   * script is parsed.
   *
   * Falls back to decimal when the bridge is unavailable, matching the web
   * app's default and the majority of platforms.
   */
  function formatBytes(bytes) {
    // The global is resolved HERE, not captured when this file was parsed:
    // the contextBridge attaches `window.freeframe` and the ordering of
    // that against <script> evaluation is not something to rely on. (It
    // also keeps the function honest under Node, where `window` is not
    // `globalThis`, so the test harness can exercise both branches.)
    const g = typeof window !== "undefined" ? window : globalThis;
    const platform =
      (g.freeframe && g.freeframe.platform) ||
      (typeof process !== "undefined" && process.platform) ||
      "";
    return formatBytesIn(bytes, byteUnitModeFor(platform));
  }

  const api = { formatBytes, formatBytesIn, byteUnitModeFor };
  root.ByteUnits = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
