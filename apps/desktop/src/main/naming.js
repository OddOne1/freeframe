// Folder/file naming templates for copy jobs (CLAUDE.md §10 / §18b).
//
// **This mechanism did not previously exist.** The roadmap describes
// `{counter}`, `{cardname}`, `{cameraman}` and `{camera}` as template
// variables "already noted in §1", but §1 listed them as ingesto concepts
// worth reimplementing — nothing in this app ever rendered a template, and
// main.js:591 says as much. Destination paths were `path.join(destRoot,
// rel)` and nothing else. So this is the mechanism, not an extension of
// one.
//
// Deliberately pure: no fs, no electron, no preset storage. Everything
// here is a string transformation, which is what makes the awkward parts
// (collisions, traversal, extensions, unfilled tokens) testable without a
// disk or a window.

const path = require("node:path");

/** `{token}` — letters, digits, underscore. Matches the custom-field key
 *  rule in presets.js, so any field a user defines is addressable. */
const TOKEN = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Characters that cannot appear in a path segment.
 *
 * Superset of what any one platform forbids, on purpose: a card offloaded
 * on a Mac often ends up on an exFAT drive that later gets read on
 * Windows, and a name that works today shouldn't become unreadable when
 * the drive moves. Also strips control characters, which some filesystems
 * accept and no tool displays sanely.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;

/** Windows refuses these as base names regardless of extension. */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** One path segment, made safe without becoming unrecognisable. */
function sanitizeSegment(value) {
  let out = String(value ?? "").replace(ILLEGAL, "_").trim();
  // Trailing dots and spaces are silently dropped by Windows, which turns
  // "Day 1." and "Day 1" into the same directory without telling anyone.
  out = out.replace(/[. ]+$/g, "");
  if (RESERVED.has(out.toLowerCase())) out = `_${out}`;
  return out;
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

/**
 * Built-in tokens, available whether or not a preset defines anything.
 *
 * `date`/`time` use LOCAL time, not UTC: someone offloading at 23:30 has
 * folders dated today in their own timezone, and a UTC rollover mid-shoot
 * would split one night's work across two dated folders.
 */
function builtinValues({ now = new Date(), sourceLabel = "", rel = "", index = 1, sourceCounter = 1 } = {}) {
  const two = (n) => pad(n, 2);
  const base = path.basename(rel);
  const ext = path.extname(base);
  return {
    date: `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`,
    // §65 — date and time components are now a CASE-SENSITIVE pair set:
    // uppercase is the date half, lowercase is the time half. Lookup was
    // already case-sensitive (a plain object property match); what did not
    // exist was any uppercase key to look up.
    //
    // BREAKING, deliberately, and checked before doing it: lowercase `mm`
    // meant MONTH and now means MINUTES. `{MM}` is month. No saved preset
    // on this machine referenced `{mm}` (verified against the real store),
    // so nothing changed meaning in practice — but a pattern written
    // elsewhere and imported would.
    YY: String(now.getFullYear()).slice(2),
    YYYY: String(now.getFullYear()),
    MM: two(now.getMonth() + 1),
    DD: two(now.getDate()),
    hh: two(now.getHours()),
    mm: two(now.getMinutes()),
    // Kept resolvable although their chips are gone (§65.6): a saved
    // pattern that already uses one must keep rendering rather than
    // writing a folder literally named "{date}".
    yy: String(now.getFullYear()).slice(2),
    yyyy: String(now.getFullYear()),
    dd: two(now.getDate()),
    time: `${two(now.getHours())}${two(now.getMinutes())}`,
    datetime: `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}`,
    // The source's own name — a card called "A001" keeps that identity in
    // the destination, which is the single most useful thing on a shoot.
    cardname: sanitizeSegment(path.basename(sourceLabel || "")),
    name: base.slice(0, base.length - ext.length),
    ext: ext.replace(/^\./, ""),
    // Numbers files WITHIN one source. Putting it in a folder pattern is
    // what creates a folder per file, which is why the editor only offers
    // it as a chip on the file-name field (§22c).
    counter: pad(index, 4),
    // Numbers the SOURCES themselves (§22h): card 1 → 001, card 2 → 002.
    // A separate token rather than reusing {counter}, so no existing preset
    // silently changes meaning. Its value is supplied by the caller and
    // persisted in userData — it is the one built-in that outlives a job.
    sourcecounter: pad(sourceCounter, 3),
  };
}

/**
 * Extensions that pair with a media file *by filename convention* (§23d).
 *
 * These carry no internal reference to the clip — the only thing tying
 * `C0001.XML` to `C0001.MP4` is that they share a stem. So when the clip is
 * renamed, the sidecar has to be renamed with it or the pairing every
 * downstream tool relies on silently breaks.
 *
 * GoPro's `.LRV` is in here even though it is a real video: on a GoPro card
 * it is the proxy *for* `GOPRxxxx.MP4` and is matched to it by name alone.
 */
const SIDECAR_PAIR_EXTENSIONS = new Set([
  ".xml",   // Sony BPAV/CLPR, Panasonic P2, Canon
  ".bim",   // Sony
  ".ppn",   // Sony
  ".smi",   // Sony
  ".bin",   // Panasonic
  ".cif",   // Canon
  ".thm",   // GoPro thumbnail
  ".lrv",   // GoPro proxy
  ".srt",   // DJI flight telemetry
  ".xmp",   // generic
]);

/**
 * Extensions whose clip name is referenced from inside the file itself, or
 * from a card-level index, and which therefore must not be renamed by
 * default (§23d).
 *
 * This matches what Silverstack documents doing — it restricts renaming to
 * `.mp4`/`.mov` and says why: "To prevent accidental renaming of clips from
 * cameras with dedicated naming schemes." Independent research agrees for
 * `.r3d` in particular, where the clip name is written inside the R3D and
 * renaming "will end up with unpredictable results".
 *
 * FreeFrame blocks a named list rather than allow-listing `.mp4`/`.mov`,
 * because this app also handles formats Silverstack's rule would refuse for
 * no reason (`.dng`, `.exr`, `.wav`), and blanket-refusing those would be
 * more annoying than the problem being prevented.
 */
const RENAME_FRAGILE_EXTENSIONS = new Map([
  [".r3d", "RED R3D — the clip name is stored inside the file"],
  [".ari", "ARRIRAW — reel/clip naming is used for conform linking"],
  [".arx", "ARRIRAW — reel/clip naming is used for conform linking"],
  [".mxf", "Professional MXF (ARRIRAW, Sony XDCAM, Canon XF-AVC) — referenced by a card-level index"],
]);

/**
 * Which rename-fragile formats a file list contains.
 *
 * Pure and separate from the copy so the check can run before a single byte
 * moves, and so it can be tested without a disk.
 *
 * @returns {Array<{ext: string, reason: string, count: number}>}
 */
function fragileRenameExtensions(relFiles) {
  const counts = new Map();
  for (const rel of relFiles || []) {
    const ext = path.extname(String(rel)).toLowerCase();
    if (!RENAME_FRAGILE_EXTENSIONS.has(ext)) continue;
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => ({ ext, count, reason: RENAME_FRAGILE_EXTENSIONS.get(ext) }));
}

/**
 * Remove specific tokens from a template, along with one adjacent
 * separator (§22g).
 *
 * This is what the field panel's per-transfer disable toggle does. The
 * obvious alternative — substituting an empty string — leaves the
 * separator behind, so disabling `operator` in `{date}_{operator}` yields a
 * folder called `20260816_`. Nobody wants that name, and nobody would
 * notice it until the card was already back in the camera.
 *
 * `/` is deliberately NOT treated as a strippable separator: it nests
 * folders, and renderTemplate already drops segments that end up empty.
 */
function omitTokens(template, keys) {
  let out = String(template ?? "");
  for (const key of keys || []) {
    const safe = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = `\\{${safe}\\}`;
    // Trailing separator first, so `{a}_{b}` with `a` disabled leaves `{b}`
    // rather than `_{b}`; then a leading one, for a token at the end.
    out = out.replace(new RegExp(`${token}[_\\-. ]`, "g"), "");
    out = out.replace(new RegExp(`[_\\-. ]${token}`, "g"), "");
    out = out.replace(new RegExp(token, "g"), "");
  }
  return out;
}

/** Every token a template references, in order of first appearance. */
function tokensIn(template) {
  const found = [];
  for (const m of String(template ?? "").matchAll(TOKEN)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * Which of a template's tokens nothing can fill.
 *
 * Checked BEFORE a job starts. The alternative — rendering anyway — writes
 * a folder literally named `{operator}` onto someone's drive and only
 * looks wrong hours later, by which point the card may already be back in
 * the camera.
 */
function unknownTokens(template, valueKeys) {
  const known = new Set([...valueKeys, ...Object.keys(builtinValues())]);
  return tokensIn(template).filter((t) => !known.has(t));
}

/**
 * Why a folder pattern must be refused, or null if it is fine (§65c).
 *
 * `{counter}` numbers files WITHIN a copy. Put it in a folder pattern and
 * every file renders a different folder name, so a card arrives as a
 * hundred folders holding one file each. That has always been what the
 * code does — it is not new behaviour being guarded, it is an edge case
 * that was only ever unreachable through the chip UI, which never offers
 * `{counter}` on the folder field (§22c). Hand-typing it worked.
 *
 * `{sourcecounter}` is deliberately untouched: it numbers CARDS, not
 * files, so one folder per card is exactly what it is for and
 * `Card_{sourcecounter}` must keep working unchanged. The two are
 * separate tokens precisely so this distinction can be enforced.
 *
 * Returns a message rather than throwing, so both callers — the editor
 * saving a preset and the engine starting a job — can present it their
 * own way from one wording.
 */
const FOLDER_ONLY_REFUSALS = {
  counter:
    "{counter} numbers files within a copy, not folders — using it in a folder pattern "
    + "creates one folder per file. Use {sourcecounter} to number by card instead.",
};

/**
 * §71 — does this job actually rename anything?
 *
 * One definition, two callers: `copy:start` uses it for the §23d
 * fragile-rename guard, and the renderer asks over IPC before deciding
 * whether to consume a {sourcecounter} value. A second copy of this rule
 * would let a job rename without advancing the counter, or advance it
 * without renaming — both silent.
 *
 * Reads the STRIPPED template on purpose: disabling every field a file
 * pattern used leaves nothing to rename by (§22g).
 */
function rendersNewFileNames(fileTemplate, disabled = []) {
  return Boolean(String(omitTokens(fileTemplate, disabled) || "").trim());
}

function folderPatternError(template) {
  for (const t of tokensIn(template)) {
    if (Object.prototype.hasOwnProperty.call(FOLDER_ONLY_REFUSALS, t)) {
      return FOLDER_ONLY_REFUSALS[t];
    }
  }
  return null;
}

/**
 * Render a template into a relative path.
 *
 * `/` in the template is honoured as a separator, so
 * `{date}_{operator}/{cardname}` produces nested folders — that is the
 * point, not an accident. Each segment is sanitized individually so a
 * value containing a slash can't smuggle in a directory level, and `..`
 * segments are dropped outright: a template is user input, and the one
 * thing it must never do is write outside the destination root.
 */
function renderTemplate(template, values, ctx = {}) {
  const all = { ...builtinValues(ctx), ...values };

  // Split the TEMPLATE first, then substitute inside each segment. Order
  // matters and this is not cosmetic: substituting first lets a value
  // containing "/" introduce a directory level the user never asked for —
  // someone typing "a/b" into an Operator field would silently restructure
  // the destination, and "../.." would climb out of the intended folder.
  // Sanitising each value as it lands means a template's own slashes nest
  // (which is the feature) while a value's never can.
  return String(template ?? "")
    .split("/")
    .map((seg) =>
      seg.replace(TOKEN, (whole, key) =>
        Object.prototype.hasOwnProperty.call(all, key) ? sanitizeSegment(all[key]) : whole,
      ),
    )
    .map((seg) => sanitizeSegment(seg))
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

/**
 * Build the rel → destination-relative-path mapper for one job.
 *
 * Returns null when there's nothing to apply, so the caller keeps its
 * existing `path.join(destRoot, rel)` behaviour untouched rather than
 * routing every legacy copy through a no-op transform.
 *
 * folderTemplate — a subfolder inserted under each destination root.
 * fileTemplate   — renames each file. Empty keeps the original name.
 *
 * The source's own directory structure is preserved beneath the folder
 * template. Flattening a card's DCIM tree into one directory would be a
 * different feature, and a lossy one.
 */
function buildRelMapper({ folderTemplate = "", fileTemplate = "", values = {}, sourceLabel = "", now = new Date(), flatten = false, sourceCounter = 1 } = {}) {
  const folder = String(folderTemplate || "").trim();
  const file = String(fileTemplate || "").trim();
  // `flatten` alone is reason enough to build a mapper: it changes where
  // files land even with no template at all.
  if (!folder && !file && !flatten) return null;

  let index = 0;
  const seen = new Map();

  /**
   * §65.5 — the "forgot {counter}" safety net.
   *
   * A file pattern that numbers nothing renders every file in a directory
   * to one name. That used to be a hard refusal (see NAMING_COLLISION
   * below); it is now an automatic `_0001` suffix, because the refusal
   * arrived at the worst possible moment — the user has already chosen a
   * card, a destination and pressed Start — to report something the
   * pattern editor could have said.
   *
   * FILE PATTERN ONLY. A folder pattern containing {counter} deliberately
   * creates a folder per file, and auto-adding one there would invent that
   * behaviour for someone who never asked for it.
   */
  const autoCounter = Boolean(file)
    && !tokensIn(file).some((t) => t === "counter" || t === "sourcecounter");

  // rel -> the rel whose rendered basename this file must adopt. Populated
  // only by prepare(); empty means every file is named independently, which
  // is exactly the pre-§23d behaviour.
  const followsMedia = new Map();
  // rel -> the {counter} value it renders with. Also prepare()-only.
  const indexFor = new Map();
  const renderedBase = new Map();

  /**
   * Give the mapper the whole file list before mapping starts (§23d).
   *
   * Two things need the list up front and cannot be derived one file at a
   * time. First, sidecar pairing: `C0001.XML` can only follow `C0001.MP4`
   * if the mapper knows the MP4 exists. Second, the counter: a sidecar must
   * not consume a `{counter}` value, or the clip after it renders one
   * number higher than the shot list says.
   *
   * Optional by design — a caller that never calls this gets the original
   * per-file behaviour untouched.
   */
  function prepare(relFiles) {
    followsMedia.clear();
    indexFor.clear();
    renderedBase.clear();
    if (!file) return; // Nothing is being renamed, so nothing needs pairing.

    // Group by directory + stem. Pairing is scoped to one directory on
    // purpose: two unrelated cards can both hold a C0001, and matching
    // across directories would attach a sidecar to the wrong clip.
    const groups = new Map();
    for (const rel of relFiles) {
      const dir = path.dirname(rel);
      const base = path.basename(rel);
      const ext = path.extname(base).toLowerCase();
      const stem = base.slice(0, base.length - ext.length).toLowerCase();
      // A NUL separator, written as an escape so the byte is deliberate
      // and visible in a diff: it is the one character that cannot occur
      // in a path, so no directory or stem can forge a different pair's key.
      const key = `${dir}\u0000${stem}`;
      if (!groups.has(key)) groups.set(key, { media: [], sidecars: [] });
      const group = groups.get(key);
      (SIDECAR_PAIR_EXTENSIONS.has(ext) ? group.sidecars : group.media).push(rel);
    }

    for (const { media, sidecars } of groups.values()) {
      if (!media.length || !sidecars.length) continue;
      // More than one media file sharing a stem (C0001.mov + C0001.mp4) is
      // pathological, and a sidecar can only follow one of them. The first
      // in sorted order is chosen so the outcome is at least deterministic
      // and one of the pairings survives.
      const target = [...media].sort()[0];
      for (const sidecar of sidecars) followsMedia.set(sidecar, target);
    }

    // Only files that are named in their own right consume a counter.
    let n = 0;
    for (const rel of relFiles) {
      if (followsMedia.has(rel)) continue;
      n += 1;
      indexFor.set(rel, n);
    }
  }

  function renderBaseFor(rel) {
    if (renderedBase.has(rel)) return renderedBase.get(rel);
    index += 1;
    const ctx = { now, sourceLabel, rel, index: indexFor.get(rel) ?? index, sourceCounter };
    let out = renderTemplate(file, values, ctx);
    // Appended after rendering, not spliced into the template: the template
    // is what the user wrote, and a suffix on the rendered name is the
    // smallest thing that makes it unique. An empty render is left alone —
    // mapRel falls back to the original basename in that case.
    if (autoCounter && out) out += `_${pad(ctx.index, 4)}`;
    renderedBase.set(rel, out);
    return out;
  }

  function mapRel(rel) {
    // A paired sidecar is named — and *placed* — exactly as its media file
    // is. Using the clip's rel for the whole context, not just the file
    // name, is what stops a folder template containing {counter} from
    // filing `C0001.XML` into a different folder than `C0001.MP4` and
    // breaking the very pairing this is meant to preserve.
    const nameSource = followsMedia.get(rel) ?? rel;
    const ctx = { now, sourceLabel, rel: nameSource, index: indexFor.get(nameSource) ?? index + 1, sourceCounter };

    const prefix = folder ? renderTemplate(folder, values, ctx) : "";
    const dir = path.dirname(rel);
    // Flatten discards the source's own directory structure, dropping every
    // file directly under the folder template. Off by default: preserving
    // the tree is the correct thing for a card offload, and losing it is
    // only ever an explicit request.
    const keepDir = !flatten && dir && dir !== "." ? dir : "";

    let base = path.basename(rel);
    if (file) {
      const ext = path.extname(base);
      // A sidecar adopts its media file's rendered name and keeps its own
      // extension, so `C0001.MP4` + `C0001.XML` stay a pair on the far side
      // of the rename. Rendering it independently would give it a different
      // {counter} and break exactly what this is here to preserve.
      const renamed = renderBaseFor(nameSource);
      // The extension always comes from the source. A template that drops
      // it would produce files no tool will open, and "the name is wrong"
      // is a far cheaper mistake than "nothing recognises this file".
      base = renamed ? `${renamed}${ext}` : base;
    } else if (!followsMedia.size) {
      // Keeps the per-file counter advancing for folder-only templates,
      // matching the original behaviour.
      index += 1;
    }

    const out = [prefix, keepDir, base].filter(Boolean).join("/");

    // Two source files can render to one destination path. §65.5 made the
    // common cause — a filename template with no {counter} — impossible by
    // auto-appending one, so this is now a BACKSTOP rather than the primary
    // UX: flatten collapsing two directories that each hold a C0001 still
    // reaches it, as would a template of pure literal text. Kept because
    // silently overwriting loses footage.
    if (seen.has(out)) {
      const err = new Error(
        `Naming template maps two files to the same destination: "${seen.get(out)}" and "${rel}" both become "${out}". ` +
        (flatten
          ? `Turn off folder flattening, or add {counter} to the file name pattern.`
          : `Add {counter} to the file name pattern, or leave it empty to keep the original names.`),
      );
      err.code = "NAMING_COLLISION";
      throw err;
    }
    seen.set(out, rel);
    return out;
  }

  mapRel.prepare = prepare;
  // Surfaced so a preview can say the suffix was added rather than leaving
  // the user to notice it on the drive afterwards (§65.9).
  mapRel.autoCounter = autoCounter;
  return mapRel;
}

module.exports = {
  buildRelMapper,
  renderTemplate,
  sanitizeSegment,
  tokensIn,
  unknownTokens,
  folderPatternError,
  rendersNewFileNames,
  builtinValues,
  fragileRenameExtensions,
  omitTokens,
  SIDECAR_PAIR_EXTENSIONS,
  RENAME_FRAGILE_EXTENSIONS,
};
