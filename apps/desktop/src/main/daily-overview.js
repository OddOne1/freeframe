// Daily job overview (CLAUDE.md §72) — local only.
//
// An aggregate of every copy that finished "today", ONE ROW PER CARD
// rather than per job: a card copied to two destinations is one card, and
// the Log (§71) is where per-job detail already lives. This answers a
// different question — "what came off the truck today" — and it has to
// survive a restart, which the Log's in-memory queue does not.
//
// Its own daily-overview.json under userData, following this app's own
// convention (naming-presets.json, recent-folders.json,
// display-names.json, settings.json each get a file). settings.js's own
// header documents why: these stores have different lifetimes, and a
// prune or reset of one must not take another with it.
//
// Deliberately electron-free except for the path, like presets.js — the
// day arithmetic is the part worth testing directly, and it is pure.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");

/** How many logical days are kept in the file. Export is the mechanism for
 *  anything long-term (§72), so this only has to be long enough that a
 *  boundary crossed overnight doesn't lose yesterday before someone looks. */
const RETAIN_DAYS = 30;

function overviewFile() {
  return path.join(app.getPath("userData"), "daily-overview.json");
}

/**
 * The LOGICAL day a moment belongs to, as "YYYY-MM-DD".
 *
 * A job finishing at 02:00 with a 05:00 boundary belongs to the PREVIOUS
 * calendar day: the night shift that started yesterday evening is one
 * day's work, and splitting it at midnight is exactly what the setting
 * exists to prevent. A 00:00 boundary shifts nothing, so the default is
 * plain calendar days.
 *
 * Local time throughout, matching naming.js's own reasoning for {date}:
 * someone offloading at 23:30 is having today, not tomorrow in UTC.
 */
function dayKeyFor(when, boundary = "00:00") {
  const d = new Date(when);
  const [h, m] = String(boundary || "00:00").split(":").map(Number);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const cutoff = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  // Shift the DATE, not the clock: constructing from y/m/d lets Date
  // normalise month and year rollovers, so 1 January at 02:00 with a 05:00
  // boundary correctly lands on 31 December.
  const shifted = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (minutes < cutoff ? 1 : 0));
  const p2 = (n) => String(n).padStart(2, "0");
  return `${shifted.getFullYear()}-${p2(shifted.getMonth() + 1)}-${p2(shifted.getDate())}`;
}

function normalizeCard(c) {
  return {
    // The merge key — the source this card was read from. Kept separate
    // from `label` for the reason spelled out on foldJob.
    key: String(c?.key ?? c?.label ?? "").trim() || "Unknown",
    label: String(c?.label ?? "").trim() || "Unknown",
    isNamedCard: Boolean(c?.isNamedCard),
    firstCompletedAt: Number(c?.firstCompletedAt) || 0,
    files: Number(c?.files) || 0,
    bytes: Number(c?.bytes) || 0,
    verifiedFiles: Number(c?.verifiedFiles) || 0,
    totalFileCopies: Number(c?.totalFileCopies) || 0,
    status: c?.status === "verified" || c?.status === "problems" ? c.status : "problems",
  };
}

function normalize(raw) {
  const days = Array.isArray(raw?.days) ? raw.days : [];
  return {
    days: days
      .filter((d) => d && typeof d.dayKey === "string")
      .map((d) => ({
        dayKey: d.dayKey,
        cards: (Array.isArray(d.cards) ? d.cards : []).map(normalizeCard),
      })),
  };
}

async function read() {
  try {
    return normalize(JSON.parse(await fsp.readFile(overviewFile(), "utf8")));
  } catch {
    // A missing or corrupt file means "nothing recorded yet", never an
    // error — this must not be able to fail a copy.
    return { days: [] };
  }
}

async function write(store) {
  try {
    await fsp.mkdir(path.dirname(overviewFile()), { recursive: true });
    await fsp.writeFile(overviewFile(), JSON.stringify(store, null, 2), "utf8");
  } catch {
    /* Losing the overview is bad; failing a finished copy over it is worse. */
  }
  return store;
}

/**
 * Fold one finished job into its card's row for the logical day.
 *
 * Pure, so the merge rule can be tested without a disk: given the store
 * and one job's facts, return the next store.
 *
 * MERGED BY SOURCE, LABELLED BY NUMBER — and the two have to be separate.
 * §72 says a card is "identified by its naming-card-number", but §71
 * claims a FRESH number for every renaming job, so the same physical card
 * copied twice carries two different numbers. Keying on the number would
 * therefore produce a row per job, which is exactly what §72's own
 * verification rules out ("two jobs for the SAME card → ONE row"). The
 * source path is the thing that is actually the same card across jobs, so
 * it is the key; the number is what the row shows.
 *
 * A plain copy still appears — it just has no number, so it shows the
 * folder name and says so.
 */
function foldJob(store, { key, label, isNamedCard, completedAt, files, bytes, verifiedFiles, totalFileCopies, verified }, boundary = "00:00") {
  const dayKey = dayKeyFor(completedAt, boundary);
  const next = normalize(store);
  let day = next.days.find((d) => d.dayKey === dayKey);
  if (!day) { day = { dayKey, cards: [] }; next.days.push(day); }

  const mergeKey = String(key ?? label ?? "").trim() || "Unknown";
  const existing = day.cards.find((c) => c.key === mergeKey);
  if (existing) {
    existing.files += Number(files) || 0;
    existing.bytes += Number(bytes) || 0;
    existing.verifiedFiles += Number(verifiedFiles) || 0;
    existing.totalFileCopies += Number(totalFileCopies) || 0;
    // Earliest wins: the row answers "when did this card start landing",
    // and a later copy to a second destination must not rewrite that.
    existing.firstCompletedAt = Math.min(existing.firstCompletedAt || completedAt, completedAt);
    // One bad leg makes the card's day not-clean. Downgrade only — a
    // later good copy does not clear an earlier failure.
    if (!verified) existing.status = "problems";
    // A card first seen on a plain copy and later offloaded with a naming
    // preset gains its number: a row that CAN name the card should.
    if (isNamedCard && !existing.isNamedCard) {
      existing.isNamedCard = true;
      existing.label = String(label ?? "").trim() || existing.label;
    }
  } else {
    day.cards.push(normalizeCard({
      key: mergeKey,
      label: String(label ?? "").trim() || mergeKey,
      isNamedCard,
      firstCompletedAt: completedAt,
      files, bytes, verifiedFiles, totalFileCopies,
      status: verified ? "verified" : "problems",
    }));
  }

  // Newest first, then trimmed — the panel only ever renders one day, and
  // the file should not grow without bound for a feature whose long-term
  // answer is the CSV export.
  next.days.sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
  next.days = next.days.slice(0, RETAIN_DAYS);
  return next;
}

async function recordJob(facts, boundary) {
  return write(foldJob(await read(), facts, boundary));
}

/** One logical day's entry, or an empty one. */
async function forDay(dayKey) {
  const store = await read();
  return store.days.find((d) => d.dayKey === dayKey) || { dayKey, cards: [] };
}

/** Clear ONE day, leaving every other day's entry alone (§72). */
async function resetDay(dayKey) {
  const store = await read();
  store.days = store.days.filter((d) => d.dayKey !== dayKey);
  await write(store);
  return { dayKey, cards: [] };
}

/** CSV for one day: one row per card, in the order the panel shows them. */
function toCsv(day) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Day", "Card", "Named card", "Source", "First completed", "Files", "Bytes", "Verified files", "Total file copies", "Status"]];
  for (const c of day.cards) {
    rows.push([
      day.dayKey, c.label, c.isNamedCard ? "yes" : "no", c.key,
      c.firstCompletedAt ? new Date(c.firstCompletedAt).toISOString() : "",
      c.files, c.bytes, c.verifiedFiles, c.totalFileCopies, c.status,
    ]);
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

module.exports = {
  dayKeyFor, foldJob, normalize, toCsv,
  read, recordJob, forDay, resetDay, overviewFile, RETAIN_DAYS,
};
