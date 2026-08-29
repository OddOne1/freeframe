#!/usr/bin/env node
// Job queue + concurrency scheduler (CLAUDE.md §18c).
//
// Driven directly with fake jobs rather than real drives — that's the
// whole reason job-queue.js is electron-free. A scheduler tested only
// through the UI is a scheduler whose edge cases ship.
//
// Run: node scripts/test-job-queue.js
const assert = require("node:assert");
const path = require("node:path");
const { JobQueue, BYTES_BROADCAST_MS, canCoexist, tolerates, normalizeMode } = require(
  path.join(__dirname, "..", "src", "main", "job-queue.js"),
);

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const J = (mode, sourceKey, destKeys) => ({ mode, sourceKey, destKeys });

console.log("1. The pairwise rule");
check(canCoexist(J("free", "A", ["X"]), J("free", "B", ["Y"])),
  "free + free, nothing shared → together");
check(canCoexist(J("source", "A", ["X"]), J("source", "A", ["Y"])),
  "source + source sharing a SOURCE → together");
check(!canCoexist(J("source", "A", ["X"]), J("source", "B", ["Y"])),
  "source + source NOT sharing a source → NOT together (the counter-intuitive one)");
check(canCoexist(J("destination", "A", ["X"]), J("destination", "B", ["X"])),
  "destination + destination sharing a DESTINATION → together");
check(!canCoexist(J("destination", "A", ["X"]), J("destination", "B", ["Y"])),
  "destination + destination not sharing one → NOT together");

console.log("\n2. Both sides must agree");
check(!canCoexist(J("free", "A", ["X"]), J("source", "B", ["Y"])),
  "free is willing, source is not → refused (agreement is mutual)");
check(canCoexist(J("free", "A", ["X"]), J("source", "A", ["Y"])),
  "…unless the strict one's own condition happens to hold");
check(tolerates(J("free", "A", ["X"]), J("source", "B", ["Y"])) === true,
  "tolerates() alone is one-directional");
check(tolerates(J("source", "B", ["Y"]), J("free", "A", ["X"])) === false,
  "…and the other direction is what blocks it");

console.log("\n2b. Single Transfer tolerates nothing, in both directions");
check(!canCoexist({ mode: "exclusive", sourceKey: "a", destKeys: ["x"] },
                  { mode: "exclusive", sourceKey: "a", destKeys: ["x"] }),
  "not even another Single Transfer job with an identical source and destination");
check(normalizeMode("exclusive") === "exclusive",
  "and the mode survives normalisation rather than falling back to free");

console.log("\n3. An unknown mode is treated as the most restrictive");
check(!canCoexist(J("banana", "A", ["X"]), J("free", "A", ["X"])),
  "a typo queues the job rather than granting free rein");

// ── Live scheduling ──────────────────────────────────────────────────
function makeQueue() {
  const events = [];
  const gates = new Map();
  const q = new JobQueue({
    onChange: () => {},
    run: (job) => {
      events.push(`start:${job.label}`);
      return new Promise((resolve) => {
        gates.set(job.label, () => { events.push(`end:${job.label}`); resolve({ ok: true }); });
      });
    },
  });
  return { q, events, finish: (label) => gates.get(label)?.() };
}

(async () => {
  console.log("\n4. Two fully-concurrent jobs on different drives run simultaneously");
  {
    const { q, events, finish } = makeQueue();
    q.add({ id: "1", label: "A", mode: "free", sourceKey: "cardA", destKeys: ["raid1"] });
    q.add({ id: "2", label: "B", mode: "free", sourceKey: "cardB", destKeys: ["raid2"] });
    await sleep(10);
    check(q.running.length === 2, "both are running at once", `${q.running.length} running`);
    check(events.filter((e) => e.startsWith("start:")).length === 2,
      "both actually started — neither is blocked behind the other");
    finish("A"); finish("B");
    await sleep(10);
  }

  console.log("\n5. Two destination-mode jobs SHARING a destination run simultaneously");
  {
    const { q, finish } = makeQueue();
    q.add({ id: "1", label: "A", mode: "destination", sourceKey: "cardA", destKeys: ["raid1"] });
    q.add({ id: "2", label: "B", mode: "destination", sourceKey: "cardB", destKeys: ["raid1"] });
    await sleep(10);
    check(q.running.length === 2, "both running against one destination", `${q.running.length}`);
    finish("A"); finish("B");
    await sleep(10);
  }

  console.log("\n6. Two source-mode jobs NOT sharing a source: the second QUEUES");
  {
    const { q, finish } = makeQueue();
    q.add({ id: "1", label: "A", mode: "source", sourceKey: "cardA", destKeys: ["raid1"] });
    q.add({ id: "2", label: "B", mode: "source", sourceKey: "cardB", destKeys: ["raid2"] });
    await sleep(10);
    check(q.running.length === 1 && q.queued.length === 1,
      "one runs, one waits", `${q.running.length} running / ${q.queued.length} queued`);
    check(q.snapshot().find((j) => j.id === "2").blockedBy.join(",") === "A",
      "and the panel can say what it's waiting on");

    finish("A");
    await sleep(10);
    check(q.running.length === 1 && q.running[0].label === "B",
      "the queued job starts as soon as the blocker finishes");
    finish("B");
    await sleep(10);
  }

  console.log("\n6b. Single Transfer runs exactly one job, whatever the others are (\u00a763)");
  {
    // The three cases the spec names, in one queue: a job sharing its
    // source, a job sharing its destination, and a wholly unrelated one.
    // Each of those three coexists happily with SOMETHING today; none of
    // them may coexist with this.
    const { q, finish } = makeQueue();
    q.add({ id: "1", label: "X", mode: "exclusive", sourceKey: "cardA", destKeys: ["raid1"] });
    q.add({ id: "2", label: "sameSource", mode: "source", sourceKey: "cardA", destKeys: ["raid1"] });
    q.add({ id: "3", label: "sameDest", mode: "destination", sourceKey: "cardB", destKeys: ["raid1"] });
    q.add({ id: "4", label: "unrelated", mode: "free", sourceKey: "cardZ", destKeys: ["raid9"] });
    await sleep(10);
    check(q.running.length === 1 && q.running[0].label === "X",
      "only the exclusive job runs", q.running.map((j) => j.label).join(",") || "(none)");
    check(q.queued.length === 3, "all three others wait", `${q.queued.length} queued`);
    // The asymmetric half: a `free` job tolerates anything, so it would run
    // unless canCoexist's AND of both directions is doing its job.
    check(q.snapshot().find((j) => j.id === "4").blockedBy.join(",") === "X",
      "including a 'free' job, which tolerates everything and is refused by the other side");
    finish("X");
    await sleep(10);
    // Deliberately NOT "all three now run": they do not all coexist with
    // each OTHER either (sameSource wants cardA, sameDest is on cardB), so
    // asserting three would be asserting a rule this queue has never had.
    // What matters is that X has stopped being the reason anything waits.
    check(q.running.length >= 1, "something starts once it finishes", `${q.running.length} running`);
    check(q.snapshot().filter((j) => j.blockedBy.includes("X")).length === 0,
      "and nothing is blocked by it any more");
    // They start in waves, since they do not all coexist with each other.
    for (let i = 0; i < 5 && (q.running.length || q.queued.length); i++) {
      for (const l of ["sameSource", "sameDest", "unrelated"]) finish(l);
      await sleep(20);
    }
    check(q.queued.length === 0 && q.running.length === 0, "and the queue drains",
      `${q.running.length} running / ${q.queued.length} queued`);
  }

  console.log("\n6c. And an exclusive job queued BEHIND others waits for all of them");
  {
    const { q, finish } = makeQueue();
    q.add({ id: "1", label: "A", mode: "free", sourceKey: "cardA", destKeys: ["raid1"] });
    q.add({ id: "2", label: "B", mode: "free", sourceKey: "cardB", destKeys: ["raid2"] });
    q.add({ id: "3", label: "X", mode: "exclusive", sourceKey: "cardC", destKeys: ["raid3"] });
    await sleep(10);
    check(q.running.length === 2 && q.queued.length === 1, "the two free jobs run, the exclusive waits");
    finish("A");
    await sleep(10);
    check(q.running.length === 1 && q.running[0].label === "B",
      "one blocker leaving is not enough — it needs an empty queue");
    finish("B");
    await sleep(10);
    check(q.running.length === 1 && q.running[0].label === "X", "then it starts");
    finish("X");
    await sleep(10);
  }

  console.log("\n7. Scheduling is work-conserving");
  {
    // #2 is blocked by #1, but #3 is compatible with #1 — it should not
    // sit behind #2 just because #2 arrived first.
    const { q, finish } = makeQueue();
    q.add({ id: "1", label: "A", mode: "source", sourceKey: "cardA", destKeys: ["r1"] });
    q.add({ id: "2", label: "B", mode: "source", sourceKey: "cardB", destKeys: ["r2"] });
    q.add({ id: "3", label: "C", mode: "source", sourceKey: "cardA", destKeys: ["r3"] });
    await sleep(10);
    const running = q.running.map((j) => j.label).sort().join(",");
    check(running === "A,C", "A and C run; B waits behind neither of them", running);
    finish("A"); finish("C");
    await sleep(10);
    check(q.running.map((j) => j.label).join(",") === "B", "B starts once the source frees up");
    finish("B");
    await sleep(10);
  }

  console.log("\n8. Cancelling");
  {
    const { q, finish } = makeQueue();
    q.add({ id: "1", label: "A", mode: "source", sourceKey: "cardA", destKeys: ["r1"] });
    const { settled } = q.add({ id: "2", label: "B", mode: "source", sourceKey: "cardB", destKeys: ["r2"] });
    await sleep(10);

    check(q.cancel("2") === true, "a queued job can be cancelled before it starts");
    const res = await settled;
    check(res.neverStarted === true, "…and settles as never-started rather than hanging");
    check(q.running.length === 1, "the running job is untouched");
    finish("A");
    await sleep(10);
  }

  console.log("\n9. A failing job frees its slot and doesn't take the queue down");
  {
    const q = new JobQueue({
      run: (job) => (job.label === "A"
        ? Promise.reject(new Error("disk fell off"))
        : Promise.resolve({ ok: true })),
    });
    const { settled: aSettled } = q.add({ id: "1", label: "A", mode: "source", sourceKey: "cardA", destKeys: ["r1"] });
    q.add({ id: "2", label: "B", mode: "source", sourceKey: "cardB", destKeys: ["r2"] });

    const a = await aSettled;
    await sleep(10);
    check(a.failed === true && /disk fell off/.test(a.error),
      "the failure surfaces on the job, with the real message", a.error);
    check(q.jobs.find((j) => j.id === "1").status === "failed", "row ends in the failed state");
    check(q.jobs.find((j) => j.id === "2").status !== "queued",
      "and the blocked job still gets to run", q.jobs.find((j) => j.id === "2").status);
  }

  console.log("\n10. History is trimmed, live jobs never are");
  {
    const q = new JobQueue({ run: () => Promise.resolve({ ok: true }) });
    q.maxHistory = 3;
    for (let i = 0; i < 10; i++) {
      q.add({ id: `j${i}`, label: `J${i}`, mode: "free", sourceKey: "s", destKeys: ["d"] });
    }
    await sleep(30);
    check(q.jobs.length === 3, "old finished rows are dropped", `${q.jobs.length} kept`);
    check(q.jobs.every((j) => j.status === "done"), "and only finished ones were eligible");
  }

  // ── §94: byte ticks must not rebuild the panel on every frame ────────
  console.log("\n\u00a794. Broadcasts are throttled for byte ticks only");
  {
    // A controlled clock, matching test-rate-settings' own convention —
    // a test that slept for real would be slow and flaky.
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      let broadcasts = 0;
      const q = new JobQueue({ onChange: () => { broadcasts += 1; }, run: () => new Promise(() => {}) });
      q.add({ id: "j", label: "J", payload: {} });
      await sleep(0);
      const job = q.jobs[0];
      check(job.status === "running", "a job is running to update", job.status);

      broadcasts = 0;
      // The real shape: many ticks inside one interval.
      for (let i = 1; i <= 50; i++) {
        t += 1;   // 1ms apart
        q.updateProgress("j", { phase: "bytes", copiedBytes: i * 1000, totalBytes: 100000 });
      }
      check(broadcasts === 1,
        "50 byte ticks inside one interval cause ONE broadcast, not 50", String(broadcasts));
      // The whole point: what the panel rebuild was destroying mid-click.
      check(job.progress.copiedBytes === 50000,
        "…while the state itself is fully current, not coalesced away",
        String(job.progress.copiedBytes));

      t += BYTES_BROADCAST_MS;
      q.updateProgress("j", { phase: "bytes", copiedBytes: 60000, totalBytes: 100000 });
      check(broadcasts === 2, "once the interval passes, the next tick broadcasts", String(broadcasts));

      // Every real transition is immediate. Throttling one of these would
      // be worse than the bug — Cancel lingering on a finished job.
      broadcasts = 0;
      for (const phase of ["file-start", "file-done", "node-status", "verifying", "source-released", "done"]) {
        q.updateProgress("j", { phase, copiedBytes: 60000, totalBytes: 100000 });
      }
      check(broadcasts === 6,
        "six non-bytes updates in the same instant all broadcast immediately", String(broadcasts));

      // A progress object with no phase at all must not be mistaken for a
      // bytes tick and silently swallowed.
      broadcasts = 0;
      q.updateProgress("j", { copiedBytes: 61000 });
      check(broadcasts === 1, "an update with no phase is treated as a real one");

      // The returned object feeds the docked footer over its own channel,
      // which never sees the throttle.
      t += 1;
      const returned = q.updateProgress("j", { phase: "bytes", copiedBytes: 62000, totalBytes: 100000 });
      check(returned && returned.copiedBytes === 62000,
        "a throttled tick still returns its enriched numbers to the caller",
        returned && String(returned.copiedBytes));
      check("speed" in returned && "eta" in returned,
        "…including speed/ETA, so the footer is unaffected");
    } finally {
      Date.now = realNow;
    }
  }

  // ── §95: in-session pause/resume ─────────────────────────────────────
  console.log("\n\u00a795. Pause and resume a running job");
  {
    // A queue whose jobs expose the same _pause/_resume/_cancel callbacks
    // main.js's copy:start payload sets, so what is exercised is the
    // handshake between the two rather than the queue talking to itself.
    const mk = () => {
      const events = [];
      const q = new JobQueue({
        onChange: () => {},
        run: (job) => new Promise((resolve) => {
          let paused = false;
          let waiters = [];
          const wake = () => { const w = waiters; waiters = []; for (const r of w) r(); };
          job._pause = () => { paused = true; events.push(`pause:${job.label}`); };
          job._resume = () => { paused = false; events.push(`resume:${job.label}`); wake(); };
          job._cancel = () => { paused = false; events.push(`cancel:${job.label}`); wake(); resolve({ cancelled: true }); };
          job._finishNow = () => resolve({ ok: true });
          job._waitIfPaused = () => (paused ? new Promise((r) => waiters.push(r)) : Promise.resolve());
        }),
      });
      return { q, events };
    };

    {
      const { q, events } = mk();
      q.add({ id: "a", label: "A", payload: {} });
      await sleep(0);
      check(q.jobs[0].status === "running", "a job is running");
      check(q.pause("a") === true, "pause takes");
      check(q.jobs[0].status === "paused", "…and the status says so", q.jobs[0].status);
      check(events.includes("pause:A"), "…having called the job's own _pause");

      // The loop really parks, and really unparks.
      let unparked = false;
      q.jobs[0]._waitIfPaused().then(() => { unparked = true; });
      await sleep(0);
      check(unparked === false, "the copy loop is parked while paused");
      check(q.resume("a") === true, "resume takes");
      await sleep(0);
      check(unparked === true, "…and the loop continues");
      check(q.jobs[0].status === "running", "…back to running", q.jobs[0].status);
    }

    {
      // A paused job must not hold a concurrency slot.
      const { q } = mk();
      q.add({ id: "a", label: "A", mode: "exclusive", payload: {} });
      await sleep(0);
      q.add({ id: "b", label: "B", mode: "free", payload: {} });
      await sleep(0);
      check(q.jobs[1].status === "queued", "an exclusive job blocks a second one", q.jobs[1].status);
      q.pause("a");
      await sleep(0);
      check(q.jobs[1].status === "running",
        "pausing it frees the slot — even for \"Single Transfer\"", q.jobs[1].status);

      // …and resuming into a state that mode forbids is REFUSED rather
      // than silently allowed. Visible beats broken.
      check(q.resume("a") === false, "resuming back into the conflict is refused");
      check(q.jobs[0].status === "paused", "…the job stays paused", q.jobs[0].status);
      check(/waiting on/.test(q.jobs[0].statusNote || ""),
        "…and says what it is waiting on", q.jobs[0].statusNote);
    }

    {
      // Cancel must always win. A paused job that could not be cancelled
      // would be a trap with no way out.
      const { q, events } = mk();
      q.add({ id: "a", label: "A", payload: {} });
      await sleep(0);
      q.pause("a");
      check(q.cancel("a") === true, "a PAUSED job is still cancellable");
      check(events.includes("cancel:A"), "…reaching the job's own _cancel");
      await sleep(0);
      check(q.jobs[0].status === "cancelled",
        "…and it actually settles rather than sitting paused forever", q.jobs[0].status);
    }

    {
      // History must not swallow work that is merely parked.
      const { q } = mk();
      q.add({ id: "a", label: "A", payload: {} });
      await sleep(0);
      q.pause("a");
      check(JobQueue.isFinished(q.jobs[0]) === false, "a paused job is not history");
      check(q.removeFinished("a") === false, "…so Remove refuses it, same as a running one");
      q.clearFinished();
      check(q.jobs.length === 1, "…and Clear leaves it alone");

      // _trimHistory only fires past maxHistory, so a single paused job
      // could never reach it — the fixture has to be big enough for the
      // trim to actually run.
      for (let i = 0; i < 80; i++) {
        q.jobs.push({ id: `h${i}`, label: `H${i}`, status: "done", finishedAt: i + 1 });
      }
      q._trimHistory();
      check(q.jobs.some((j) => j.id === "a" && j.status === "paused"),
        "…and history trimming past its cap never drops it either",
        String(q.jobs.length));
    }

    {
      // Nothing to pause, nothing to resume.
      const { q } = mk();
      q.add({ id: "a", label: "A", payload: {} });
      await sleep(0);
      check(q.resume("a") === false, "resume on a RUNNING job does nothing");
      check(q.pause("nope") === false, "pause on an unknown id does nothing");
      q.pause("a");
      check(q.pause("a") === false, "pausing an already-paused job does nothing");
    }
  }

  // ── §96: the click is acknowledged before the stop catches up ────────
  console.log("\n\u00a796. Cancelling is visible while it is still happening");
  {
    // A job whose _cancel does NOT resolve immediately — which is the real
    // shape: the engine only checks between files, so a large clip keeps
    // copying after the click. A fixture that settled at once would make
    // the whole window this flag exists for invisible.
    const mk = () => {
      let broadcasts = 0;
      const stops = new Map();
      const q = new JobQueue({
        onChange: () => { broadcasts += 1; },
        run: (job) => new Promise((resolve) => {
          job._cancel = () => { stops.set(job.label, () => resolve({ cancelled: true })); };
          job._pause = () => {};
          job._resume = () => {};
          job._finishNow = () => resolve({ ok: true });
        }),
      });
      return { q, stops, count: () => broadcasts };
    };

    {
      const { q, stops } = mk();
      q.add({ id: "a", label: "A", payload: {} });
      await sleep(0);
      check(q.jobs[0].cancelling === false, "a running job is not cancelling by default");

      const before = q.snapshot()[0];
      check(before.status === "running" && before.cancelling === false,
        "…and the snapshot the renderer reads says so");

      q.cancel("a");
      // The whole point: same tick as the click, not the next progress tick.
      const mid = q.snapshot()[0];
      check(mid.cancelling === true, "cancel marks it immediately");
      check(mid.status === "running",
        "…while the status stays running — no fourth in-flight state to teach the scheduler",
        mid.status);

      // Still genuinely in flight, and still counted as such.
      check(q.running.length === 1, "…so it still occupies its slot until it really stops");
      check(JobQueue.isFinished(q.jobs[0]) === false, "…and is not history yet");

      stops.get("A")();
      await sleep(0);
      const after = q.snapshot()[0];
      check(after.status === "cancelled", "once it settles the status catches up", after.status);
      check(after.cancelling === false,
        "…and the flag clears — it has stopped, so it is no longer stopping");
    }

    {
      // The broadcast has to happen on the click. §94 throttles byte ticks
      // only, and this is the one signal whose entire value is being
      // instant, so it must not wait for the next one.
      const { q, count } = mk();
      q.add({ id: "a", label: "A", payload: {} });
      await sleep(0);
      const before = count();
      q.cancel("a");
      check(count() === before + 1, "cancelling broadcasts straight away",
        `${count() - before} broadcast(s)`);
    }

    {
      // A job that finishes normally must never have shown it.
      const { q } = mk();
      q.add({ id: "a", label: "A", payload: {} });
      await sleep(0);
      q.jobs[0]._finishNow();
      await sleep(0);
      check(q.jobs[0].status === "done" && q.jobs[0].cancelling === false,
        "a job that finishes normally never shows Cancelling", q.jobs[0].status);
    }

    {
      // A QUEUED job never enters this path — it stops at once, with
      // nothing in flight to wait for.
      const { q } = mk();
      q.add({ id: "a", label: "A", mode: "exclusive", payload: {} });
      await sleep(0);
      q.add({ id: "b", label: "B", mode: "exclusive", payload: {} });
      await sleep(0);
      check(q.jobs[1].status === "queued", "a second exclusive job is queued");
      q.cancel("b");
      check(q.jobs[1].status === "cancelled",
        "cancelling it is immediate, as before", q.jobs[1].status);
      check(q.jobs[1].cancelling !== true,
        "…and it never passes through Cancelling — there was nothing to wait for");
    }
  }

  {
    // The flag is only worth anything if the row renders it. panel.js needs
    // a DOM, so this reads the expression it picks the label with — the
    // same source-level shape §92's own label check uses.
    const fs = require("node:fs");
    const psrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "renderer", "panel.js"), "utf8");
    const i = psrc.indexOf('class: "job-status"');
    const block = psrc.slice(i, i + 400);
    check(/j\.cancelling/.test(block) && /"Cancelling\u2026"/.test(block),
      "panel.js labels a cancelling row \"Cancelling\u2026\"");
    check(/STATUS_LABEL\[j\.status\]/.test(block),
      "…and falls back to the normal label otherwise");
    // Text only. A new dot colour would read as a new outcome rather than
    // as the same one arriving.
    check(!/job-dot[^\n]*cancelling/.test(psrc),
      "…without inventing a new dot colour for it");
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})();
