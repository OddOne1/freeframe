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
const { JobQueue, canCoexist, tolerates, normalizeMode } = require(
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

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})();
