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
} = require(path.join(__dirname, "..", "src", "main", "naming.js"));

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
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
eq(renderTemplate("{yy}{mm}{dd}", {}, { now: NOW }), "260813", "date parts");
eq(renderTemplate("{time}", {}, { now: NOW }), "2105", "local time, not UTC");
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
  const map = buildRelMapper({ fileTemplate: "{name}_graded", values: {}, now: NOW });
  eq(map("CLIP.MOV"), "CLIP_graded.MOV", "{name} is the original base name");
}

console.log("\n6. Collisions are refused, not resolved");
{
  const map = buildRelMapper({ fileTemplate: "{operator}", values: { operator: "M" }, now: NOW });
  eq(map("a/one.MOV"), "a/M.MOV", "first file fine");
  // Same directory, same rendered name -> would overwrite.
  let threw = null;
  try { map("a/two.MOV"); } catch (e) { threw = e; }
  check(threw && threw.code === "NAMING_COLLISION", "second file raises rather than overwriting",
        threw ? threw.code : "no throw");
  check(threw && /Add \{counter\}/.test(threw.message), "the error says how to fix it");
}
{
  // Different directories keep them apart, so this must NOT collide.
  const map = buildRelMapper({ fileTemplate: "{operator}", values: { operator: "M" }, now: NOW });
  map("a/one.MOV");
  let threw = null;
  try { map("b/two.MOV"); } catch (e) { threw = e; }
  check(!threw, "same name in different folders is not a collision");
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

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
