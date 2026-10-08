#!/usr/bin/env node
// §216 — the Settings window must show stored values before anything slow
// resolves.
//
// THE SYMPTOM, as the owner saw it on a first `npm run dev`: the two
// checksum dropdowns looked greyed/empty, and "Resume interrupted uploads
// automatically" was NOT ticked even though §213's default is ON. Ticking
// it made everything appear — because the awaits had finished by then. So
// the window was taking input on a value it had not loaded yet.
//
// WHY THIS IS ITS OWN HARNESS rather than a section in e2e-settings.js:
// that script attaches to the Settings window AFTER it exists, by which
// point the init IIFE has already run to completion. Nothing it can do
// from there observes the ordering. What is needed is a bridge whose slow
// calls have NOT resolved yet while the window is inspected, and that has
// to be in place before the first line of settings-window.js runs.
//
// So this launches Electron with a throwaway main process that loads the
// REAL src/renderer/settings.html — real HTML, real settings-window.js,
// real preset-editor.js, nothing copied or stubbed in the renderer — with
// a PRELOAD that exposes a fake `window.freeframe`. Only the bridge is
// fake, which is exactly the boundary the bug lives on.
//
// DETERMINISM: the slow calls do not resolve on a timer. They park until
// the test calls `window.freeframe.__release()` over CDP, and the test
// asserts `__released() === false` at the moment it checks the controls.
// "Before those calls resolve" is therefore proven, not timed — the
// §212/§213 reviews both found a scheduler-dependent assertion in a test
// that used a sleep for this, and this does not repeat it.
//
// Run: node scripts/e2e-settings-boot.js
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const RENDERER = path.join(APP, "src", "renderer");
// Its own port. e2e-settings.js uses 9377 and this may run beside it.
const PORT_BASE = 9481;
let portSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!fail && !ok) { /* keep going; the count is the verdict */ }
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-settings-boot-"));

/**
 * The fake bridge.
 *
 * `getSettings` and `getAlgorithms` resolve IMMEDIATELY — they are local
 * reads in the real app too (a JSON file in userData, and a constant
 * list). `listVolumes`, `getDisplayNames`, `freeframeStatus` and
 * `listJobs` park: in the real app those walk /Volumes (which on the
 * owner's machine includes an SMB mount) and touch the network.
 */
function preloadSource(opts) {
  return `
const { contextBridge } = require("electron");

const parked = [];
let released = false;
const park = (value) => new Promise((resolve) => {
  if (released) return resolve(value);
  parked.push(() => resolve(value));
});

const STORED = ${JSON.stringify(opts.stored)};
const FAIL_VOLUMES = ${JSON.stringify(Boolean(opts.failVolumes))};
const FAIL_STATUS = ${JSON.stringify(Boolean(opts.failStatus))};
// §216 — parks getSettings TOO, which is the only way to observe the
// window between "the HTML is painted" and "the stored values arrived".
// That interval is milliseconds in reality, so the disabled attributes
// that cover it cannot be asserted any other way: a mutation removing
// them survived every timing-based test in this file.
const PARK_SETTINGS = ${JSON.stringify(Boolean(opts.parkSettings))};

const noop = () => {};
const api = {
  // ── local, immediate (unless a test parks it deliberately) ──
  getSettings: () => (PARK_SETTINGS ? park(STORED) : Promise.resolve(STORED)),
  getAlgorithms: async () => ({
    algorithms: [
      { id: "xxhash64", label: "xxHash64", blurb: "Fast.", recommended: true },
      { id: "md5", label: "MD5", blurb: "Compatible." },
      { id: "sha1", label: "SHA-1", blurb: "Compatible." },
      { id: "c4", label: "C4", blurb: "Provable." },
    ],
    default: "xxhash64",
  }),
  setSettings: async (patch) => {
    Object.assign(STORED, (patch && patch.patch) || patch || {});
    return STORED;
  },
  appInfo: async () => ({ logsPath: "/tmp/logs", version: "0.0.0-test", electron: "test" }),

  // ── slow / networked: parked until __release() ──
  listVolumes: () => (FAIL_VOLUMES
    ? park(null).then(() => { throw new Error("listVolumes exploded"); })
    : park([{ name: "Ichi", mountPoint: "/Volumes/Ichi", isRemovable: false }])),
  getDisplayNames: () => park({}),
  freeframeStatus: () => (FAIL_STATUS
    ? park(null).then(() => { throw new Error("status exploded"); })
    : park({ loggedIn: false })),
  listJobs: () => park([]),
  freeframeProjects: () => park({ ok: false, projects: [] }),

  // ── everything else the window touches, inert ──
  listPresets: async () => [],
  savePreset: async () => ({ ok: true }),
  deletePreset: async () => ({ ok: true }),
  previewNaming: async () => ({ ok: true, folder: "", file: "" }),
  validateFolderPattern: async () => ({ ok: true }),
  setSourceCounter: async () => ({ ok: true }),
  openLogsFolder: noop,
  freeframeLogin: async () => ({ ok: false }),
  freeframeLogout: async () => ({ ok: true }),
  freeframeTwoFactorSetup: async () => ({ ok: false }),
  freeframeConfirmTwoFactorSetup: async () => ({ ok: false }),
  freeframeDisableTwoFactor: async () => ({ ok: false }),
  freeframeRegenerateBackupCodes: async () => ({ ok: false }),
  freeframeVerifyTwoFactor: async () => ({ ok: false }),
  freeframeSendTwoFactorEmailFallback: async () => ({ ok: false }),
  freeframeSendTwoFactorReauthCode: async () => ({ ok: false }),
  onSettingsTab: noop,
  onSettingsChanged: noop,
  onPresetsChanged: noop,
  onVolumesChanged: noop,

  // ── test control ──
  __release: () => { released = true; const w = parked.splice(0); w.forEach((f) => f()); return true; },
  __released: () => released,
  __stored: () => STORED,
};
contextBridge.exposeInMainWorld("freeframe", api);
`;
}

const MAIN_SOURCE = `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 780, height: 620, show: false,
    webPreferences: {
      preload: path.join(__dirname, "boot-preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.loadFile(${JSON.stringify(path.join(RENDERER, "settings.html"))});
});
app.on("window-all-closed", () => app.quit());
`;

/**
 * Launch a throwaway Electron whose only window is the real settings.html.
 * Returns an evaluator plus the child, which electron-harness already
 * tracks for group-kill on every exit path.
 */
async function launch(opts) {
  const dir = path.join(tmp, `run-${portSeq}`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "boot-preload.js"), preloadSource(opts));
  await fsp.writeFile(path.join(dir, "boot-main.js"), MAIN_SOURCE);
  // A package.json so Electron treats the directory as the app.
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "ff-settings-boot", version: "0.0.0", main: "boot-main.js",
  }));

  const port = PORT_BASE + (portSeq++);
  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [dir, `--remote-debugging-port=${port}`],
    { stdio: "ignore" },
  );

  let page;
  for (let i = 0; i < 100; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = t.find((x) => x.type === "page" && x.url.includes("settings.html"));
      if (page?.webSocketDebuggerUrl) break;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  if (!page) {
    console.error("Electron never exposed the settings window");
    return null;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pend = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (me, pa = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  });
  await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr, awaitPromise: true, returnByValue: true, timeout: 20000,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || "threw");
    }
    return r.result.value;
  };
  return { child, ws, ev };
}

async function shutdown(h) {
  if (!h) return;
  try { h.ws.close(); } catch { /* already gone */ }
  // The group kill, not the shim: .bin/electron spawns the real binary as
  // its own child (see lib/electron-harness.js).
  try { process.kill(-h.child.pid, "SIGKILL"); } catch {
    try { h.child.kill("SIGKILL"); } catch { /* gone */ }
  }
  await sleep(300);
}

/**
 * Poll an expression until it is truthy. Returns the last value.
 *
 * Swallows throws on purpose: attaching succeeds the moment the CDP target
 * exists, which is BEFORE settings.html has been parsed, so an early poll
 * can hit `getElementById(...) === null` and blow up. A reproduction run is
 * also expected to never satisfy the condition — so this must return a
 * falsy value for the caller to assert on, not take the whole script down
 * with it.
 */
async function waitFor(ev, expr, tries = 100) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { last = await ev(expr); } catch { last = undefined; }
    if (last) return last;
    await sleep(50);
  }
  return last;
}

/** The DOM exists and the scripts have run. Every assertion needs this
 *  first, or a null element reads as a failure of the thing under test. */
async function ready(ev) {
  return waitFor(ev,
    `document.readyState === "complete" && !!document.getElementById("settings-live-checksum")`);
}

/** Everything the window shows that depends on stored settings. */
const SNAPSHOT = `(() => {
  const g = (id) => document.getElementById(id);
  const live = g("settings-live-checksum");
  const fin = g("settings-finalized-checksum");
  const timing = g("settings-finalized-timing");
  const auto = g("settings-auto-resume");
  return {
    released: window.freeframe.__released(),
    autoChecked: auto ? auto.checked : null,
    autoDisabled: auto ? auto.disabled : null,
    liveOptions: live ? live.options.length : -1,
    liveValue: live ? live.value : null,
    liveDisabled: live ? live.disabled : null,
    finOptions: fin ? fin.options.length : -1,
    finValue: fin ? fin.value : null,
    finDisabled: fin ? fin.disabled : null,
    timingValue: timing ? timing.value : null,
    timingDisabled: timing ? timing.disabled : null,
    hintShown: (() => {
      const n = g("settings-secondary-hint");
      return !!n && n.offsetParent !== null && n.textContent.trim().length > 0;
    })(),
    label: (() => {
      const n = [...document.querySelectorAll(".setting-label")]
        .find((x) => /checksum/i.test(x.textContent) && !/live/i.test(x.textContent));
      return n ? n.textContent.trim() : null;
    })(),
  };
})()`;

(async () => {
  // ── 1. Settings land before anything slow resolves ────────────────────
  console.log("1. Stored values are on screen before listVolumes/freeframeStatus resolve");
  {
    const h = await launch({ stored: { liveChecksumAlgo: "md5", finalizedTiming: "off" } });
    if (!h) { check(false, "the window came up"); }
    else {
      try {
        check(Boolean(await ready(h.ev)), "the window parsed settings.html");
        // The thing a person looks at: the dropdown has its choices.
        await waitFor(h.ev, `document.getElementById("settings-live-checksum").options.length > 1`);
        const s = await JSON.parse(JSON.stringify(await h.ev(SNAPSHOT)));
        // THE assertion. Not "it was fast enough" — the slow calls are
        // provably still parked at this instant.
        check(s.released === false,
          "listVolumes/freeframeStatus have NOT resolved yet", JSON.stringify(s.released));
        check(s.liveOptions === 4, "the live dropdown is populated", String(s.liveOptions));
        check(s.liveValue === "md5", "…with the STORED algorithm selected", String(s.liveValue));
        check(s.liveDisabled === false, "…and enabled", String(s.liveDisabled));
        check(s.autoChecked === true,
          "auto-resume shows its stored default (ticked)", String(s.autoChecked));
        check(s.autoDisabled === false, "…and is clickable", String(s.autoDisabled));
        check(s.finOptions === 4, "the secondary dropdown is populated", String(s.finOptions));
        check(s.timingValue === "off", "the timing select shows the stored value", String(s.timingValue));

        // And the rest of init still finishes once they do.
        await h.ev(`window.freeframe.__release()`);
        const vols = await waitFor(h.ev,
          `[...document.querySelectorAll(".hide-name")].some(n => /Ichi/.test(n.textContent))`);
        check(vols === true, "the volume list still renders after the slow calls land",
          String(vols));
      } finally { await shutdown(h); }
    }
  }

  // ── 2. A stored false renders unticked; absent renders ticked ─────────
  console.log("\n2. The checkbox reflects what is stored, not the markup");
  {
    const h = await launch({ stored: { autoResumeUploads: false } });
    if (!h) check(false, "the window came up"); else
    try {
      await ready(h.ev);
      await waitFor(h.ev, `document.getElementById("settings-live-checksum").options.length > 1`);
      const s = await h.ev(SNAPSHOT);
      check(s.released === false, "still before the slow calls resolved");
      check(s.autoChecked === false, "stored false renders unticked", String(s.autoChecked));
    } finally { await shutdown(h); }
  }
  {
    const h = await launch({ stored: {} });
    if (!h) check(false, "the window came up"); else
    try {
      await ready(h.ev);
      await waitFor(h.ev, `document.getElementById("settings-live-checksum").options.length > 1`);
      const s = await h.ev(SNAPSHOT);
      check(s.autoChecked === true,
        "an absent value renders ticked — §213's default is ON", String(s.autoChecked));
    } finally { await shutdown(h); }
  }

  // ── 3. A slow call that FAILS must not take settings with it ──────────
  console.log("\n3. A rejected listVolumes / failing freeframeStatus does not stop settings");
  {
    const h = await launch({
      stored: { liveChecksumAlgo: "sha1", finalizedTiming: "after" },
      failVolumes: true, failStatus: true,
    });
    if (!h) check(false, "the window came up"); else
    try {
      await ready(h.ev);
      await waitFor(h.ev, `document.getElementById("settings-live-checksum").options.length > 1`);
      await h.ev(`window.freeframe.__release()`);
      // Give the rejections a chance to propagate before asserting.
      await sleep(400);
      const s = await h.ev(SNAPSHOT);
      check(s.liveValue === "sha1", "the stored algorithm is still shown", String(s.liveValue));
      check(s.timingValue === "after", "…and the stored timing", String(s.timingValue));
      check(s.autoChecked === true, "…and the checkbox", String(s.autoChecked));
      check(s.finDisabled === false,
        "the secondary select is enabled, because timing is not Off", String(s.finDisabled));
    } finally { await shutdown(h); }
  }

  // ── 4. Wording, and the hint on the inert select ──────────────────────
  console.log("\n4. \"Secondary checksum\", and a greyed select that explains itself");
  {
    const h = await launch({ stored: { finalizedTiming: "off" } });
    if (!h) check(false, "the window came up"); else
    try {
      await ready(h.ev);
      await waitFor(h.ev, `document.getElementById("settings-live-checksum").options.length > 1`);
      const off = await h.ev(SNAPSHOT);
      check(off.label === "Secondary checksum",
        "the visible label reads \"Secondary checksum\"", String(off.label));
      check(off.finDisabled === true, "the secondary select is inert while timing is Off",
        String(off.finDisabled));
      check(off.hintShown === true,
        "…and says why, rather than just being grey", String(off.hintShown));

      // Turning it on removes both the inertness and the explanation.
      await h.ev(`(() => {
        const t = document.getElementById("settings-finalized-timing");
        t.value = "after";
        t.dispatchEvent(new Event("change"));
      })()`);
      await sleep(250);
      const on = await h.ev(SNAPSHOT);
      check(on.finDisabled === false, "choosing a timing enables it", String(on.finDisabled));
      check(on.hintShown === false, "…and the hint goes away", String(on.hintShown));
    } finally { await shutdown(h); }
  }

  // ── 5. Nothing clickable, and no wrong value, before settings load ────
  console.log("\n5. The controls are inert until the stored values arrive");
  {
    // getSettings itself is parked here. That is not a realistic delay —
    // it reads one local JSON file — but it is the ONLY way to hold the
    // window in the state the `disabled` attributes exist to cover. A
    // mutation that removed them passed every other scenario in this file,
    // because after the init fix loadSettings lands too fast to catch.
    const h = await launch({ stored: { liveChecksumAlgo: "c4", finalizedTiming: "after" }, parkSettings: true });
    if (!h) check(false, "the window came up"); else
    try {
      check(Boolean(await ready(h.ev)), "the window parsed settings.html");
      const before = await h.ev(SNAPSHOT);
      check(before.released === false, "getSettings has not answered yet");
      // THE assertion: a person looking at the window right now cannot act
      // on it, and is not being shown a value that differs from the file.
      check(before.liveDisabled === true,
        "the live select is inert", String(before.liveDisabled));
      check(before.timingDisabled === true,
        "the timing select is inert", String(before.timingDisabled));
      check(before.finDisabled === true,
        "the secondary select is inert", String(before.finDisabled));
      check(before.autoDisabled === true,
        "the auto-resume checkbox cannot be ticked — it would write over an unread value",
        String(before.autoDisabled));
      check(before.liveOptions === 0,
        "…and no algorithm is offered yet, rather than a wrong one",
        String(before.liveOptions));
      check(before.hintShown === false,
        "the \"why is this grey\" hint stays off: the reason here is not the timing",
        String(before.hintShown));

      await h.ev(`window.freeframe.__release()`);
      const after = await waitFor(h.ev,
        `document.getElementById("settings-live-checksum").options.length > 1`);
      check(after === true, "once the settings land, the options appear", String(after));
      const s = await h.ev(SNAPSHOT);
      check(s.liveDisabled === false && s.timingDisabled === false && s.autoDisabled === false,
        "…and every control becomes usable",
        JSON.stringify([s.liveDisabled, s.timingDisabled, s.autoDisabled]));
      check(s.liveValue === "c4", "…showing the stored algorithm", String(s.liveValue));
      check(s.finDisabled === false,
        "…and the secondary select follows its timing, not the load state",
        String(s.finDisabled));
    } finally { await shutdown(h); }
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
