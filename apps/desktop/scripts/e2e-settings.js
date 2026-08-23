#!/usr/bin/env node
// Settings screen + live speed/ETA (CLAUDE.md §58), in the real app.
//
// The unit test covers the rate arithmetic and the settings normalisation.
// What only the running app can show is the wiring:
//   * the modal opens, and is a modal (the shared .ff-backdrop class carries
//     no styles — a backdrop relying on it alone sits invisible or
//     permanently on top, which is §23d's own scar)
//   * choosing a default persists it AND pre-selects the per-job picker on
//     the next launch, without removing the per-job override
//   * a progress tick carrying speed/eta reaches both the docked footer and
//     the jobs panel
//
// Run: node scripts/e2e-settings.js
const { execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9377;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

async function launch() {
  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`],
    { stdio: "ignore" },
  );
  let page;
  for (let i = 0; i < 80; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = t.find((x) => x.type === "page" && x.url.includes("index.html"));
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(250);
  }
  if (!page) { console.error("Electron never came up"); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map();
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
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
    return r.result.value;
  };
  await send("Runtime.enable");
  await sleep(1800);
  return { child, ws, ev };
}

async function shutdown(child, ws) {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(600);
}

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

  // Start from no stored settings. Without this the run inherits whatever
  // the last one wrote, and "the picker starts on the saved value" can pass
  // just because the saved value happens to equal the built-in default.
  const userData = path.join(
    process.env.HOME, "Library", "Application Support",
    require(path.join(APP, "package.json")).build?.productName || "FreeFrame Desktop (name TBD)",
  );
  await fsp.rm(path.join(userData, "settings.json"), { force: true });

  // ── Launch 1: open Settings, change the default ──
  console.log("1. The Settings screen");
  let { child, ws, ev } = await launch();

  const settingsPath = await ev(`window.freeframe.appInfo().then(i => i.logsPath)`);
  check(typeof settingsPath === "string" && settingsPath.includes("logs"),
    "app info reports the logs folder the app actually writes to", settingsPath);

  check(await ev(`!!document.getElementById("settings-btn")`), "there is a way in");
  check(await ev(`getComputedStyle(document.getElementById("settings-backdrop")).display === "none"`),
    "and it starts closed");

  await ev(`document.getElementById("settings-btn").click(); true`);
  await sleep(400);

  check(await ev(`document.getElementById("settings-backdrop").classList.contains("open")`),
    "clicking it opens the modal");
  // The scar this guards: a backdrop styled only by .ff-backdrop is
  // invisible-but-present, and nothing throws.
  check(await ev(`getComputedStyle(document.getElementById("settings-backdrop")).display === "flex"`),
    "and the backdrop has a real rule of its own, not just the shared class");
  check(await ev(`getComputedStyle(document.getElementById("settings-backdrop")).position === "fixed"`),
    "covering the app rather than sitting in the flow");

  const optionCount = await ev(`document.getElementById("settings-algo").options.length`);
  check(optionCount > 1, "the algorithm list is populated from the app's own list", `${optionCount} options`);

  // Deliberately something OTHER than the built-in default, so the
  // relaunch check below can tell "the saved value was applied" from "the
  // default happened to be right anyway".
  const builtIn = await ev(`window.freeframe.getAlgorithms().then(r => r.default || "xxhash64")`);
  const chosen = await ev(`
    (() => {
      const s = document.getElementById("settings-algo");
      const other = [...s.options].find(o => o.value && o.value !== ${JSON.stringify(builtIn)});
      s.value = other.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return other.value;
    })()
  `);
  check(chosen !== builtIn, "the test is exercising a non-default choice", `${builtIn} → ${chosen}`);
  await sleep(600);

  const persisted = await ev(`window.freeframe.getSettings().then(s => s.defaultChecksumAlgo)`);
  check(persisted === chosen, "the choice is written straight away, with no Save step to forget",
    `${persisted}`);

  check(await ev(`!!document.getElementById("settings-open-logs")`), "there is an Open logs folder button");
  check((await ev(`document.getElementById("settings-about").textContent`) || "").includes("Offload"),
    "and an about line with a version in it");

  await ev(`document.getElementById("settings-close").click(); true`);
  await sleep(300);
  check(!(await ev(`document.getElementById("settings-backdrop").classList.contains("open")`)),
    "Done closes it");

  await shutdown(child, ws);

  // ── Launch 2: the saved default is applied ──
  console.log("2. It survives a relaunch");
  ({ child, ws, ev } = await launch());

  const label = await ev(`document.getElementById("algo-label").textContent`);
  const active = await ev(`window.freeframe.getSettings().then(s => s.defaultChecksumAlgo)`);
  check(active === chosen, "the setting is still there", active);
  const expectedShort = await ev(`
    window.freeframe.getAlgorithms().then(({ algorithms }) =>
      (algorithms.find(a => a.id === ${JSON.stringify(chosen)}) || {}).short)
  `);
  check(typeof expectedShort === "string" && label.includes(expectedShort),
    "and the per-job picker starts on it rather than the built-in default",
    `label "${label}"`);

  // The whole point of a *default*: it pre-selects, it does not lock.
  const overrode = await ev(`
    (() => {
      document.getElementById("algo-btn").click();
      const opts = [...document.querySelectorAll("#algo-menu .algo-opt")];
      const other = opts.find(o => !o.querySelector(".algo-check"));
      if (!other) return null;
      other.click();
      return document.getElementById("algo-label").textContent;
    })()
  `);
  await sleep(300);
  check(typeof overrode === "string" && overrode !== label,
    "a job can still pick something else", `${label} → ${overrode}`);
  const untouched = await ev(`window.freeframe.getSettings().then(s => s.defaultChecksumAlgo)`);
  check(untouched === chosen, "and the per-job override does not rewrite the default");

  // ── Speed / ETA reaches both surfaces ──
  console.log("3. Speed and ETA");
  const footer = await ev(`
    (() => {
      const p = { phase: "bytes", percent: 40, file: "CLIP.MOV",
                  speed: 42 * 1024 * 1024, eta: 185, nodeIds: [] };
      window.dispatchEvent(new CustomEvent("noop"));
      onProgress(p);
      return document.getElementById("p-rate").textContent;
    })()
  `);
  check(/MB\/s/.test(footer), "the docked footer shows a speed", footer);
  check(/remaining/.test(footer), "and a remaining time", footer);
  check(/3m/.test(footer), "coarse, not to the second", footer);

  const blank = await ev(`
    (() => {
      onProgress({ phase: "bytes", percent: 41, file: "CLIP.MOV", nodeIds: [] });
      return document.getElementById("p-rate").textContent;
    })()
  `);
  check(blank === "",
    "and shows nothing at all before there is a rate, rather than a stale one");

  const verifying = await ev(`
    (() => {
      onProgress({ phase: "bytes", percent: 60, speed: 1e7, eta: 20, nodeIds: [] });
      onProgress({ phase: "verifying", file: "CLIP.MOV" });
      return document.getElementById("p-rate").textContent;
    })()
  `);
  check(verifying === "",
    "and clears it when the job stops transferring — verification is not a transfer");

  await shutdown(child, ws);

  // ── The panel renders it too ──
  console.log("4. The jobs panel");
  const panelSrc = await fsp.readFile(path.join(APP, "src", "renderer", "panel.js"), "utf8");
  check(/p\.speed/.test(panelSrc) && /fmtEta\(p\.eta\)/.test(panelSrc),
    "renderJobs reads speed and eta off the progress object");
  check(/j\.status === "running"/.test(panelSrc),
    "and only while the job is running");

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
