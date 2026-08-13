// Naming presets (CLAUDE.md §10 / §18b) — local only.
//
// A preset is a named set of user-defined fields plus the folder/file
// name patterns those fields feed. Stored as one JSON file under
// app.getPath("userData"), the same pattern recent-folders.json and
// display-names.json already use — no login, no server, no apps/api
// change. Server-side sync is a separately-scoped future addition per
// §10 and is deliberately absent here.
//
// Field shape (flagged in §10 as a judgment call, not a user decision):
//   { key, label, type: "text" | "select", required: bool }
// A "select" field has no fixed option list. It grows its own suggestions
// from what has actually been typed into it before, kept in `history`
// below — the alternative, making the user declare every option up front,
// is exactly the fixed-enum rigidity this feature exists to avoid.

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");

const MAX_SUGGESTIONS = 20;

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

function normalizeField(f, i) {
  const label = String(f?.label ?? "").trim();
  const key = normalizeKey(f?.key || label) || `field_${i + 1}`;
  return {
    key,
    label: label || key,
    type: f?.type === "select" ? "select" : "text",
    required: Boolean(f?.required),
  };
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
    updatedAt: p?.updatedAt || new Date().toISOString(),
  };
}

function normalizeStore(raw) {
  return {
    presets: Array.isArray(raw?.presets) ? raw.presets.map(normalizePreset) : [],
    // { [fieldKey]: string[] } — most recent first. Shared across presets
    // on purpose: an "operator" field means the same thing whichever
    // preset declares it, so the names you've typed should follow.
    history: raw && typeof raw.history === "object" && raw.history ? raw.history : {},
  };
}

async function read() {
  try {
    return normalizeStore(JSON.parse(await fsp.readFile(presetsFile(), "utf8")));
  } catch {
    return { presets: [], history: {} };
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
  // History is intentionally kept: deleting a preset shouldn't forget
  // every operator name ever typed, and another preset may use the field.
  return write(store);
}

/**
 * Record the values used for a job, so "select" fields can suggest them
 * next time. Called when a copy actually starts — not on every keystroke,
 * which would fill the list with half-typed names.
 */
async function recordValues(values) {
  const store = await read();
  for (const [key, value] of Object.entries(values || {})) {
    const v = String(value ?? "").trim();
    if (!v) continue;
    const prev = Array.isArray(store.history[key]) ? store.history[key] : [];
    store.history[key] = [v, ...prev.filter((x) => x !== v)].slice(0, MAX_SUGGESTIONS);
  }
  return write(store);
}

module.exports = {
  list,
  save,
  remove,
  recordValues,
  normalizeKey,
  normalizePreset,
  presetsFile,
};
