#!/usr/bin/env node
// Resuming an interrupted LOCAL COPY, in the real app (CLAUDE.md §105B).
//
// test-copy.js drives the skip logic, the keying and the retirement rule
// directly against the engine. What only the running app can show is the
// part §105B actually exists for: that a copy killed mid-transfer is
// FOUND on the next launch, OFFERED as a copy rather than as an upload,
// and that accepting it copies what is missing without re-reading what is
// not. Every engine check would keep passing against a build where the
// prompt never appears.
//
// The crash here is a real one: SIGKILL to the process group, mid-copy,
// with no chance to finish a journal or tidy up. That is the scenario, and
// simulating it with a graceful cancel would be testing something else.
//
// Run: node scripts/e2e-resume-copy.js
const { execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const fss = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
// One port PER INSTANCE. This harness deliberately keeps several apps
// alive at once (the crashed one, the one that finds it, a fresh launch
// that must not have been told anything yet). On a single shared port the
// second instance cannot bind it, /json/list keeps answering for the
// FIRST, and the WebSocket silently attaches to the wrong app — at which
// point "a fresh launch does not reopen the modal" passes because the
// instance being asked already dismissed it, not because the behaviour is
// right.
const PORT_BASE = 9451;
let portSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

async function launch() {
  const port = PORT_BASE + (portSeq++);
  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${port}`], { stdio: "ignore" },
  );
  let page;
  for (let i = 0; i < 80; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 180000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
    return r.result.value;
  };
  await sleep(1500);
  return { child, ws, ev, errs, port };
}

/** SIGKILL the whole group. The .bin/electron shim spawns the real binary
 *  as its own child, so killing the handle leaves the app running — the
 *  same trap electron-harness.js documents. */
function hardKill(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { child.kill("SIGKILL"); } catch {}
}

const journalsIn = (dir) => {
  try { return fss.readdirSync(dir).filter((n) => n.endsWith(".journal.json")); }
  catch { return []; }
};

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=94[5-9]' || true`); } catch {}
  await sleep(800);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-resume-"));
  const card = path.join(tmp, "CARD01");
  const dest = path.join(tmp, "RAID");
  await fsp.mkdir(path.join(card, "DCIM"), { recursive: true });
  await fsp.mkdir(dest, { recursive: true });
  // Many small files rather than a few big ones. This machine copies and
  // verifies 96MB in 86ms, so a size-based payload big enough to still be
  // running when the kill lands would have to be gigabytes — and would
  // still be a race. File COUNT buys reaction time without the bytes.
  const NAMES = [];
  for (let i = 1; i <= 60; i++) {
    const n = `C${String(i).padStart(4, "0")}.MOV`;
    NAMES.push(n);
    await fsp.writeFile(path.join(card, "DCIM", n), Buffer.alloc(512 * 1024, i));
  }

  let A = await launch();
  // Asked of the app rather than reconstructed from app.getPath here: the
  // journal directory is main's decision, and a test that guesses it would
  // pass against a build that writes journals somewhere else entirely.
  const logDir = await A.ev(`window.freeframe.appInfo().then(i => i.logsPath)`);
  if (!logDir) {
    console.error("app:info did not report a logs path; aborting rather than guessing.");
    hardKill(A.child); process.exit(1);
  }

  console.log("1. A copy killed mid-transfer leaves a resumable journal");
  const before = new Set(journalsIn(logDir));
  // Fire and forget: awaiting it would mean waiting for a job this test
  // is about to kill.
  await A.ev(`(() => {
    window.__resume_test = window.freeframe.startCopy(
      ${JSON.stringify(card)},
      [{ id: "n1", path: ${JSON.stringify(dest)}, parentId: null }],
      "xxhash64", null, null, null, "free", false
    ).catch(() => {});
    return true;
  })()`);

  // PAUSE, then kill. Not a convenience: a job that runs to completion
  // deletes its own journal, so a test that races the clock either kills
  // too early (nothing journalled) or too late (nothing left to resume) —
  // and which one it gets depends on the machine. Pausing stops the loop
  // between files, at which point the journal is stable and the SIGKILL
  // below is still a real crash: the app dies mid-job with a partial
  // journal, no finishJournal, and no chance to tidy up.
  let jFile = null, doneBefore = 0;
  for (let i = 0; i < 400; i++) {
    const fresh = journalsIn(logDir).filter((n) => !before.has(n));
    if (fresh.length) {
      jFile = path.join(logDir, fresh[0]);
      try {
        const doc = JSON.parse(fss.readFileSync(jFile, "utf8"));
        if ((doc.files || []).length >= 3) {
          const id = doc.jobId;
          await A.ev(`window.freeframe.pauseCopy(${JSON.stringify(id)})`);
          break;
        }
      } catch {}
    }
    await sleep(25);
  }
  // Let the in-flight file land, then read what the journal settled on.
  await sleep(700);
  try { doneBefore = JSON.parse(fss.readFileSync(jFile, "utf8")).files.length; } catch {}
  check(Boolean(jFile) && doneBefore >= 3 && doneBefore < NAMES.length,
    "the copy got underway, journalled progress live, and was stopped part-way",
    `${doneBefore} of ${NAMES.length} file(s) recorded`);
  hardKill(A.child);
  await sleep(1500);

  const doc = JSON.parse(fss.readFileSync(jFile, "utf8"));
  const crashedId = doc.jobId;
  check(doc.status === "running" && doc.kind === "copy",
    "…and the journal it left behind is a running COPY", `${doc.kind}/${doc.status}`);
  check(Array.isArray(doc.nodes) && doc.nodes.length === 1 && doc.nodes[0].path === dest,
    "…recording its destination topology", JSON.stringify(doc.nodes));
  const landedAfterCrash = fss.readdirSync(path.join(dest, "CARD01", "DCIM")).sort();
  check(landedAfterCrash.length < NAMES.length,
    "…with the copy genuinely incomplete on disk",
    `${landedAfterCrash.length} of ${NAMES.length}`);
  // What a resume must not disturb: the files already there. Recorded now,
  // compared after.
  const mtimeBefore = new Map();
  for (const f of doc.files.filter((x) => x.ok)) {
    for (const d of f.destinations) {
      try { mtimeBefore.set(d.path, fss.statSync(d.path).mtimeMs); } catch {}
    }
  }
  check(mtimeBefore.size > 0, "…and their timestamps are readable, so a re-copy would show",
    `${mtimeBefore.size} destination file(s)`);

  console.log("\n2. The next launch finds it and offers it as a COPY");
  const B = await launch();
  const found = await B.ev(`window.freeframe.interruptedUploads().then(d =>
    d.filter(x => x.jobId === ${JSON.stringify(crashedId)}))`);
  check(found.length === 1, "detection returns the interrupted copy", `${found.length} match(es)`);
  check(found[0] && found[0].kind === "copy",
    "…labelled as a copy, which is what selects the right prompt and the right resume",
    found[0] && found[0].kind);
  check(found[0] && Array.isArray(found[0].nodes) && found[0].nodes[0].path === dest,
    "…carrying the destinations it was going to");
  check(found[0] && found[0].verifiedCount >= 3,
    "…and how much had already verified", String(found[0] && found[0].verifiedCount));

  // The prompt itself, driven the way launch drives it.
  await B.ev(`(async () => { await maybeOfferResume("launch"); return true; })()`);
  await sleep(500);
  const prompt = await B.ev(`(() => {
    const b = document.getElementById("resume-backdrop");
    return { open: b.classList.contains("open"),
             body: document.getElementById("resume-body").textContent,
             detail: document.getElementById("resume-detail").textContent };
  })()`);
  check(prompt.open, "the resume prompt is actually shown");
  check(/was copying to/.test(prompt.body) && !/uploading/.test(prompt.body),
    "…describing a copy, not an upload", prompt.body);
  check(/still on the destination at the size/.test(prompt.detail),
    "…and saying what resuming will actually check", prompt.detail);
  // A journal holds only what finished, so a denominator taken from it is
  // always the numerator — "8 of 8", which reads as a job that completed.
  check(/\d+ file\(s\) had copied and verified before it stopped/.test(prompt.detail)
    && !/of \d+ file/.test(prompt.detail),
    "…without inventing a total it never recorded", prompt.detail);

  console.log("\n2b. (\u00a7105A) \"Not now\" parks it instead of deleting it");
  {
    // The complaint this exists for: Discard was the only way to stop
    // being asked, and it deletes the job.
    await B.ev(`(() => { document.getElementById("resume-later").click(); return true; })()`);
    await sleep(600);
    const closed = await B.ev(`document.getElementById("resume-backdrop").classList.contains("open")`);
    check(closed === false, "the modal closes");
    check(fss.existsSync(jFile), "…and the journal is still on disk — parked, not discarded");
    const doc2 = JSON.parse(fss.readFileSync(jFile, "utf8"));
    check(doc2.hiddenFromPrompt === true,
      "…with the flag written to DISK, which is the whole point: resumeOffered forgets at every launch",
      String(doc2.hiddenFromPrompt));
    // The bell is where it goes instead.
    //
    // EVERY assertion here is scoped to this test's OWN job id, and that
    // is not fastidiousness: this app's e2e harnesses share the real
    // userData with whatever the developer is running, so the bell can
    // legitimately hold their jobs too. An earlier version of this asserted
    // a badge count of 1 and clicked "the first Resume button" — which,
    // with a real interrupted job parked, would have resumed THEIRS.
    await B.ev(`refreshNotifications()`);
    const bell = await B.ev(`(() => {
      const item = document.querySelector('#notif-card .notif-item[data-notif-id="${crashedId}"]');
      return {
        hidden: document.getElementById("notif-btn").hidden,
        badge: document.getElementById("notif-badge").textContent,
        mine: !!item,
      };
    })()`);
    check(bell.hidden === false, "the bell appears");
    check(Number(bell.badge) >= 1, "…with a count", bell.badge);
    await B.ev(`(() => { document.getElementById("notif-btn").click(); return true; })()`);
    await sleep(500);
    const panel = await B.ev(`(() => {
      const c = document.getElementById("notif-card");
      const item = c.querySelector('.notif-item[data-notif-id="${crashedId}"]');
      return { open: c.classList.contains("open"),
               present: !!item,
               text: item ? item.textContent : "",
               actions: item ? [...item.querySelectorAll(".notif-actions button")].map(b => b.textContent) : [] };
    })()`);
    check(panel.open, "the panel opens");
    check(panel.present, "…listing THIS test's parked job specifically");
    check(/interrupted copy/.test(panel.text),
      "…describing it by kind", panel.text.slice(0, 80));
    check(panel.actions.join(",") === "Resume,Dismiss",
      "…offering Resume and Dismiss", panel.actions.join(","));
  }

  console.log("\n2c. A parked job no longer seizes the window");
  {
    const C = await launch();
    // The claim is about THIS job, not about the modal being absent: this
    // machine can legitimately hold other interrupted jobs (the developer's
    // own), and one of those being offered is the feature working. What
    // must not happen is the PARKED one seizing the window again.
    const shown = await C.ev(`(async () => {
      await maybeOfferResume("launch");
      await new Promise(r => setTimeout(r, 400));
      const open = document.getElementById("resume-backdrop").classList.contains("open");
      return { open, body: document.getElementById("resume-body").textContent };
    })()`);
    check(!shown.open || !shown.body.includes("CARD01"),
      "on a FRESH LAUNCH the parked journal does not reopen the blocking modal",
      shown.open ? `a modal is open, for: ${shown.body.slice(0, 60)}` : "no modal at all");
    const stillThere = await C.ev(`window.freeframe.interruptedUploads().then(d =>
      d.filter(x => x.jobId === ${JSON.stringify(crashedId)}).map(x => x.hiddenFromPrompt))`);
    check(stillThere.length === 1 && stillThere[0] === true,
      "…because it is still there, still parked — not because it was deleted",
      JSON.stringify(stillThere));
    // The click handler is async (it re-reads from disk before painting),
    // so querying in the same synchronous expression races it — which is
    // what made this read as a missing item rather than a slow one.
    await C.ev(`(() => { document.getElementById("notif-btn").click(); return true; })()`);
    await sleep(600);
    check(await C.ev(`!!document.querySelector('#notif-card .notif-item[data-notif-id="${crashedId}"]')`),
      "…and the bell still lists it after the restart");
    hardKill(C.child);
    await sleep(800);
  }

  console.log("\n3. Resuming copies what is missing and re-reads nothing else");
  // From the BELL this time, not the modal — the spec's requirement that
  // both entry points run the same flow. runResume is literally the same
  // function; this proves the button reaches it.
  const D = await launch();
  await D.ev(`(async () => { await refreshNotifications(); return true; })()`);
  await D.ev(`(() => {
    document.getElementById("notif-btn").click(); return true;
  })()`);
  await sleep(400);
  const clicked = await D.ev(`(() => {
    const item = document.querySelector('#notif-card .notif-item[data-notif-id="${crashedId}"]');
    if (!item) return false;
    const b = [...item.querySelectorAll(".notif-actions button")].find(x => x.textContent === "Resume");
    if (!b) return false;
    b.click(); return true;
  })()`);
  check(clicked, "Resume is clicked on THIS test's own bell item, not whichever sorted first");
  // Wait for the destination to hold everything, or give up.
  let landed = [];
  for (let i = 0; i < 300; i++) {
    landed = fss.readdirSync(path.join(dest, "CARD01", "DCIM")).sort();
    if (landed.length === NAMES.length) break;
    await sleep(200);
  }
  check(landed.length === NAMES.length,
    "every file is on the destination after the resume", `${landed.length} of ${NAMES.length}`);
  await sleep(1200);   // let the final journal writes settle

  let untouched = 0, rewritten = 0;
  for (const [p, was] of mtimeBefore) {
    try { (fss.statSync(p).mtimeMs === was ? untouched++ : rewritten++); } catch { rewritten++; }
  }
  // The real measure of a resume. A pass that re-copied everything would
  // still end with a complete, verified destination — and be worth
  // nothing. An untouched mtime is a file whose bytes were never rewritten.
  check(untouched === mtimeBefore.size && rewritten === 0,
    "…and the files that were already good were never rewritten",
    `${untouched} untouched, ${rewritten} rewritten`);

  const after = journalsIn(logDir);
  check(!after.includes(path.basename(jFile)),
    "the predecessor journal is retired once the resumed run covers it",
    after.join(", ") || "(none left)");

  const errs = [...B.errs, ...D.errs].filter((e) => !/ResizeObserver/.test(e));
  check(errs.length === 0, "no uncaught exception across the whole run", errs.join(" | "));

  // Clean up after ourselves. A parked journal is kept ON PURPOSE — that
  // is the feature — so nothing retires one automatically, and every run
  // of this harness would otherwise leave another entry in the real
  // notification bell for good. Scoped by source path so it can only ever
  // remove journals this file created.
  let swept = 0;
  for (const n of journalsIn(logDir)) {
    try {
      const d = JSON.parse(fss.readFileSync(path.join(logDir, n), "utf8"));
      if (typeof d.sourcePath === "string" && d.sourcePath.includes("ff-resume-")) {
        fss.rmSync(path.join(logDir, n)); swept++;
      }
    } catch {}
  }
  console.log(`  (swept ${swept} journal(s) this harness created)`);

  hardKill(B.child);
  hardKill(D.child);
  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
