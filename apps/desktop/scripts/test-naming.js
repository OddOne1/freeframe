#!/usr/bin/env node
// Naming templates (CLAUDE.md §10 / §18b) — pure, so tested directly.
//
// The interesting cases are all the ones that quietly produce a wrong
// folder on someone's drive rather than an error: an unfilled token
// rendered literally, a value containing a slash creating a directory
// level nobody asked for, two files mapping onto one name, an extension
// dropped by a rename.
//
// Run: node scripts/test-naming.js
const assert = require("node:assert");
const path = require("node:path");
const {
  buildRelMapper, renderTemplate, sanitizeSegment, tokensIn, unknownTokens, builtinValues, omitTokens,
  folderPatternError,
  rendersNewFileNames,
} = require(path.join(__dirname, "..", "src", "main", "naming.js"));

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}
/**
 * Map one rel, reporting a refusal as a value instead of letting it
 * propagate. NAMING_COLLISION is exactly what several of these assertions
 * are pinning the ABSENCE of, and an uncaught throw kills this file — every
 * assertion after it silently never runs. A regression has to read as one
 * failed check, not as a stack trace plus silence.
 */
function mapOr(map, rel) {
  try { return map(rel); } catch (e) { return `THREW ${e.code || e.message}`; }
}
function eq(actual, expected, label) {
  check(actual === expected, label, actual === expected ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const NOW = new Date(2026, 7, 13, 21, 5); // 2026-08-13 21:05 local

console.log("1. Tokens");
eq(tokensIn("{date}_{operator}/{cardname}").join(","), "date,operator,cardname", "found in order, deduped");
eq(tokensIn("no tokens here").length, 0, "none is fine");
eq(unknownTokens("{date}_{operator}", ["operator"]).length, 0, "known field + builtin both resolve");
eq(unknownTokens("{date}_{nope}", ["operator"]).join(","), "nope", "unknown token reported");

console.log("\n2. Segment sanitisation");
eq(sanitizeSegment("B-Cam Day 1"), "B-Cam Day 1", "spaces and hyphens survive");
eq(sanitizeSegment('a:b"c|d?e*f'), "a_b_c_d_e_f", "illegal characters replaced");
eq(sanitizeSegment("Day 1."), "Day 1", "trailing dot dropped (Windows drops it silently)");
eq(sanitizeSegment("CON"), "_CON", "Windows reserved name escaped");
eq(sanitizeSegment("  padded  "), "padded", "trimmed");

console.log("\n3. Rendering");
eq(
  renderTemplate("{date}_{operator}", { operator: "Mathias" }, { now: NOW }),
  "20260813_Mathias",
  "builtin + custom field",
);
eq(renderTemplate("{YY}{MM}{DD}", {}, { now: NOW }), "260813", "date parts");
eq(renderTemplate("{time}", {}, { now: NOW }), "2105", "local time, not UTC");

// §65.7 — {MM} and {mm} differ ONLY by case and must resolve differently.
// This is the whole point of the change and the one thing that would look
// fine while being silently wrong.
eq(renderTemplate("{YYYY}_{MM}_{DD}_{hh}{mm}", {}, { now: NOW }), "2026_08_13_2105",
   "case-sensitive pairs: uppercase is the date half, lowercase the time half");
check(renderTemplate("{MM}", {}, { now: NOW }) !== renderTemplate("{mm}", {}, { now: NOW }),
      "{MM} (month) and {mm} (minutes) are different tokens, not one case-insensitive one",
      `${renderTemplate("{MM}", {}, { now: NOW })} vs ${renderTemplate("{mm}", {}, { now: NOW })}`);
eq(renderTemplate("{hh}", {}, { now: NOW }), "21", "{hh} is the hour, 24-hour and padded");

// The pruned-chip tokens still RESOLVE — only the chips went (§65.6). A
// saved pattern using one must not start writing a folder called "{date}".
eq(renderTemplate("{date}", {}, { now: NOW }), "20260813", "{date} still resolves, though its chip is gone");
eq(renderTemplate("{yyyy}{dd}", {}, { now: NOW }), "202613", "and so do the old lowercase date parts");
eq(
  renderTemplate("{cardname}", {}, { now: NOW, sourceLabel: "/Volumes/A001" }),
  "A001",
  "cardname is the source's own name",
);
eq(
  renderTemplate("{date}/{operator}", { operator: "Mathias" }, { now: NOW }),
  "20260813/Mathias",
  "slash in the TEMPLATE nests, deliberately",
);

// The one that matters: a value containing a slash must not create a
// directory level the user never asked for.
eq(
  renderTemplate("{operator}", { operator: "a/b" }, { now: NOW }),
  "a_b",
  "slash in a VALUE cannot smuggle in a directory level",
);
eq(
  renderTemplate("{operator}", { operator: "../../etc" }, { now: NOW }),
  ".._.._etc",
  "traversal in a value is neutralised, not just filtered",
);
eq(renderTemplate("{a}/{b}", { a: "..", b: "x" }, { now: NOW }), "x", "a bare .. segment is dropped");

console.log("\n4. Mapper — folder template");
{
  const map = buildRelMapper({
    folderTemplate: "{date}_{operator}",
    values: { operator: "Mathias" },
    sourceLabel: "/Volumes/A001",
    now: NOW,
  });
  eq(map("DCIM/100MEDIA/CLIP0001.MOV"), "20260813_Mathias/DCIM/100MEDIA/CLIP0001.MOV",
     "source tree preserved beneath the template");
  eq(map("README.txt"), "20260813_Mathias/README.txt", "root-level file");
}

console.log("\n5. Mapper — file template");
{
  const map = buildRelMapper({
    folderTemplate: "",
    fileTemplate: "{operator}_{counter}",
    values: { operator: "Mathias" },
    now: NOW,
  });
  eq(map("a/CLIP1.MOV"), "a/Mathias_0001.MOV", "renamed, extension kept, dir kept");
  eq(map("a/CLIP2.MOV"), "a/Mathias_0002.MOV", "counter increments across files");
}
{
  // §65.5 — a pattern that numbers nothing now gets _0001 appended.
  const map = buildRelMapper({ fileTemplate: "{name}_graded", values: {}, now: NOW });
  eq(map("CLIP.MOV"), "CLIP_graded_0001.MOV", "{name} is the original base name");
}

console.log("\n6. A pattern that numbers nothing is numbered for you (\u00a765.5)");
{
  // This used to throw NAMING_COLLISION. It now auto-appends, because the
  // refusal arrived at the worst moment — card chosen, destination chosen,
  // Start pressed — to report something the editor could have said.
  const map = buildRelMapper({ fileTemplate: "{operator}", values: { operator: "M" }, now: NOW });
  check(map.autoCounter === true, "the mapper says it is numbering on the user's behalf");
  eq(map("a/one.MOV"), "a/M_0001.MOV", "first file numbered");
  eq(map("a/two.MOV"), "a/M_0002.MOV", "second file numbered rather than refused");
}
{
  // Already numbered: nothing is appended, or every name would carry two.
  const map = buildRelMapper({ fileTemplate: "{operator}_{counter}", values: { operator: "M" }, now: NOW });
  check(map.autoCounter === false, "a pattern that already numbers is left alone");
  eq(map("a/one.MOV"), "a/M_0001.MOV", "and renders exactly what was written");
}
{
  // §74 INVERTS what this used to assert. {sourcecounter} was treated as
  // numbering, and it is not: it numbers the CARD, so it renders one
  // constant value for the whole job. A pattern using only it names every
  // file identically — the exact case the net exists to catch — while
  // switching the net off.
  const map = buildRelMapper({ fileTemplate: "{operator}_{sourcecounter}", values: { operator: "M" },
                               now: NOW, sourceCounter: 7 });
  check(map.autoCounter === true, "{sourcecounter} does NOT count as numbering — it is per-card (\u00a774)");
  eq(mapOr(map, "a/one.MOV"), "a/M_007_0001.MOV", "so the per-file suffix is still appended");
  eq(mapOr(map, "a/two.MOV"), "a/M_007_0002.MOV", "and the two files differ");
}
{
  // The reported failure, as reported: LUMIX \u2192 ODDONE_01, job 45f1c5d4.
  // Per-job fields only (chosen once, not per file) plus {sourcecounter},
  // no {counter} — which threw NAMING_COLLISION at job start.
  const T = "{sourcecounter}_{YYYY}{MM}{DD}_{type}_{a1}_{a2}";
  const map = buildRelMapper({ folderTemplate: T, fileTemplate: T, sourceCounter: 1,
    values: { type: "B-Roll", a1: "Scott", a2: "JolandaPriori" },
    now: new Date("2026-08-28T09:33:00Z") });
  const dir = "001_20260828_B-Roll_Scott_JolandaPriori";
  eq(mapOr(map, "DCIM/101_PANA/P1012257.MOV"), `${dir}/DCIM/101_PANA/${dir}_0001.MOV`,
     "the reported collision now numbers instead of refusing");
  eq(mapOr(map, "DCIM/101_PANA/P1012258.MOV"), `${dir}/DCIM/101_PANA/${dir}_0002.MOV`,
     "and the second file is distinct");
}
{
  // A folder pattern is untouched: {sourcecounter} there is exactly what it
  // is for, and an empty file template still renames nothing.
  const map = buildRelMapper({ folderTemplate: "Card_{sourcecounter}", fileTemplate: "",
                               now: NOW, sourceCounter: 7 });
  check(map.autoCounter === false, "an empty file template appends nothing");
  eq(map("a/P1012257.MOV"), "Card_007/a/P1012257.MOV", "and the original name survives");
}
{
  // FILE PATTERN ONLY. A folder pattern with {counter} deliberately makes a
  // folder per file; auto-adding one there would invent that behaviour for
  // someone who never asked for it.
  const map = buildRelMapper({ folderTemplate: "X_{counter}", values: {}, now: NOW });
  check(map.autoCounter === false, "a folder-only template is never auto-numbered");
  eq(map("a/one.MOV"), "X_0001/a/one.MOV", "folder-per-file is unchanged");
  eq(map("a/two.MOV"), "X_0002/a/two.MOV", "still one folder per file");
}
{
  // The throw survives as a BACKSTOP for shapes auto-numbering cannot fix.
  // Flatten collapses two directories that each hold a CLIP1, and both
  // already carry the same counter-free name.
  const map = buildRelMapper({ folderTemplate: "X", values: {}, now: NOW, flatten: true });
  eq(map("a/CLIP1.MOV"), "X/CLIP1.MOV", "first file fine");
  let threw = null;
  try { map("b/CLIP1.MOV"); } catch (e) { threw = e; }
  check(threw && threw.code === "NAMING_COLLISION",
        "a collision auto-numbering cannot reach is still refused, not overwritten",
        threw ? threw.code : "no throw");
}
{
  // Different directories keep them apart, so this must NOT collide.
  const map = buildRelMapper({ fileTemplate: "{operator}", values: { operator: "M" }, now: NOW });
  map("a/one.MOV");
  let threw = null;
  try { map("b/two.MOV"); } catch (e) { threw = e; }
  check(!threw, "same name in different folders is not a collision");
}

console.log("\n6b. {counter} is refused in a folder pattern (\u00a765c)");
{
  const err = folderPatternError("TAKE_{counter}");
  check(Boolean(err), "a folder pattern using {counter} is refused");
  check(/numbers files/.test(err) && /one folder per file/.test(err),
        "the message says what it would actually do", err);
  check(/\{sourcecounter\}/.test(err), "and names the token to use instead");

  check(Boolean(folderPatternError("{YYYY}/{operator}_{counter}")),
        "found anywhere in the pattern, including a nested segment");

  // The distinction the two tokens exist for. One folder per CARD is the
  // point of {sourcecounter}; one folder per FILE is the bug.
  check(folderPatternError("Card_{sourcecounter}") === null,
        "{sourcecounter} is untouched — numbering by card is what a folder pattern is for");
  check(folderPatternError("{YYYY}{MM}{DD}_{operator}") === null, "an ordinary pattern is fine");
  check(folderPatternError("") === null && folderPatternError(null) === null,
        "and an empty or absent pattern is not an error");

  // A near-miss that must NOT be caught: a user field happening to be
  // called something counter-ish is not the built-in token.
  check(folderPatternError("{shotcounter}") === null,
        "a custom field whose name merely contains 'counter' is not refused");

  // The engine still DOES this if asked directly — the guard is a
  // validation layer, not a change to rendering. Worth pinning so nobody
  // later assumes buildRelMapper refuses it and drops the check.
  const map = buildRelMapper({ folderTemplate: "X_{counter}", values: {}, now: NOW });
  eq(map("a/one.MOV"), "X_0001/a/one.MOV", "buildRelMapper itself is unchanged — the refusal is upstream");
}

console.log("\n6c. Does this job rename anything? (\u00a771)");
{
  // One definition, two callers: the engine's §23d fragile-rename guard
  // and the renderer's decision to consume a {sourcecounter} value. A
  // second copy of this rule lets a job rename without advancing the
  // counter, or advance it without renaming — both silent.
  check(rendersNewFileNames("{name}_{counter}") === true, "a real file pattern renames");
  check(rendersNewFileNames("") === false, "an empty one does not");
  check(rendersNewFileNames(null) === false, "nor an absent one");
  check(rendersNewFileNames("   ") === false, "nor whitespace");
  // §22g — disabling every field a pattern used leaves nothing to rename by.
  check(rendersNewFileNames("{operator}", ["operator"]) === false,
        "and a pattern whose every field is switched off renames nothing");
  check(rendersNewFileNames("{operator}_{counter}", ["operator"]) === true,
        "…but one with a surviving token still does");
}

console.log("\n7. No template = no mapper");
check(buildRelMapper({}) === null, "null when nothing is set, so the engine keeps its old path");
check(buildRelMapper({ folderTemplate: "   " }) === null, "whitespace-only counts as unset");

console.log("\n8. Unfilled tokens never reach a filename");
{
  // renderTemplate leaves an unknown token literal ON PURPOSE -- it is
  // unknownTokens()'s job to catch it first, and main.js refuses the job.
  // This asserts the pair works, since either half alone is a footgun.
  const tpl = "{date}_{operator}";
  check(unknownTokens(tpl, []).includes("operator"),
        "an unfilled field is detected before the job starts");
  eq(renderTemplate(tpl, {}, { now: NOW }), "20260813_{operator}",
     "...and would otherwise render literally, which is why the check exists");
}

console.log("\n9. Builtins exist without a preset");
{
  const v = builtinValues({ now: NOW, sourceLabel: "/Volumes/CARD_A", rel: "x/y.MOV", index: 7 });
  eq(v.cardname, "CARD_A", "cardname");
  eq(v.counter, "0007", "counter zero-padded");
  eq(v.ext, "MOV", "ext without the dot");
  eq(v.name, "y", "name without the extension");
}

console.log("\n10. Disabling a field removes its token AND a separator (§22g)");
{
  // The whole point: substituting an empty string instead would leave the
  // separator, so disabling `operator` in `{date}_{operator}` would produce
  // a folder literally called "20260816_".
  eq(omitTokens("{date}_{operator}", ["operator"]), "{date}", "token plus its trailing separator");
  eq(omitTokens("{operator}_{date}", ["operator"]), "{date}", "…or its leading one, at the start");
  eq(omitTokens("{date}-{operator}", ["operator"]), "{date}", "hyphen counts as a separator too");
  eq(omitTokens("{date}_{operator}_{camera}", ["operator"]), "{date}_{camera}",
    "a token in the middle leaves one separator, not two");
  eq(omitTokens("{operator}", ["operator"]), "", "a template that was only that field empties out");
  eq(omitTokens("{date}_{operator}", []), "{date}_{operator}", "nothing disabled changes nothing");
  eq(omitTokens("{date}_{op}", ["operator"]), "{date}_{op}", "a prefix of another key is not touched");
  eq(omitTokens("{a}_{b}", ["a", "b"]), "", "several at once");
  // `/` nests folders and must survive; renderTemplate drops the empty
  // segment that is left behind.
  eq(omitTokens("{date}/{operator}", ["operator"]), "{date}/", "slash is NOT eaten as a separator");
  eq(renderTemplate(omitTokens("{date}/{operator}", ["operator"]), {}, { now: NOW }),
    "20260813", "…and the empty segment collapses at render time");
  // A disabled field renders nothing even if a value was typed before the
  // toggle was flipped — the value is kept, the token is gone.
  eq(renderTemplate(omitTokens("{date}_{operator}", ["operator"]), { operator: "Mathias" }, { now: NOW }),
    "20260813", "a retained value cannot leak back in through the template");
}

// ── §77: the auto-suffix is a per-preset choice ─────────────────────────
{
  const T = "{operator}";
  const values = { operator: "M" };
  const rels = ["DCIM/P1012257.MOV", "DCIM/P1012258.MOV"];
  const mk = (autoSuffixSource, autoSuffixPosition) =>
    buildRelMapper({ fileTemplate: T, values, now: NOW, autoSuffixSource, autoSuffixPosition });

  // The pre-§77 behaviour, which is also what every axis falls back to.
  const cEnd = mk("counter", "end");
  eq(mapOr(cEnd, rels[0]), "DCIM/M_0001.MOV", "counter/end numbers at the end");
  eq(mapOr(cEnd, rels[1]), "DCIM/M_0002.MOV", "\u2026and increments");

  // OffShoot's own shape: template + _ + the source stem + real extension.
  const fEnd = mk("filename", "end");
  eq(mapOr(fEnd, rels[0]), "DCIM/M_P1012257.MOV", "filename/end keeps the camera's clip name");
  eq(mapOr(fEnd, rels[1]), "DCIM/M_P1012258.MOV", "\u2026per file, not per job");

  const fFront = mk("filename", "front");
  eq(mapOr(fFront, rels[0]), "DCIM/P1012257_M.MOV", "filename/front puts the stem first");

  const cFront = mk("counter", "front");
  eq(mapOr(cFront, rels[0]), "DCIM/0001_M.MOV", "counter/front puts the number first");
  eq(mapOr(cFront, rels[1]), "DCIM/0002_M.MOV", "\u2026and still increments");

  // Omitting both params entirely is what every existing call site did.
  const legacy = buildRelMapper({ fileTemplate: T, values, now: NOW });
  eq(mapOr(legacy, rels[0]), "DCIM/M_0001.MOV",
     "omitting both params is counter/end \u2014 a preset saved before \u00a777 is unchanged");

  // The net is off when the pattern numbers itself, whatever these say.
  const numbered = buildRelMapper({ fileTemplate: "{operator}_{counter}", values, now: NOW,
                                    autoSuffixSource: "filename", autoSuffixPosition: "front" });
  check(numbered.autoCounter === false, "a self-numbering pattern still exempts itself (\u00a774)");
  eq(mapOr(numbered, rels[0]), "DCIM/M_0001.MOV", "\u2026and neither axis touches it");

  // The stem is everything before the REAL extension \u2014 a name with dots
  // in it must not be cut short on the way in.
  const dotted = buildRelMapper({ fileTemplate: T, values, now: NOW,
                                  autoSuffixSource: "filename", autoSuffixPosition: "end" });
  eq(mapOr(dotted, "DCIM/A.001.CLIP.MOV"), "DCIM/M_A.001.CLIP.MOV",
     "a stem with dots keeps all of it, and only the real extension is re-added");
}

// ── §78: the date tokens render from `now` ──────────────────────────────
{
  // A LOCAL date, which is what the renderer's date input produces.
  const m = buildRelMapper({ fileTemplate: "{YYYY}{MM}{DD}_{hh}{mm}", values: {},
                             now: new Date(2025, 0, 2, 3, 4) });
  eq(mapOr(m, "a/CLIP.MOV"), "a/20250102_0304_0001.MOV",
     "an overridden date renders instead of the live clock");
  // A second, different value \u2014 so this cannot pass by echoing one input.
  const live = buildRelMapper({ fileTemplate: "{YYYY}", values: {}, now: new Date(2030, 5, 1) });
  eq(mapOr(live, "a/CLIP.MOV"), "a/2030_0001.MOV", "and a different one renders differently");
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
