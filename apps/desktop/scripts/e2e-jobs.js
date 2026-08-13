#!/usr/bin/env node
// Concurrent jobs + the progress panel, through the real app (§18c).
//
// The unit tests in test-job-queue.js prove the scheduler's rule with
// fake jobs. This proves the real thing: actual Electron, actual
// copy-engine, actual files on disk, and the four checks the spec asks
// for by name.
//
// Concurrency is OBSERVED, not sampled. A fixed sleep can't see two jobs
// overlap — the first version of this file slept 700ms and every copy had
// already finished, so it reported "not concurrent" for a queue that was
// running both perfectly well. Instead: poll while the jobs run and
// assert on the peak state actually seen. That holds whether a copy takes
// 200ms on an SSD or 40s on a spinning disk.
//
// Run: node scripts/e2e-jobs.js
const { spawn, execSync } = require("node:child_process");
const { execFileSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const APP = path.join(__dirname, "..");
const PORT = 9319;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { execSync(`pkill -f 'remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(1200);

  // Large enough that two jobs genuinely overlap in wall-clock time. The
  // polling below is what makes the assertions robust, but there still has
  // to be a window to observe.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-jobs-"));
  const mk = async (name, files, sizeMB) => {
    const dir = path.join(tmp, name);
    await fsp.mkdir(dir, { recursive: true });
    const block = crypto.randomBytes(1024 * 1024);
    for (let i = 0; i < files; i++) {
      // Distinct contents per file, without paying for 128MB of entropy.
      const buf = Buffer.concat(Array.from({ length: sizeMB }, () => block));
      buf.write(`${name}_${i}`, 0);
      await fsp.writeFile(path.join(dir, `${name}_${i}.bin`), buf);
    }
    return dir;
  };
  const cardA = await mk("CARD_A", 8, 16);
  const cardB = await mk("CARD_B", 8, 16);
  // Section 3 has to catch a job while it sits in the queue, so its
  // blocker needs to still be running when the second job arrives. By
  // then the OS has cached the other cards and a copy takes ~300ms —
  // not a window worth racing against.
  const cardBig = await mk("CARD_BIG", 20, 16);

  // Two REAL mounted volumes for section 3.
  //
  // Everything above lives in one temp directory, so volumeKeyOf() gives
  // every path the same volume key -- and `source` mode tolerates any job
  // sharing its source volume, so on one volume nothing ever queues. That
  // is correct behaviour, and it also means a single-volume fixture
  // cannot exercise the queue at all. Disk images give two genuinely
  // distinct mount points, which is what the mode actually keys off.
  const mounted = [];
  const mountImage = async (volName, sizeMB) => {
    const dmg = path.join(tmp, `${volName}.dmg`);
    execFileSync("hdiutil", ["create", "-size", `${sizeMB}m`, "-fs", "HFS+",
      "-volname", volName, "-quiet", dmg]);
    execFileSync("hdiutil", ["attach", dmg, "-nobrowse", "-quiet"]);
    const mp = `/Volumes/${volName}`;
    mounted.push(mp);
    return mp;
  };
  const detachAll = () => {
    for (const mp of mounted) {
      try { execFileSync("hdiutil", ["detach", mp, "-quiet", "-force"]); } catch {}
    }
  };
  process.on("exit", detachAll);

  let volA, volB;
  try {
    volA = await mountImage("FFJOBS_A", 600);
    volB = await mountImage("FFJOBS_B", 300);
  } catch (e) {
    // Never skip this quietly -- the queueing check is the whole point of
    // the section, and a silent skip would leave it permanently green
    // while testing nothing.
    console.error("Could not create test volumes, cannot verify queueing:", e.message);
    process.exit(1);
  }
  const mkOn = async (root, name, files, sizeMB) => {
    const dir = path.join(root, name);
    await fsp.mkdir(dir, { recursive: true });
    const block = crypto.randomBytes(1024 * 1024);
    for (let i = 0; i < files; i++) {
      const buf = Buffer.concat(Array.from({ length: sizeMB }, () => block));
      buf.write(`${name}_${i}`, 0);
      await fsp.writeFile(path.join(dir, `${name}_${i}.bin`), buf);
    }
    return dir;
  };
  const bigOnA = await mkOn(volA, "BIG_A", 28, 16);
  const smallOnB = await mkOn(volB, "SMALL_B", 6, 16);
  const raid1 = path.join(tmp, "RAID1");
  const raid2 = path.join(tmp, "RAID2");
  const shared = path.join(tmp, "SHARED");
  for (const d of [raid1, raid2, shared]) await fsp.mkdir(d, { recursive: true });

  const child = spawn(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`],
    { stdio: "ignore" },
  );

  const targets = async () =>
    (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
      .filter((t) => t.type === "page");

  let page;
  for (let i = 0; i < 80; i++) {
    try {
      page = (await targets()).find((x) => x.url.includes("index.html"));
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(250);
  }
  if (!page) { console.error("Electron never came up"); process.exit(1); }

  const attach = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    let id = 0; const pend = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    // Closing a window destroys its CDP target mid-call, and the reply for
    // an in-flight evaluate never arrives. Without this the harness hangs
    // forever instead of failing — which is exactly what it did.
    const abort = () => {
      for (const [, p] of pend) p.reject(new Error("CDP target closed"));
      pend.clear();
    };
    ws.addEventListener("close", abort);
    ws.addEventListener("error", abort);
    const send = (me, pa = {}) => new Promise((res, rej) => {
      const i = ++id; pend.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method: me, params: pa }));
    });
    await send("Runtime.enable");
    return {
      ws, send,
      eval: async (x) => {
        const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 300000 });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
        return r.result.value;
      },
    };
  };

  const main = await attach(page);
  await sleep(1800);
  const ev = main.eval;

  // Each call resolves with the job's own summary, exactly as before the
  // queue existed — that contract is what the rest of the suite relies on.
  const startJob = (src, dests, mode) => ev(`
    window.freeframe.startCopy(${JSON.stringify(src)},
      ${JSON.stringify(dests.map((d, i) => ({ id: `n${i}`, path: d, parentId: null })))},
      "xxhash64", null, null, null, ${JSON.stringify(mode)})
      .then(s => ({ ok: true, verified: s.allVerified, files: s.totalFiles }))
      .catch(e => ({ ok: false, error: String(e.message || e) }));
  `);

  /**
   * Poll the queue while `work` runs, and report what was actually seen.
   * `extra` is evaluated on each tick too, for panel-DOM observations.
   */
  const observe = async (work, extra = null) => {
    let done = false;
    const results = Promise.all(work).then((r) => { done = true; return r; });
    const seen = {
      maxRunning: 0,
      sawQueuedBesideRunning: false,
      blockedBy: [],
      bytes: {},        // label -> ordered list of copiedBytes samples
      ticks: 0,
      extra: [],
    };
    while (!done) {
      let jobs;
      try { jobs = await ev(`window.freeframe.listJobs()`); } catch { break; }
      const live = jobs.filter((j) => j.status === "running" || j.status === "queued");
      const running = jobs.filter((j) => j.status === "running");
      const queued = jobs.filter((j) => j.status === "queued");
      seen.ticks += 1;
      seen.maxRunning = Math.max(seen.maxRunning, running.length);
      if (queued.length > 0 && running.length > 0) {
        seen.sawQueuedBesideRunning = true;
        for (const q of queued) {
          if (q.blockedBy?.length) seen.blockedBy.push(...q.blockedBy);
        }
      }
      for (const j of running) {
        (seen.bytes[j.label] ||= []).push(j.progress?.copiedBytes ?? 0);
      }
      if (extra && live.length) {
        try { seen.extra.push(await extra()); } catch {}
      }
      if (!done) await sleep(40);
    }
    seen.results = await results;
    return seen;
  };
  // Distinct increasing samples for a label — i.e. it was genuinely
  // making progress, not merely flagged "running".
  const advanced = (seen, label) => {
    const s = seen.bytes[label] || [];
    return s.length >= 2 && s[s.length - 1] > s[0];
  };

  // ── 1. Fully-concurrent, different drives: both run at once ──────────
  console.log("1. Two fully-concurrent jobs on different drives run simultaneously");
  {
    const seen = await observe([
      startJob(cardA, [raid1], "free"),
      startJob(cardB, [raid2], "free"),
    ]);
    check(seen.maxRunning === 2, "both were RUNNING at the same moment",
      `peak ${seen.maxRunning} over ${seen.ticks} samples`);
    check(!seen.sawQueuedBesideRunning, "neither was ever queued behind the other");
    check(advanced(seen, "CARD_A") && advanced(seen, "CARD_B"),
      "progress advanced on BOTH — genuinely parallel, not just both flagged running",
      JSON.stringify(Object.fromEntries(
        Object.entries(seen.bytes).map(([k, v]) => [k, `${v.length} samples ${v[0]}→${v[v.length - 1]}`]))));
    const [r1, r2] = seen.results;
    check(r1.ok && r1.verified && r2.ok && r2.verified, "both verified",
      JSON.stringify([r1, r2]));
  }

  // ── 2. Shared destination: concurrent, and files land intact ─────────
  console.log("\n2. Two destination-mode jobs sharing one destination");
  {
    const seen = await observe([
      startJob(cardA, [shared], "destination"),
      startJob(cardB, [shared], "destination"),
    ]);
    check(seen.maxRunning === 2, "both ran — neither waited on the other",
      `peak ${seen.maxRunning} over ${seen.ticks} samples`);
    check(!seen.sawQueuedBesideRunning, "nothing was queued at any point");

    const [r1, r2] = seen.results;
    check(r1.ok && r1.verified, "job A verified", JSON.stringify(r1));
    check(r2.ok && r2.verified, "job B verified", JSON.stringify(r2));

    // The actual risk of not auto-serializing: two writers in one folder.
    // Verification already re-reads each file from disk, so "verified"
    // covers this — but check the bytes independently, since not
    // clobbering each other is the specific claim being made.
    const landed = (await fsp.readdir(shared)).sort();
    check(landed.length === 16, "all 16 files from both jobs are present", `${landed.length}`);
    let intact = 0;
    for (const f of landed) {
      const src = f.startsWith("CARD_A") ? cardA : cardB;
      const a = await fsp.readFile(path.join(src, f));
      const b = await fsp.readFile(path.join(shared, f));
      if (a.equals(b)) intact += 1;
    }
    check(intact === landed.length,
      "every file byte-identical to its source — no interleaved writes",
      `${intact}/${landed.length}`);
  }

  // ── 3. Incompatible modes: the second QUEUES ─────────────────────────
  console.log("\n3. Two source-mode jobs on genuinely different volumes");
  {
    const p1 = startJob(bigOnA, [raid1], "source");

    // Submit the second only once the first is definitely running.
    // Sleeping a fixed amount here is what made this section flaky: on a
    // warm cache the blocker had already finished, so there was no queue
    // to observe and a correct scheduler looked broken.
    let firstRunning = false;
    for (let i = 0; i < 200 && !firstRunning; i++) {
      firstRunning = (await ev(`window.freeframe.listJobs()`))
        .some((j) => j.label === "BIG_A" && j.status === "running");
      if (!firstRunning) await sleep(25);
    }
    check(firstRunning, "the first job is running before the second is submitted");

    // Identify the new job by id. Earlier sections left finished CARD_B
    // rows in the history, and matching on the label finds one of those
    // instead — which reads as "the second job started immediately".
    const known = new Set((await ev(`window.freeframe.listJobs()`)).map((j) => j.id));
    const p2 = startJob(smallOnB, [raid2], "source");

    // Catch the queued state at once rather than on the next poll tick.
    let second = null;
    for (let i = 0; i < 400 && !second; i++) {
      second = (await ev(`window.freeframe.listJobs()`)).find((j) => !known.has(j.id));
    }
    check(second?.status === "queued",
      "the second job is QUEUED, not started — its mode doesn't tolerate the first",
      `status=${second?.status}`);
    check(second?.blockedBy?.includes("BIG_A"),
      "and the row names the job it's waiting on, so the panel isn't a mystery",
      JSON.stringify(second?.blockedBy));

    const seen = await observe([p1, p2]);
    check(seen.maxRunning === 1,
      "never more than one running for the whole run — the mode was honoured",
      `peak ${seen.maxRunning} over ${seen.ticks} samples`);

    const [r1, r2] = seen.results;
    check(r1.ok && r1.verified && r2.ok && r2.verified,
      "both eventually completed and verified — queued, not dropped", JSON.stringify([r1, r2]));
    check((await ev(`window.freeframe.listJobs()`)).filter((j) => j.status === "queued").length === 0,
      "nothing left stuck in the queue");
  }

  // ── 4. Detach, live updates, re-dock ─────────────────────────────────
  console.log("\n4. Detach → live updates → close → re-dock");
  {
    await ev(`window.freeframe.detachPanel()`);
    await sleep(900);

    const panelTarget = (await targets()).find((t) => t.url.includes("panel.html"));
    check(Boolean(panelTarget), "the detached window exists");

    const panel = await attach(panelTarget);
    await sleep(400);
    check(await main.eval(`$("jobs-panel").classList.contains("detached")`),
      "the docked tab shows the panel has moved out");

    // A job started AFTER detaching must appear live over there — that's
    // the difference between a live panel and a stale snapshot.
    const seen = await observe(
      [startJob(cardA, [raid2], "free")],
      () => panel.eval(`({
        labels: [...document.querySelectorAll("#jobs .job-row .job-label")].map(e => e.textContent).join(","),
        running: document.querySelectorAll("#jobs .job-row .job-dot.running").length,
      })`),
    );
    check(seen.extra.some((s) => /CARD_A/.test(s.labels)),
      "the new job shows up in the detached window live",
      seen.extra[0]?.labels || "(no samples)");
    check(seen.extra.some((s) => s.running >= 1),
      "and is rendered there as running while it runs",
      `max ${Math.max(0, ...seen.extra.map((s) => s.running))}`);
    check(seen.results[0].ok, "that job completed normally while detached");

    // Close it and confirm nothing is lost.
    const before = (await ev(`window.freeframe.listJobs()`)).length;
    // Driven from the main window. Calling dockPanel() inside the detached
    // window works in the app (that's what its Dock button does) but the
    // reply can't come back over a socket that closes as a result, so the
    // harness would be waiting on a response with no sender left.
    await ev(`window.freeframe.dockPanel()`);
    await sleep(900);

    check(!(await targets()).some((t) => t.url.includes("panel.html")),
      "the detached window is gone");
    check(!(await main.eval(`$("jobs-panel").classList.contains("detached")`)),
      "the panel is docked again");
    const after = (await ev(`window.freeframe.listJobs()`)).length;
    check(after === before, "no job state was lost in the move", `${before} → ${after}`);
    const rowsDocked = await main.eval(`document.querySelectorAll("#jobs-list .job-row").length`);
    check(rowsDocked === after, "and the docked list is rendering them", `${rowsDocked} rows`);
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  child.kill("SIGKILL");
  detachAll();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
