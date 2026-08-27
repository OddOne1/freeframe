#!/usr/bin/env node
// Daily overview in the real app (CLAUDE.md §72).
//
// test-daily-overview.js drives the day arithmetic and the merge rule
// directly. What only the running app can show is the wiring: that a
// REAL finished copy reaches the store at all, that the card renders it,
// that reset and export do what they say, and — the one that matters most
// — that it is on disk rather than in memory, because the whole point of
// this panel is that it survives a restart.
//
// Run: node scripts/e2e-daily.js
const { execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9443;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

async function launch() {
  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`], { stdio: "ignore" },
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
  let id = 0; const pend = new Map(); const errs = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      errs.push(m.params.exceptionDetails?.exception?.description || "unknown");
    }
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
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
    return r.result.value;
  };
  await sleep(1500);
  return { child, ws, ev, errs };
}

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-daily-"));
  const cardA = path.join(tmp, "A001");
  const cardB = path.join(tmp, "B002");
  const cardC = path.join(tmp, "C003");
  const d1 = path.join(tmp, "RAID1");
  const d2 = path.join(tmp, "RAID2");
  for (const c of [cardA, cardB, cardC]) {
    await fsp.mkdir(path.join(c, "DCIM"), { recursive: true });
    await fsp.writeFile(path.join(c, "DCIM", "CLIP.MOV"), crypto.randomBytes(16 * 1024));
  }
  for (const d of [d1, d2]) await fsp.mkdir(d, { recursive: true });

  let { child, ws, ev, errs } = await launch();
  let presetId = null;
  try {
    console.log("0. A clean slate");
    await ev(`window.freeframe.resetDailyOverview()`);
    await ev(`window.freeframe.setSettings({ dayBoundary: "00:00" })`);
    await ev(`window.freeframe.setSourceCounter(70)`);
    await ev(`(async () => { nextSourceCounter = (await window.freeframe.listPresets()).sourceCounter; return true; })()`);
    await ev(`extraFolders = ${JSON.stringify([cardA, cardB, cardC, d1, d2])}; render(); true`);
    const empty = await ev(`window.freeframe.dailyOverview().then(r => r.day.cards.length)`);
    check(empty === 0, "nothing recorded yet", String(empty));

    presetId = await ev(`(async () => {
      const st = await window.freeframe.savePreset({ id: null, name: "S72 Daily",
        folderTemplate: "card{sourcecounter}", fileTemplate: "{name}_{counter}", fields: [] });
      presetStore = st;
      const p = st.presets.find(x => x.name === "S72 Daily");
      setActivePreset(p.id);
      return p.id;
    })()`);

    // ── 1. Same card, two jobs, two destinations → one row ───────────────
    console.log("\n1. One row per card, not per job");
    const run = async (src, dst) => {
      await ev(`clearAll(); setSource(${JSON.stringify(src)}); addDest(${JSON.stringify(dst)}, null); render(); true`);
      await ev(`startCopy()`);
      await sleep(600);
    };
    await run(cardA, d1);
    await run(cardA, d2);
    const merged = await ev(`window.freeframe.dailyOverview().then(r => JSON.stringify(r.day.cards))`)
      .then(JSON.parse);
    check(merged.length === 1, "two jobs for the same card make ONE row", `${merged.length} rows`);
    check(merged[0].files === 2 && merged[0].bytes === 32768,
      "with the file and byte counts combined", JSON.stringify({ f: merged[0].files, b: merged[0].bytes }));
    check(merged[0].isNamedCard && merged[0].label === "70",
      "labelled by the number the FIRST job claimed", merged[0].label);

    // ── 2. A plain copy appears too, by folder name ──────────────────────
    console.log("\n2. A plain copy appears, and consumes no number");
    const before = await ev(`window.freeframe.listPresets().then(s => s.sourceCounter)`);
    await ev(`activePresetId = null; updatePresetLabel(); true`);
    await run(cardB, d1);
    const after = await ev(`window.freeframe.dailyOverview().then(r => JSON.stringify(r.day.cards.map(c => ({ l: c.label, n: c.isNamedCard }))))`)
      .then(JSON.parse);
    check(after.length === 2, "it gets its own row", JSON.stringify(after));
    const plain = after.find((c) => !c.n);
    check(Boolean(plain) && plain.l === "B002",
      "labelled by folder name, and marked as having no number", JSON.stringify(plain));
    check(await ev(`window.freeframe.listPresets().then(s => s.sourceCounter)`) === before,
      "and it consumed no §71 counter number", String(before));

    // ── 3. The card renders it ───────────────────────────────────────────
    console.log("\n3. The dropdown");
    await ev(`document.getElementById("daily-btn").click(); true`);
    await sleep(600);
    const card = await ev(`(() => {
      const c = document.getElementById("daily-card");
      const r = c.getBoundingClientRect();
      const btn = document.getElementById("daily-btn").getBoundingClientRect();
      return JSON.stringify({
        open: c.classList.contains("open"),
        // Anchored under its button, like #menu — not a window.
        anchored: Math.abs(r.top - btn.bottom) < 20 && r.top > 0 && r.left >= 0,
        rows: c.querySelectorAll(".dov-row").length,
        stats: [...c.querySelectorAll(".dov-stat")].map(x => x.textContent),
        sub: (c.querySelector(".dov-sub") || {}).textContent,
        reset: !!c.querySelector(".dov-reset"),
        hint: (c.querySelector(".dov-hint") || {}).textContent,
        exportBtn: [...c.querySelectorAll("button")].some(b => /Export as CSV/.test(b.textContent)),
        noWindow: (window.__wins = null, true),
      });
    })()`).then(JSON.parse);
    check(card.open && card.anchored, "opens anchored under its button", JSON.stringify(card));
    check(card.rows === 2, "one row per card", `${card.rows}`);
    check(card.stats.join("|").includes("Cards2"), "a stat row of day totals", card.stats.join(" "));
    check(/Resets at 00:00/.test(card.sub) && /2 cards so far/.test(card.sub),
      "the header names the boundary and the count", card.sub);
    check(card.reset, "a Reset now control");
    check(card.exportBtn, "an Export as CSV control");
    check(/Settings → General/.test(card.hint),
      "and a hint pointing at where the boundary is actually set", card.hint);

    // ── 4. Export lands beside the logs ──────────────────────────────────
    console.log("\n4. Export");
    const logsPath = await ev(`window.freeframe.appInfo().then(i => i.logsPath)`);
    const exported = await ev(`window.freeframe.exportDailyOverview().then(r => JSON.stringify(r))`)
      .then(JSON.parse);
    check(exported.ok, "the export reports success", JSON.stringify(exported));
    check(path.dirname(exported.path) === logsPath,
      "into the same folder Open Logs Folder points at", exported.path);
    const csv = await fsp.readFile(exported.path, "utf8");
    const lines = csv.trim().split("\n");
    check(lines.length === 3, "a header and one row per card", `${lines.length} lines`);
    check(lines[1].includes(",2,32768,") || lines[2].includes(",2,32768,"),
      "carrying the merged totals", lines.slice(1).join(" / "));

    // ── 5. Persistence — the whole reason this is not the Log ────────────
    console.log("\n5. It survives a restart");
    try { ws.close(); } catch {}
    try { child.kill(); } catch {}
    await sleep(900);
    ({ child, ws, ev, errs } = await launch());
    const after2 = await ev(`window.freeframe.dailyOverview().then(r => JSON.stringify(r.day.cards.map(c => ({ l: c.label, f: c.files }))))`)
      .then(JSON.parse);
    check(after2.length === 2, "today's rows are still there after a relaunch", JSON.stringify(after2));
    check(after2.some((c) => c.l === "70" && c.f === 2), "with their totals intact", JSON.stringify(after2));

    // ── 6. The boundary shifts the day ───────────────────────────────────
    console.log("\n6. The day boundary");
    const shifted = await ev(`(async () => {
      await window.freeframe.setSettings({ dayBoundary: "05:00" });
      const now = await window.freeframe.dailyOverview();
      await window.freeframe.setSettings({ dayBoundary: "00:00" });
      const back = await window.freeframe.dailyOverview();
      return JSON.stringify({ boundary: now.dayBoundary, shifted: now.day.dayKey, plain: back.day.dayKey });
    })()`).then(JSON.parse);
    check(shifted.boundary === "05:00", "the setting round-trips", shifted.boundary);
    // Before 05:00 local, "today" is yesterday's entry — so the panel is
    // empty at that hour and full at any other. Asserted as the relation
    // rather than a fixed date, since the harness runs whenever it runs.
    const nowH = new Date().getHours(), nowM = new Date().getMinutes();
    const expectShift = nowH * 60 + nowM < 5 * 60;
    check((shifted.shifted !== shifted.plain) === expectShift,
      `a 05:00 boundary ${expectShift ? "shifts" : "does not shift"} the day at ${nowH}:${String(nowM).padStart(2, "0")}`,
      `${shifted.shifted} vs ${shifted.plain}`);

    // The check above only exercises whichever branch the wall clock lands
    // in, so the OTHER one is forced here: a boundary an hour from now is
    // always still ahead of now, so "today" must be yesterday's entry.
    const ahead = new Date(Date.now() + 3600 * 1000);
    const aheadHHMM = `${String(ahead.getHours()).padStart(2, "0")}:${String(ahead.getMinutes()).padStart(2, "0")}`;
    const forced = await ev(`(async () => {
      const before = (await window.freeframe.dailyOverview()).day.dayKey;
      await window.freeframe.setSettings({ dayBoundary: ${JSON.stringify(aheadHHMM)} });
      const after = (await window.freeframe.dailyOverview()).day.dayKey;
      await window.freeframe.setSettings({ dayBoundary: "00:00" });
      const restored = (await window.freeframe.dailyOverview()).day.dayKey;
      return JSON.stringify({ before, after, restored });
    })()`).then(JSON.parse);
    // Skipped only in the hour before midnight, where "an hour from now"
    // is tomorrow and the premise no longer holds.
    if (ahead.getDate() === new Date().getDate()) {
      check(forced.after !== forced.before,
        `a boundary still ahead of now (${aheadHHMM}) puts today on the previous day`,
        JSON.stringify(forced));
      check(forced.restored === forced.before,
        "and setting it back to midnight restores today", JSON.stringify(forced));
    } else {
      console.log("     (within an hour of midnight — the forced-shift case does not apply)");
    }

    // A job FILED while the boundary shifts must land in the shifted day.
    //
    // The discriminator: file it with a boundary still ahead of now (so it
    // belongs to yesterday), then read back with a plain midnight boundary
    // (so "today" is today). It must be absent. If the recorder ignored the
    // setting and filed under today, it would show up — and every check
    // above would still pass, because they set and read with the same
    // boundary.
    if (ahead.getDate() === new Date().getDate()) {
      console.log("\n6b. A job is FILED under the configured boundary");
      // Boundary first, THEN reset: reset clears the CURRENT logical day,
      // so resetting before the shift clears the wrong one and leaves any
      // pre-existing rows under the shifted key to be counted here.
      await ev(`window.freeframe.setSettings({ dayBoundary: ${JSON.stringify(aheadHHMM)} })`);
      await ev(`window.freeframe.resetDailyOverview()`);
      await ev(`(async () => {
        const st = await window.freeframe.listPresets();
        setActivePreset(null); updatePresetLabel(); return true;
      })()`);
      // A card used nowhere else, so its presence is unambiguous rather
      // than a change in some other row's totals.
      await run(cardC, d2);
      const underShift = await ev(`window.freeframe.dailyOverview().then(r =>
        JSON.stringify(r.day.cards.map(c => c.label)))`).then(JSON.parse);
      check(underShift.includes("C003"),
        "it appears while the shifted boundary is active", JSON.stringify(underShift));
      await ev(`window.freeframe.setSettings({ dayBoundary: "00:00" })`);
      const underPlain = await ev(`window.freeframe.dailyOverview().then(r =>
        JSON.stringify(r.day.cards.map(c => c.label)))`).then(JSON.parse);
      check(!underPlain.includes("C003"),
        "and NOT under a plain midnight day — so it really was filed on the shifted key",
        JSON.stringify(underPlain));
    }

    // ── 7. Reset clears today, and only today ────────────────────────────
    console.log("\n7. Reset now");
    const reset = await ev(`(async () => {
      const r = await window.freeframe.resetDailyOverview();
      const again = await window.freeframe.dailyOverview();
      return JSON.stringify({ cleared: r.day.cards.length, reread: again.day.cards.length });
    })()`).then(JSON.parse);
    check(reset.cleared === 0 && reset.reread === 0,
      "today's entry is empty, and stays empty when re-read", JSON.stringify(reset));
    const stillThere = await ev(`window.freeframe.appInfo().then(() => true)`);
    check(stillThere === true, "and the app is still alive — reset is not a crash");

    check(errs.length === 0, "no uncaught exception across the whole run", errs.join(" | "));
  } finally {
    if (presetId) await ev(`window.freeframe.deletePreset(${JSON.stringify(presetId)})`).catch(() => {});
    try { ws.close(); } catch {}
    try { child.kill(); } catch {}
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
