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
const PORT = 9451;
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
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 180000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
    return r.result.value;
  };
  await sleep(1500);
  return { child, ws, ev, errs };
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
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
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

  console.log("\n3. Resuming copies what is missing and re-reads nothing else");
  await B.ev(`(() => { document.getElementById("resume-go").click(); return true; })()`);
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

  const errs = B.errs.filter((e) => !/ResizeObserver/.test(e));
  check(errs.length === 0, "no uncaught exception across the whole run", errs.join(" | "));

  hardKill(B.child);
  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
