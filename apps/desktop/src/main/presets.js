// Naming presets (CLAUDE.md §10 / §18b) — local only.
//
// A preset is a named set of user-defined fields plus the folder/file
// name patterns those fields feed. Stored as one JSON file under
// app.getPath("userData"), the same pattern recent-folders.json and
// display-names.json already use — no login, no server, no apps/api
// change. Server-side sync is a separately-scoped future addition per
// §10 and is deliberately absent here.
//
// Field shape:
//   { key, label, type: "text" | "choice", required: bool,
//     options: [{ label, token }], allowOther: bool }
//
// §65 REPLACED the old "select" (Suggesting) type with "choice", and that
// is a real capability removal, not a rename. Suggesting grew its own
// option list from whatever had been typed into it before, with zero
// authoring. Choice requires someone to write the list up front.
//
// The reason it went: a frequency-based suggestion actively misleads on a
// real shoot. The operator who drops the most cards — often just because
// their local storage is smallest — dominates the list regardless of who
// is actually dropping tonight, so the top suggestion is confidently
// wrong exactly when nobody is looking closely.
//
// A saved "select" field loads as plain Text. Not as a Choice with an
// empty option list: that would render an empty dropdown with no way to
// enter the value the field has been collecting for months, turning a
// working preset into a broken one. Text keeps every one of those presets
// usable, and loses only the autocomplete that is being removed anyway.

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");
const { normalizeFilters } = require("./filters");

function presetsFile() {
  return path.join(app.getPath("userData"), "naming-presets.json");
}

/** Field keys become `{token}`s, so they share the token charset. */
function normalizeKey(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * One Choice option: what the dropdown shows, and what lands in the name.
 *
 * They are separate because they read best differently — "Mathias" in a
 * dropdown, "MS" in a filename. Token falls back to the label rather than
 * being required, so the common case (they are the same) costs nothing.
 */
function normalizeOption(o) {
  const label = String(o?.label ?? "").trim();
  const token = String(o?.token ?? "").trim();
  return { label, token };
}

function normalizeField(f, i) {
  const label = String(f?.label ?? "").trim();
  const key = normalizeKey(f?.key || label) || `field_${i + 1}`;
  // "select" was Suggesting. It is gone; those fields become plain Text.
  const type = f?.type === "choice" ? "choice" : "text";
  const out = {
    key,
    label: label || key,
    type,
    required: Boolean(f?.required),
  };
  if (type === "choice") {
    // An option with no label at all cannot be picked or displayed, so it
    // is dropped rather than saved as a blank row someone has to find.
    out.options = (Array.isArray(f?.options) ? f.options : [])
      .map(normalizeOption)
      .filter((o) => o.label);
    out.allowOther = Boolean(f?.allowOther);
  }
  return out;
}

function normalizePreset(p) {
  const fields = Array.isArray(p?.fields) ? p.fields.map(normalizeField) : [];

  // Two fields sharing a key would make `{that_key}` ambiguous, and the
  // second would silently shadow the first at render time.
  const seen = new Set();
  for (const f of fields) {
    let k = f.key;
    let n = 2;
    while (seen.has(k)) k = `${f.key}_${n++}`;
    f.key = k;
    seen.add(k);
  }

  return {
    id: p?.id || crypto.randomUUID(),
    name: String(p?.name ?? "").trim() || "Untitled preset",
    folderTemplate: String(p?.folderTemplate ?? ""),
    fileTemplate: String(p?.fileTemplate ?? ""),
    fields,
    // Opt-in copy filtering (§23c). `null` — the value for every preset
    // that existed before this shipped, and for every new one until someone
    // configures it — means no filtering at all, which is the required
    // default: everything gets copied. normalizeFilters returns null for a
    // spec that asks for nothing, so a half-filled form can't quietly
    // become an active filter either.
    filters: normalizeFilters(p?.filters),
    // §77 — counter/end for anything missing, so nothing already saved
    // starts naming files differently the first time this ships.
    autoSuffix: normalizeAutoSuffix(p?.autoSuffix),
    updatedAt: p?.updatedAt || new Date().toISOString(),
  };
}

/**
 * The auto-suffix rule (§77) — what the safety net appends when a file
 * pattern numbers nothing, and where.
 *
 * `counter`/`end` is what every preset did before this existed, and is the
 * fallback on each axis independently: a preset saved before this shipped
 * has no `autoSuffix` at all, and a half-written one must not silently
 * change how existing files are named. Each axis falls back on its own, so
 * a valid `position` still applies even if `source` is garbage.
 */
function normalizeAutoSuffix(value) {
  const source = value?.source === "filename" ? "filename" : "counter";
  const position = value?.position === "front" ? "front" : "end";
  return { source, position };
}

/** The source counter (§22h) — a whole number, at least 1. */
function normalizeCounter(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function normalizeStore(raw) {
  return {
    presets: Array.isArray(raw?.presets) ? raw.presets.map(normalizePreset) : [],
    // Deliberately NOT per preset: it counts the cards offloaded, and
    // switching preset mid-shoot shouldn't restart the numbering. Lives here
    // rather than in its own file for the same reason recent-folders and
    // display-names each have one — this is preset-adjacent state, and a
    // fourth JSON file to hold a single integer is not worth the read.
    sourceCounter: normalizeCounter(raw?.sourceCounter),
    // §65 — `history` (the Suggesting type's typed-value memory) is
    // deliberately NOT carried forward. Dropping it here means the next
    // write of this file removes it from disk, rather than leaving dead
    // data that nothing reads.
  };
}

async function read() {
  try {
    return normalizeStore(JSON.parse(await fsp.readFile(presetsFile(), "utf8")));
  } catch {
    return { presets: [], sourceCounter: 1 };
  }
}

async function write(store) {
  try {
    await fsp.mkdir(path.dirname(presetsFile()), { recursive: true });
    await fsp.writeFile(presetsFile(), JSON.stringify(store, null, 2));
  } catch {
    // Losing a preset is bad; failing the copy someone is trying to start
    // because a preferences file wouldn't write is worse.
  }
  return store;
}

async function list() {
  return read();
}

/** Create or update. Returns the whole store so the renderer can re-render
 *  from one source rather than patching its own copy. */
async function save(preset) {
  const store = await read();
  const next = normalizePreset(preset);
  const i = store.presets.findIndex((p) => p.id === next.id);
  next.updatedAt = new Date().toISOString();
  if (i >= 0) store.presets[i] = next;
  else store.presets.push(next);
  return write(store);
}

async function remove(id) {
  const store = await read();
  store.presets = store.presets.filter((p) => p.id !== id);
  return write(store);
}

/**
 * The next source number, and the act of claiming it (§22h).
 *
 * Bumped when a source is ASSIGNED, not when a job runs: the number
 * identifies the card, so re-running or cancelling a job must not advance
 * it, and adding a second card must — even if the first was never copied.
 */
async function bumpSourceCounter() {
  const store = await read();
  const claimed = normalizeCounter(store.sourceCounter);
  store.sourceCounter = claimed + 1;
  await write(store);
  return claimed;
}

/** Set the counter directly, from the editable field in the presets window. */
async function setSourceCounter(value) {
  const store = await read();
  store.sourceCounter = normalizeCounter(value);
  await write(store);
  return store.sourceCounter;
}

module.exports = {
  list,
  bumpSourceCounter,
  setSourceCounter,
  normalizeCounter,
  save,
  remove,
  normalizeKey,
  normalizePreset,
  normalizeAutoSuffix,
  presetsFile,
};
