#!/usr/bin/env node
// Log-panel history housekeeping (CLAUDE.md §59).
//
// The rule worth pinning is a safety one: Clear and Remove are history
// operations, and a queued or running job must be untouchable by them.
// Cancel is the verb for that, and a Clear that silently killed a running
// transfer is the worst available reading of the button.
//
// Run: node scripts/test-history-cleanup.js
const path = require("node:path");
const { JobQueue } = require(path.join(__dirname, "..", "src", "main", "job-queue.js"));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/** A queue whose jobs are parked in a chosen status, without running any
 *  real work. */
function seeded(statuses) {
  const q = new JobQueue({ run: async () => new Promise(() => {}) });
  q.jobs = statuses.map((status, i) => ({
    id: `j${i}`, status, finishedAt: status === "running" || status === "queued" ? null : i,
  }));
  return q;
}

console.log("1. What counts as finished");
check(JobQueue.isFinished({ status: "done" }), "done");
check(JobQueue.isFinished({ status: "failed" }), "failed");
check(JobQueue.isFinished({ status: "cancelled" }), "cancelled");
check(!JobQueue.isFinished({ status: "running" }), "running is NOT");
check(!JobQueue.isFinished({ status: "queued" }), "and neither is queued");

console.log("2. Removing one row");
{
  const q = seeded(["done", "running", "failed"]);
  let changes = 0;
  q.onChange = () => changes++;

  check(q.removeFinished("j0") === true, "a finished row goes");
  check(q.jobs.map((j) => j.id).join(",") === "j1,j2", "and only that row", q.jobs.map((j) => j.id).join(","));
  check(changes === 1, "the panel is told");

  check(q.removeFinished("j1") === false, "a RUNNING row is refused");
  check(q.jobs.some((j) => j.id === "j1"), "and survives");
  check(changes === 1, "with no spurious redraw");

  check(q.removeFinished("nope") === false, "an unknown id is refused rather than throwing");
}

console.log("3. Clearing");
{
  const q = seeded(["done", "running", "failed", "queued", "cancelled"]);
  let changes = 0;
  q.onChange = () => changes++;

  const removed = q.clearFinished();
  check(removed === 3, "every finished row goes", `${removed}`);
  check(q.jobs.map((j) => j.status).sort().join(",") === "queued,running",
    "in-flight work survives — Clear is not Cancel",
    q.jobs.map((j) => j.status).join(","));
  check(changes === 1, "one redraw for the batch, not one per row");

  const again = q.clearFinished();
  check(again === 0 && changes === 1,
    "clearing an already-clear history changes nothing and says so");
}

console.log("4. It does not disturb the scheduler");
{
  const q = seeded(["done", "running"]);
  const before = q.running.length;
  q.clearFinished();
  check(q.running.length === before,
    "a running job is still running after a clear", `${q.running.length}`);
  // The cancel path is what stops work; removal must not have gone near it.
  check(typeof q.cancel === "function" && q.jobs.find((j) => j.id === "j1").status === "running",
    "and its status is untouched");
}

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
