#!/usr/bin/env node
// Daily overview (CLAUDE.md §72) — the parts that are pure.
//
// The day arithmetic and the merge rule are where this feature is either
// right or quietly wrong, and both are separable from disk and from
// Electron, so they are driven directly rather than through the app.
//
// Run: node scripts/test-daily-overview.js
const path = require("node:path");
const Module = require("node:module");

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

// A fake electron, so the module loads outside a running app.
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "electron") return "electron-stub";
  return realResolve.call(this, req, ...rest);
};
require.cache["electron-stub"] = {
  id: "electron-stub", filename: "electron-stub", loaded: true,
  exports: { app: { getPath: () => "/tmp/ff-daily-test" } },
};

const dov = require(path.join(__dirname, "..", "src", "main", "daily-overview.js"));
const { normalizeDayBoundary } = require(path.join(__dirname, "..", "src", "main", "settings.js"));

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

console.log("1. The logical day");
check(dov.dayKeyFor(at(2026, 8, 27, 14, 0), "00:00") === "2026-08-27",
  "midnight boundary is a plain calendar day");
check(dov.dayKeyFor(at(2026, 8, 27, 2, 0), "00:00") === "2026-08-27",
  "…including the small hours");
// The whole point of the setting: a night shift that runs past midnight
// is one day's work, not two.
check(dov.dayKeyFor(at(2026, 8, 27, 2, 0), "05:00") === "2026-08-26",
  "before the boundary belongs to the PREVIOUS day", dov.dayKeyFor(at(2026, 8, 27, 2, 0), "05:00"));
check(dov.dayKeyFor(at(2026, 8, 27, 5, 0), "05:00") === "2026-08-27",
  "the boundary minute itself starts the new day");
check(dov.dayKeyFor(at(2026, 8, 27, 4, 59), "05:00") === "2026-08-26",
  "one minute earlier does not");
// Date arithmetic, not string arithmetic — subtracting a day across a
// month or year edge is where a hand-rolled version goes wrong.
check(dov.dayKeyFor(at(2026, 9, 1, 2, 0), "05:00") === "2026-08-31",
  "rolls back over a month edge", dov.dayKeyFor(at(2026, 9, 1, 2, 0), "05:00"));
check(dov.dayKeyFor(at(2027, 1, 1, 2, 0), "05:00") === "2026-12-31",
  "and over a year edge", dov.dayKeyFor(at(2027, 1, 1, 2, 0), "05:00"));
check(dov.dayKeyFor(at(2026, 3, 2, 2, 0), "05:00") === "2026-03-01",
  "and over a leap-adjacent edge");

console.log("\n2. The boundary setting normalises");
check(normalizeDayBoundary("05:00") === "05:00", "a valid time survives");
check(normalizeDayBoundary("5:00") === "05:00", "and is zero-padded");
for (const bad of ["", null, undefined, "24:00", "12:60", "noon", "5"]) {
  check(normalizeDayBoundary(bad) === "00:00",
    `${JSON.stringify(bad)} falls back to midnight rather than shifting every job`);
}

console.log("\n3. One row per card, merged across jobs");
const job = (over) => ({
  key: "/Volumes/A001", label: "42", isNamedCard: true,
  completedAt: at(2026, 8, 27, 10, 0), files: 10, bytes: 1000,
  verifiedFiles: 10, totalFileCopies: 10, verified: true, ...over,
});
{
  let s = { days: [] };
  s = dov.foldJob(s, job());
  s = dov.foldJob(s, job({ completedAt: at(2026, 8, 27, 11, 0), label: "43" }));
  const cards = s.days[0].cards;
  // THE point of the section. §71 claims a fresh number per job, so the
  // second copy of the same card carries a different one — keying on the
  // number would give a row per job, which is what §72 rules out.
  check(cards.length === 1, "two jobs for the same card make ONE row", `${cards.length} rows`);
  check(cards[0].files === 20 && cards[0].bytes === 2000,
    "with the counts added", JSON.stringify({ f: cards[0].files, b: cards[0].bytes }));
  check(cards[0].verifiedFiles === 20 && cards[0].totalFileCopies === 20, "and the verified counts");
  check(cards[0].firstCompletedAt === at(2026, 8, 27, 10, 0),
    "keeping the EARLIEST completion — the row says when the card started landing");
  check(cards[0].label === "42",
    "and the first job's number, not the second's", cards[0].label);
}
{
  // A different card is a different row, even at the same moment.
  let s = dov.foldJob({ days: [] }, job());
  s = dov.foldJob(s, job({ key: "/Volumes/B002", label: "43" }));
  check(s.days[0].cards.length === 2, "a different source is a different row");
}
{
  // A plain copy still appears, named by its folder and marked as such.
  let s = dov.foldJob({ days: [] }, job({ key: "/Volumes/C003", label: "C003", isNamedCard: false }));
  const c = s.days[0].cards[0];
  check(c.isNamedCard === false && c.label === "C003",
    "a plain copy appears, labelled by folder", JSON.stringify({ l: c.label, n: c.isNamedCard }));
}
{
  // …and gains a number if the same card is later offloaded with a preset.
  let s = dov.foldJob({ days: [] }, job({ label: "A001", isNamedCard: false }));
  s = dov.foldJob(s, job({ completedAt: at(2026, 8, 27, 12, 0) }));
  const c = s.days[0].cards[0];
  check(s.days[0].cards.length === 1 && c.isNamedCard && c.label === "42",
    "a card first seen unnamed gains its number later", JSON.stringify({ l: c.label, n: c.isNamedCard }));
}
{
  // One bad leg makes the card's day not clean, and a later good copy
  // must not paper over it.
  let s = dov.foldJob({ days: [] }, job({ verified: false, verifiedFiles: 8 }));
  check(s.days[0].cards[0].status === "problems", "an unverified job marks the row");
  s = dov.foldJob(s, job({ completedAt: at(2026, 8, 27, 12, 0) }));
  check(s.days[0].cards[0].status === "problems",
    "and a later clean copy does NOT clear it", s.days[0].cards[0].status);
}
{
  // Two logical days are two entries.
  let s = dov.foldJob({ days: [] }, job());
  s = dov.foldJob(s, job({ completedAt: at(2026, 8, 28, 10, 0) }));
  check(s.days.length === 2, "a job on another day starts another entry");
  check(s.days[0].dayKey === "2026-08-28", "newest first", s.days[0].dayKey);
}
{
  // The file must not grow without bound — export is the long-term answer.
  let s = { days: [] };
  for (let i = 1; i <= dov.RETAIN_DAYS + 10; i++) {
    s = dov.foldJob(s, job({ completedAt: at(2026, 1, 1, 10, 0) + i * 86400000 }));
  }
  check(s.days.length === dov.RETAIN_DAYS, "older days are pruned", `${s.days.length}`);
}

console.log("\n4. Reset clears ONE day, on disk");
{
  // The real read/write/resetDay round trip against the stubbed userData
  // path. Worth doing for real rather than testing the filter in isolation:
  // "reset today" wiping the file is the mistake that would look identical
  // in any test that only ever has one day in it.
  const fs = require("node:fs");
  const dir = "/tmp/ff-daily-test";
  fs.mkdirSync(dir, { recursive: true });
  const file = dov.overviewFile();
  fs.writeFileSync(file, JSON.stringify({ days: [
    { dayKey: "2026-08-27", cards: [{ key: "/A", label: "1", isNamedCard: true,
      firstCompletedAt: 1, files: 1, bytes: 1, verifiedFiles: 1, totalFileCopies: 1, status: "verified" }] },
    { dayKey: "2026-08-26", cards: [{ key: "/B", label: "2", isNamedCard: true,
      firstCompletedAt: 1, files: 2, bytes: 2, verifiedFiles: 2, totalFileCopies: 2, status: "verified" }] },
  ] }), "utf8");

  (async () => {
    const cleared = await dov.resetDay("2026-08-27");
    check(cleared.cards.length === 0, "the reset day comes back empty");
    const store = await dov.read();
    check(!store.days.some((d) => d.dayKey === "2026-08-27"), "today's entry is gone");
    const other = store.days.find((d) => d.dayKey === "2026-08-26");
    check(Boolean(other) && other.cards.length === 1,
      "and YESTERDAY's entry is untouched — reset clears a day, not the file",
      JSON.stringify(store.days.map((d) => d.dayKey)));
    fs.rmSync(file, { force: true });

    console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}

console.log("\n4b. CSV");
{
  const day = dov.foldJob({ days: [] }, job({ label: 'Card "A", 1' })).days[0];
  const csv = dov.toCsv(day);
  const lines = csv.trim().split("\n");
  check(lines.length === 2, "a header and one row per card", `${lines.length} lines`);
  check(lines[0].startsWith("Day,Card,Named card,Source,"), "with a header row", lines[0]);
  // A card label with a comma and a quote in it must not break the file.
  check(lines[1].includes('"Card ""A"", 1"'),
    "quoting a label containing a comma and a quote", lines[1]);
  check(lines[1].includes(",10,1000,10,10,verified"), "and the totals", lines[1]);
}

