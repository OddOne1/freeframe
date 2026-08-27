#!/usr/bin/env node
// The main window's header, after §62/§63/§64.
//
// Three separate changes landed on one strip of chrome, and each one is
// invisible to every other harness:
//   * §62 — a one-click switch for the active preset, which has to be
//     equivalent to the menu and has to remember what it turned off
//   * §63 — OffShoot's queueing names, and a "Single Transfer" mode whose
//     UI half nothing else covers (test-job-queue.js covers the scheduler)
//   * §64 — the FreeFrame page scopes the header: Settings/Clear/Copy &
//     Verify go, Refresh stays and means something else there, and the tab
//     itself does not exist while logged out
//
// Run: node scripts/e2e-header.js
const { execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9384;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

async function connect(urlPart, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pg = t.find((x) => x.type === "page" && x.url.includes(urlPart));
      if (pg?.webSocketDebuggerUrl) {
        const ws = new WebSocket(pg.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener("open", r));
        let n = 0; const q = new Map();
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data);
          if (m.id && q.has(m.id)) {
            const f = q.get(m.id); q.delete(m.id);
            m.error ? f.reject(new Error(JSON.stringify(m.error))) : f.resolve(m.result);
          }
        });
        const call = (me, pa = {}) => new Promise((res, rej) => {
          const i = ++n; q.set(i, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: i, method: me, params: pa }));
        });
        await call("Runtime.enable");
        const ev = async (x) => {
          const r = await call("Runtime.evaluate",
            { expression: x, awaitPromise: true, returnByValue: true, timeout: 30000 });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
          return r.result.value;
        };
        return { ws, ev };
      }
    } catch {}
    await sleep(250);
  }
  return null;
}

/** Poll rather than sleep: these windows populate asynchronously. */
async function waitFor(ev, expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if (await ev(expr)) return true; } catch {}
    await sleep(200);
  }
  return false;
}

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`], { stdio: "ignore" },
  );
  const main = await connect("index.html");
  if (!main) { console.error("Electron never came up"); process.exit(1); }
  const ev = main.ev;
  await sleep(1500);

  // ── §63 ────────────────────────────────────────────────────────────────
  console.log("1. (§63) Queueing reads OffShoot's names");
  check(await ev(`document.getElementById("conc-label").textContent === "Single Source"`),
    "the button face names the mode", await ev(`document.getElementById("conc-label").textContent`));

  await ev(`document.getElementById("conc-btn").click(); true`);
  await sleep(300);
  // Same trap the preset pill fell into: reading #menu's buttons passes
  // whether or not the menu was ever shown.
  check(await ev(`getComputedStyle(document.getElementById("menu")).display === "block"`),
    "the pill actually opens the menu on screen");
  // The current mode carries a ✓ prefix; strip it before comparing names.
  const modes = await ev(`[...document.querySelectorAll("#menu button")].map(b => b.firstChild.textContent.replace(/^\u2713\s*/, "").trim())`);
  const want = ["Single Source", "Single Destination", "Single Transfer", "Off"];
  check(Array.isArray(modes) && want.every((w) => modes.includes(w)),
    "and the menu offers all four, verbatim", (modes || []).join(" | "));
  check(!(modes || []).some((m) => /Runs alone|Alongside anything|Shares destination/.test(m)),
    "with none of the old point-of-view labels left behind");

  const picked = await ev(`
    (() => {
      const b = [...document.querySelectorAll("#menu button")]
        .find(x => x.firstChild.textContent.trim() === "Single Transfer");
      b.click();
      return { mode: concurrencyMode, label: document.getElementById("conc-label").textContent };
    })()
  `);
  check(picked.label === "Single Transfer", "picking one relabels the button", picked.label);
  check(picked.mode === "exclusive",
    "and sets a mode the scheduler actually knows — not a label with nothing behind it", picked.mode);
  // The three renamed modes must still map to the SAME values as before, or
  // this stops being a rename.
  const mapping = await ev(`JSON.stringify(CONC_LABELS)`);
  check(mapping.includes('"free":"Off"') && mapping.includes('"source":"Single Source"')
    && mapping.includes('"destination":"Single Destination"'),
    "the other three are pure relabels of the existing modes", mapping);
  await ev(`concurrencyMode = "source"; updateConcLabel(); closeMenu(); true`);

  // ── §62 ────────────────────────────────────────────────────────────────
  console.log("2. (§62) One-click preset on/off");
  check(await ev(`document.getElementById("preset-toggle").hidden === true`),
    "the switch is absent until a preset has been chosen — there is nothing to toggle yet");

  await ev(`window.freeframe.savePreset({ id: null, name: "Header Test",
    folderTemplate: "{date}", fileTemplate: "", fields: [] })`);
  await waitFor(ev, `presetStore.presets.some(p => p.name === "Header Test")`);
  await ev(`
    (() => {
      const p = presetStore.presets.find(x => x.name === "Header Test");
      setActivePreset(p.id);
      return true;
    })()
  `);
  check(await ev(`document.getElementById("preset-label").textContent === "Header Test"`),
    "selecting one names it on the pill");
  check(await ev(`document.getElementById("preset-toggle").hidden === false`),
    "and the switch appears");
  check(await ev(`document.getElementById("preset-toggle").getAttribute("aria-pressed") === "true"`),
    "reading as on");

  await ev(`document.getElementById("preset-toggle").click(); true`);
  await sleep(200);
  const off = await ev(`JSON.stringify({
    active: activePresetId, label: document.getElementById("preset-label").textContent,
    pressed: document.getElementById("preset-toggle").getAttribute("aria-pressed"),
    hidden: document.getElementById("preset-toggle").hidden,
  })`);
  const offState = JSON.parse(off);
  check(offState.active === null,
    "one click turns naming off — exactly what the menu's 'No naming preset' does", off);
  check(offState.label === "No naming preset", "and the pill says so");
  check(offState.hidden === false,
    "the switch STAYS, or turning it back on would mean reopening the menu — the detour it removes");

  await ev(`document.getElementById("preset-toggle").click(); true`);
  await sleep(200);
  check(await ev(`document.getElementById("preset-label").textContent === "Header Test"`),
    "and clicking again restores the SAME preset, not merely some preset");

  // A preset deleted elsewhere must not stay on offer.
  await ev(`
    (async () => {
      const p = presetStore.presets.find(x => x.name === "Header Test");
      await window.freeframe.deletePreset(p.id);
      return true;
    })()
  `);
  check(await waitFor(ev, `document.getElementById("preset-toggle").hidden === true`),
    "deleting it removes the switch rather than offering to restore something gone");

  // §65.13 — "temporarily disable naming without losing the preset".
  //
  // The mechanism §25c part 3 specified (a `namingSuspended` flag, with the
  // pill still naming the preset while naming is off) was NEVER BUILT — it
  // was explicitly deferred. What exists is §62's switch, which deselects
  // and remembers. The user-visible capability is there; the pill reads
  // "No naming preset" while off, which the deferred design would not have.
  // Re-checked here because §65 asks that it survive the card rebuild.
  await ev(`window.freeframe.savePreset({ id: null, name: "Suspend Check",
    folderTemplate: "{YYYY}", fileTemplate: "", fields: [] })`);
  await waitFor(ev, `presetStore.presets.some(p => p.name === "Suspend Check")`);
  const suspend = await ev(`
    (() => {
      const p = presetStore.presets.find(x => x.name === "Suspend Check");
      setActivePreset(p.id);
      const on1 = { active: activePresetId, payload: namingPayload() !== null };
      document.getElementById("preset-toggle").click();
      const off = { active: activePresetId, payload: namingPayload() !== null,
                    label: document.getElementById("preset-label").textContent };
      document.getElementById("preset-toggle").click();
      const on2 = { active: activePresetId, payload: namingPayload() !== null };
      return { on1, off, on2, id: p.id };
    })()
  `);
  check(suspend.on1.payload === true, "with the preset on, a job would be named");
  check(suspend.off.payload === false, "one click turns naming off for the next job");
  check(suspend.on2.active === suspend.on1.active,
    "and clicking back restores the SAME preset — the selection is not lost",
    `${suspend.on1.active} → ${suspend.on2.active}`);
  check(suspend.off.label === "No naming preset",
    "NOTE: it deselects-and-remembers rather than suspending, so the pill reads empty while off",
    suspend.off.label);
  await ev(`window.freeframe.deletePreset(${'`'}${'$'}{${JSON.stringify("x")}}${'`'})`).catch(() => {});
  await ev(`(async () => {
    const s = await window.freeframe.listPresets();
    for (const p of s.presets.filter(p => p.name === "Suspend Check")) await window.freeframe.deletePreset(p.id);
  })()`);

  // ── §64 ────────────────────────────────────────────────────────────────
  // ── §65.14, corrected by §71 ──────────────────────────────────────────
  //
  // §65.14 put Progress beside the Log as two columns. In use they showed
  // the same run twice — the Log's own row already carries a bar, a rate
  // and an ETA — so §71 removed the Progress column. Inverted rather than
  // deleted: the section it lives in must still be the same collapsible
  // Transfers panel, with its own controls, which is what §65.14 was
  // really protecting.
  console.log("2b. (\u00a771) Transfers is one column: the Log");
  const transfers = await ev(`
    (() => {
      const panel = document.getElementById("jobs-panel");
      if (!panel.classList.contains("open")) document.getElementById("jobs-toggle").click();
      return {
        progressColGone: !document.getElementById("jobs-progress-col"),
        legacyProgressGone: !document.getElementById("progress") && !document.getElementById("p-bar"),
        logStillThere: panel.contains(document.getElementById("jobs-list")),
        // Still the SAME collapsible section, with its own controls — not a
        // new panel and not a new tab.
        stillCollapsible: !!document.getElementById("jobs-toggle"),
        keepsClear: !!document.getElementById("jobs-clear"),
        keepsDetach: !!document.getElementById("jobs-detach"),
      };
    })()
  `);
  check(transfers.progressColGone && transfers.legacyProgressGone,
    "the Progress column and its readout are gone", JSON.stringify(transfers));
  check(transfers.logStillThere, "the Log remains, as the only live view");
  check(transfers.stillCollapsible && transfers.keepsClear && transfers.keepsDetach,
    "and it is still the same collapsible section, with Clear and Detach");

  const collapsed = await ev(`
    (() => {
      document.getElementById("jobs-toggle").click();
      const open = document.getElementById("jobs-panel").classList.contains("open");
      document.getElementById("jobs-toggle").click();
      return { open, reopened: document.getElementById("jobs-panel").classList.contains("open") };
    })()
  `);
  check(collapsed.open === false && collapsed.reopened === true,
    "collapse and expand still work", JSON.stringify(collapsed));

  console.log("3. (§64) The FreeFrame page scopes the header");
  check(!(await ev(`!!document.getElementById("account")`)),
    "the Sign in button is gone from the header — login lives in Settings now");

  const loggedIn = await ev(`ffStatus.loggedIn === true`);
  check(await ev(`document.getElementById("page-freeframe").hidden === ${!loggedIn}`),
    `the FreeFrame tab exists only while signed in (signed in: ${loggedIn})`);

  // Both directions, driven through the same function the account broadcast
  // calls — a check that only ever sees one login state proves half a rule.
  const gating = await ev(`
    (() => {
      const was = ffStatus;
      const tab = document.getElementById("page-freeframe");
      ffStatus = { loggedIn: false }; updateAccountUi();
      const out = { hiddenWhenOut: tab.hidden };
      ffStatus = { loggedIn: true, user: { email: "x@y.z" } }; updateAccountUi();
      out.shownWhenIn = !tab.hidden;
      ffStatus = was; updateAccountUi();
      return out;
    })()
  `);
  check(gating.hiddenWhenOut, "hidden — not merely disabled — while logged out");
  check(gating.shownWhenIn, "and it appears once a session exists, off the same status refresh");

  // The header scoping is a property of the page, not of the session, so it
  // is driven through setPage() directly rather than through a tab that is
  // deliberately hidden while logged out. Without a session the embedded
  // view shows the web app's own login page, which is irrelevant here —
  // what is being measured is which buttons the header still shows.
  await ev(`setPage("freeframe")`);
  await sleep(900);
  const hiddenNow = await ev(`JSON.stringify(
    ["settings-btn", "start-bar", "fields-show", "refresh"].map(id =>
      [id, getComputedStyle(document.getElementById(id)).display === "none"]))`);
  const map = Object.fromEntries(JSON.parse(hiddenNow));
  // §65.12 relocated Copy & Verify into #start-bar and deleted Clear, so
  // what has to disappear on this page is the bar rather than a header
  // button — same rule, the controls simply moved.
  check(map["settings-btn"] && map["start-bar"] && map["fields-show"],
    "Settings, the Copy & Verify bar and the naming-card toggle are hidden there", hiddenNow);
  check(map.refresh === false, "Refresh stays");

  // And it must mean the thing on screen, rather than silently re-listing
  // drives the page is not showing.
  // Observed, not merely reported: a handler that returns { ok: true } and
  // reloads nothing passes an assertion on its own return value.
  const embedded = await connect("frame.yon.studio", 20);
  if (embedded) {
    await embedded.ev(`window.__reloadMarker = 1; true`);
    const before = await embedded.ev(`window.__reloadMarker`);
    check(before === 1, "a marker was set in the embedded page");
    await ev(`window.freeframe.reloadWebView()`);
    await sleep(2500);
    // The context is replaced by the reload, so the marker is gone from the
    // page — re-attach rather than reusing a stale session.
    const after = await connect("frame.yon.studio", 20);
    const gone = after ? await after.ev(`window.__reloadMarker === undefined`).catch(() => true) : true;
    check(gone === true, "and it is gone afterwards — the page really reloaded");
    try { embedded.ws.close(); } catch {}
    try { if (after) after.ws.close(); } catch {}
  } else {
    check(false, "could not attach to the embedded view to observe a reload");
  }
  check(await ev(`refresh.toString().includes("reloadWebView")`),
    "and Refresh routes there while that page is active, rather than re-listing volumes");

  await ev(`setPage("offload")`);
  await sleep(500);
  const backNow = await ev(`JSON.stringify(
    ["settings-btn", "start-bar"].map(id =>
      getComputedStyle(document.getElementById(id)).display !== "none"))`);
  // #fields-show is deliberately absent from this list: it has its own
  // rule (shown only when a preset is active AND its card is hidden), so
  // asserting it visible here would be asserting the wrong thing.
  check(JSON.parse(backNow).every(Boolean), "switching back restores them", backNow);
  check(await ev(`refresh.toString().includes("listVolumes")`),
    "and Refresh goes back to listing volumes");

  console.log("4. (§64) Login moved into Settings");
  await ev(`document.getElementById("settings-btn").click(); true`);
  const st = await connect("settings.html");
  check(Boolean(st), "the Settings window opened");
  if (st) {
    check(await waitFor(st.ev, `!!document.querySelector('nav button[data-tab="account"]')`),
      "there is an Account tab");
    await st.ev(`document.querySelector('nav button[data-tab="account"]').click(); true`);
    check(await st.ev(`!!document.getElementById("ff-email") && !!document.getElementById("ff-pass")
      && !!document.getElementById("ff-url")`),
      "carrying the same three fields the header modal had, including the server");
    // Both states, driven through the same function the login and logout
    // handlers call. Asserting only against the current session would pass
    // on a panel hardcoded to whichever state this machine happens to be in.
    const halves = await st.ev(`
      (() => {
        const was = ffStatus;
        const out = {};
        ffStatus = { loggedIn: false }; renderAccount();
        out.outShowsForm = !document.getElementById("account-signed-out").hidden;
        out.outHidesWho = document.getElementById("account-signed-in").hidden;
        ffStatus = { loggedIn: true, user: { email: "x@y.z" }, baseUrl: "https://example/api" };
        renderAccount();
        out.inHidesForm = document.getElementById("account-signed-out").hidden;
        out.inShowsWho = !document.getElementById("account-signed-in").hidden;
        out.who = document.getElementById("account-who").textContent;
        out.hasLogout = !!document.getElementById("ff-logout");
        ffStatus = was; renderAccount();
        return out;
      })()
    `);
    check(halves.outShowsForm && halves.outHidesWho,
      "signed out, it offers the form and nothing else");
    check(halves.inHidesForm && halves.inShowsWho,
      "signed in, the form gives way to the account");
    check(halves.who === "x@y.z" && halves.hasLogout,
      "naming who is signed in, with a way out", halves.who);
    // The main window has to hear about a sign-in or sign-out it did not
    // run. Exercised through LOGOUT, which is reachable without credentials
    // and travels the identical broadcast path.
    await ev(`ffStatus = { loggedIn: true, user: { email: "x@y.z" } }; updateAccountUi(); true`);
    check(await ev(`document.getElementById("page-freeframe").hidden === false`),
      "with the main window believing it is signed in, the tab is showing");
    await st.ev(`window.freeframe.freeframeLogout()`);
    check(await waitFor(ev, `ffStatus.loggedIn === false
        && document.getElementById("page-freeframe").hidden === true`),
      "signing out in the Settings window reaches the main window and takes the tab with it");

    // The login half needs real credentials, so it is pinned at the source
    // rather than exercised — stated plainly rather than left looking covered.
    const mainSrc = await fsp.readFile(path.join(APP, "src", "main", "main.js"), "utf8");
    const loginBlock = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("freeframe:login"'),
                                     mainSrc.indexOf('ipcMain.handle("freeframe:logout"'));
    check(/broadcast\("account:changed"/.test(loginBlock),
      "and login broadcasts the same way (asserted at the source — a real sign-in needs credentials)");

    try { st.ws.close(); } catch {}
  }

  try { main.ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(500);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
