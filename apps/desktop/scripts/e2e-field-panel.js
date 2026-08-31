#!/usr/bin/env node
// Per-transfer field values panel (CLAUDE.md §22g).
//
// The four things the brief asks to prove, in order:
//   * the panel shows one input per field of the active preset
//   * values entered there reach a REAL copy job's folder names, and a
//     field switched off is omitted from them
//   * switching source shows that source's own values, not a shared set
//   * the toggle never reaches the saved preset file
//
// The second is the one that matters: a panel that looks right and doesn't
// reach the job is worse than no panel, because it reads as confirmation.
// So this runs an actual copy and reads the names back off the disk.
//
// Run: node scripts/e2e-field-panel.js
const { spawn, execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/** Destination contents, ignoring the per-job transfer log (§18c). */
async function walk(dir, base = "") {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name === "FreeFrame Logs") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-fields-"));
  const cardA = path.join(tmp, "A001");
  const cardB = path.join(tmp, "B002");
  const dest = path.join(tmp, "RAID");
  for (const c of [cardA, cardB]) {
    await fsp.mkdir(path.join(c, "DCIM"), { recursive: true });
    await fsp.writeFile(path.join(c, "DCIM", "CLIP0001.MOV"), crypto.randomBytes(32 * 1024));
  }
  await fsp.mkdir(dest, { recursive: true });

  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`],
    { stdio: "ignore" },
  );

  let page;
  for (let i = 0; i < 80; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = t.find((x) => x.type === "page" && x.url.includes("index.html"));
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(250);
  }
  if (!page) { console.error("Electron never came up"); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (me, pa = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  });
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
    return r.result.value;
  };
  const pageErrors = [];
  await send("Runtime.enable");
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || "unknown");
    }
  });
  await sleep(1800);

  let presetId = null;
  try {
    console.log("0. Load");
    check(pageErrors.length === 0, "no uncaught exception", pageErrors.join(" | "));

    // A preset with two custom fields, one of them required.
    const made = await ev(`(async () => {
      // savePreset matches on id and this fixture supplies none, so every
      // run adds ANOTHER "Field Panel Test" and find(by name) returns
      // whichever one an earlier run left behind — asserting against stale
      // data rather than what was just written.
      const before = await window.freeframe.listPresets();
      for (const p of before.presets.filter(p => p.name === "Field Panel Test")) {
        await window.freeframe.deletePreset(p.id);
      }
      const store = await window.freeframe.savePreset({
        name: "Field Panel Test",
        folderTemplate: "{date}_{operator}_{talent}",
        fileTemplate: "",
        fields: [
          { key: "operator", label: "Operator", type: "text", required: true },
          // §65 — was type "select" (Suggesting), which no longer exists.
          // A Choice field with an authored list and "Other…" enabled, so
          // this harness covers the new runtime control as well.
          { key: "talent", label: "Talent", type: "choice", required: false,
            allowOther: true,
            options: [{ label: "Alex Rivera", token: "AR" }, { label: "Sam Okafor", token: "" }] },
          // A CLOSED list, so "Other… is offered" cannot pass vacuously by
          // only ever meeting a field that allows it.
          { key: "camera", label: "Camera", type: "choice", required: false,
            allowOther: false,
            options: [{ label: "Alexa 35", token: "A35" }] },
        ],
      });
      const p = store.presets.find(x => x.name === "Field Panel Test");
      presetStore = store; activePresetId = p.id; updatePresetLabel(); render();
      return p;
    })()`);
    presetId = made.id;
    check(!!presetId, "test preset created");

    // ── 1. One input per field ───────────────────────────────────────────
    console.log("\n1. The panel lists the active preset's fields");
    const empty = await ev(`(() => {
      clearAll(); render();
      return { text: document.getElementById("fields-body").textContent,
               inputs: document.querySelectorAll("#fields-body [data-fv-key]").length };
    })()`);
    check(empty.inputs === 0, "no inputs before a source is assigned");
    check(/Assign a source/.test(empty.text), "and it says why", empty.text.slice(0, 60));

    const shown = await ev(`(() => {
      extraFolders = ${JSON.stringify([cardA, cardB, dest])};
      setSource(${JSON.stringify(cardA)});
      render();
      // A Choice field renders a <select>, so match on the attribute
      // rather than the tag or it silently disappears from this count.
      const keys = [...document.querySelectorAll("#fields-body [data-fv-key]")].map(i => i.dataset.fvKey);
      const toggles = document.querySelectorAll("#fields-body .fv-toggle").length;
      return {
        keys, toggles,
        source: document.querySelector("#fields-body .fv-source").textContent,
        required: !!document.querySelector("#fields-body .req"),
        // §65.3 — the Choice field is a dropdown of its authored options.
        choiceTag: (document.querySelector('#fields-body [data-fv-key="talent"]') || {}).tagName,
        choiceOptions: [...document.querySelectorAll('#fields-body [data-fv-key="talent"] option')]
          .map(o => o.textContent + "=" + o.value),
        noDatalist: !document.querySelector("#fields-body datalist"),
        closedOptions: [...document.querySelectorAll('#fields-body [data-fv-key="camera"] option')]
          .map(o => o.textContent),
      };
    })()`);
    check(shown.keys.join(",") === "operator,talent,camera", "one input per field, in preset order", shown.keys.join(","));
    check(shown.toggles === 3, "each field has its own toggle", `${shown.toggles}`);
    check(shown.source === "A001", "the panel names the source it describes", shown.source);
    check(shown.required, "the required field is marked");
    check(shown.choiceTag === "SELECT", "a Choice field renders as a dropdown", String(shown.choiceTag));
    check((shown.choiceOptions || []).includes("Alex Rivera=AR"),
      "showing the Label but carrying the Token — a full name reads better in a list, a short code in a filename",
      (shown.choiceOptions || []).join(" | "));
    check((shown.choiceOptions || []).includes("Sam Okafor=Sam Okafor"),
      "and a blank Token falls back to the Label rather than substituting nothing");
    check((shown.choiceOptions || []).some((o) => o.startsWith("Other…")),
      "with an Other… entry, because this field allows one");
    check(shown.noDatalist,
      "and no datalist anywhere — Suggesting is removed, not hidden");
    check(!(shown.closedOptions || []).some((o) => o.startsWith("Other")),
      "a field with allowOther off is a closed list with no escape hatch",
      (shown.closedOptions || []).join(" | "));

    // Start must wait for a required field rather than ambushing at press time.
    const gate = await ev(`(() => {
      addDest(${JSON.stringify(dest)}, null); render();
      const before = document.getElementById("start").disabled;
      const input = document.querySelector('#fields-body input[data-fv-key="operator"]');
      input.value = "Mathias";
      input.dispatchEvent(new Event("input"));
      return { before, after: document.getElementById("start").disabled };
    })()`);
    check(gate.before === true, "Start is disabled while a required field is empty");
    check(gate.after === false, "and enables as soon as it is filled");

    // ── 1c. The card, and where Copy & Verify sits (§65.10-.12) ──────────
    console.log("\n1c. (\u00a765.10-.12) A compact card, and a relocated Copy & Verify");
    const layout = await ev(`(() => {
      const card = document.querySelector(".naming-card").getBoundingClientRect();
      const dest = document.getElementById("zone-dest").getBoundingClientRect();
      const panel = document.getElementById("fields-panel").getBoundingClientRect();
      return {
        // The one thing the spec pins: it must never sit on top of the
        // Destination drop zone. A flex sibling pushes; the sketch this
        // replaces was absolutely positioned and covered it.
        overlapsDest: card.left < dest.right && card.right > dest.left,
        cardH: Math.round(card.height),
        panelH: Math.round(panel.height),
        winH: window.innerHeight,
        startParent: document.getElementById("start").parentElement.id,
        headerHasStart: !!document.querySelector("header #start"),
        headerHasClear: !!document.querySelector("header #clear"),
        clearExists: !!document.getElementById("clear"),
      };
    })()`);
    check(!layout.overlapsDest, "the card does not overlap the Destination zone");
    check(layout.cardH < layout.winH * 0.75,
      "and is content-sized rather than a full-height column",
      `${layout.cardH}px of ${layout.winH}px`);
    check(layout.startParent === "start-zone-card",
      "Copy & Verify sits under the card while the card is open", layout.startParent);
    check(!layout.headerHasStart && !layout.headerHasClear,
      "neither button is in the header any more");
    check(!layout.clearExists, "the old header Clear is gone entirely, not merely moved");

    // At several widths, because "does not overlap" is a layout claim.
    const widths = await ev(`(() => {
      const out = [];
      const ws = document.querySelector(".workspace");
      for (const w of [1400, 1100, 960]) {
        ws.style.width = w + "px";
        const card = document.querySelector(".naming-card").getBoundingClientRect();
        const dest = document.getElementById("zone-dest").getBoundingClientRect();
        out.push([w, card.left >= dest.right - 1]);
      }
      ws.style.width = "";
      return out;
    })()`);
    check(widths.every(([, ok]) => ok),
      "and stays clear of it at narrower widths too", JSON.stringify(widths));

    // ── 1d. Card # and Clear (§65.4/.11) ─────────────────────────────────
    console.log("\n1d. (\u00a765.4/.11) Card number and Clear live in the card");
    const card = await ev(`(async () => {
      const counter = document.getElementById("fv-counter-input");
      const before = counter.value;
      counter.value = String(Number(before) + 5);
      counter.dispatchEvent(new Event("change"));
      await new Promise(r => setTimeout(r, 500));
      return {
        before,
        counterNow: document.getElementById("fv-counter-input").value,
        stored: (await window.freeframe.listPresets()).sourceCounter,
        hasClear: !!document.getElementById("fields-clear"),
      };
    })()`);
    check(card.hasClear, "Clear is inside the card");
    check(String(card.counterNow) === String(Number(card.before) + 5),
      "the Card # is editable in place", `${card.before} → ${card.counterNow}`);
    // §71 changed what this field MEANS. It was the number already claimed
    // for the assigned card; it is now the store's next value, because the
    // claim happens at job start. So it is checked against the store rather
    // than against namingPayload(), which carries nothing until a job runs.
    // Section 5 below proves the end-to-end half: the job renders the
    // number it claimed.
    check(String(card.stored) === String(card.counterNow),
      "and it is the store's next value — what the next renaming job will claim",
      String(card.stored));

    const cleared = await ev(`(() => {
      const inp = document.querySelector('#fields-body input[data-fv-key="operator"]');
      inp.value = "Mathias"; inp.dispatchEvent(new Event("input"));
      const beforeCounter = document.getElementById("fv-counter-input").value;
      document.getElementById("fields-clear").click();
      return {
        beforeCounter,
        values: JSON.stringify(namingPayload().values),
        afterCounter: document.getElementById("fv-counter-input").value,
        counterInPayload: namingPayload().sourceCounter,
      };
    })()`);
    check(cleared.values === "{}", "Clear resets the entered values", cleared.values);
    check(cleared.afterCounter === cleared.beforeCounter,
      "and leaves the Card # alone — a card's number is not a value someone typed",
      `${cleared.beforeCounter} → ${cleared.afterCounter}`);

    // Clear really did clear, so the state the later sections expect has to
    // be put back — this section is a detour through it, not a replacement.
    await ev(`(() => {
      const inp = document.querySelector('#fields-body input[data-fv-key="operator"]');
      inp.value = "Mathias"; inp.dispatchEvent(new Event("input"));
      return true;
    })()`);

    // ── 1e. There is no way to hide the card but deselect the preset ─────
    // §70 inverted what this section used to assert. It drove a Hide
    // control that dismissed the card while leaving every required field
    // still required — a job could then refuse to start with the
    // explanation of why hidden behind the thing that was hidden. Both
    // that control and the header button that brought the card back are
    // gone, so what is checked now is their absence.
    console.log("\n1e. (\u00a770) The card has no separate Hide");
    const noHide = await ev(`(() => ({
      collapseExists: !!document.getElementById("fields-collapse"),
      showExists: !!document.getElementById("fields-show"),
      setterExists: typeof setFieldsPanel !== "undefined",
      // A preset is active, so the card is on screen and stays there.
      cardHidden: document.getElementById("fields-panel").classList.contains("hidden"),
      startParent: document.getElementById("start").parentElement.id,
    }))()`);
    check(noHide.collapseExists === false, "the card carries no Hide button");
    check(noHide.showExists === false, "and the header carries no button to bring it back");
    check(noHide.setterExists === false, "the flag they flipped is gone with them");
    check(noHide.cardHidden === false,
      "an active preset keeps its card on screen, with nothing able to dismiss it");
    check(noHide.startParent === "start-zone-card",
      "so Copy & Verify stays under the card", noHide.startParent);

    // The spec's actual rule: with NO preset active there is no Clear at
    // all — not hidden, not built. Dismissing the card above is a
    // different state and is checked as such.
    const noPreset = await ev(`(() => {
      const was = activePresetId;
      setActivePreset(null);
      const out = {
        clearExists: !!document.getElementById("fields-clear"),
        counterExists: !!document.getElementById("fv-counter-input"),
        startParent: document.getElementById("start").parentElement.id,
      };
      setActivePreset(was);
      return out;
    })()`);
    check(!noPreset.clearExists && !noPreset.counterExists,
      "with no preset active, neither Clear nor the Card # exists anywhere");
    check(noPreset.startParent === "start-zone-columns",
      "and Copy & Verify centres under the three columns", noPreset.startParent);

    // ── 1b. "Other…" reveals an input beside THAT field only ─────────────
    console.log("\n1b. Other… is a per-field escape hatch (\u00a765.3)");
    const other = await ev(`(() => {
      const sel = document.querySelector('#fields-body select[data-fv-key="talent"]');
      const wrap = sel.closest(".fv-control");
      const before = wrap.querySelector(".fv-other").hidden;
      sel.value = "\u0000other";
      sel.dispatchEvent(new Event("change"));
      const inp = wrap.querySelector(".fv-other");
      inp.value = "Guest Star";
      inp.dispatchEvent(new Event("input"));
      return {
        hiddenBefore: before,
        shownAfter: !inp.hidden,
        // Scoped to this field: the OTHER field must not sprout one.
        othersElsewhere: document.querySelectorAll("#fields-body .fv-other:not([hidden])").length,
        value: namingPayload().values.talent,
      };
    })()`);
    check(other.hiddenBefore, "the Other… input is hidden until it is chosen");
    check(other.shownAfter, "and revealed when it is");
    check(other.othersElsewhere === 1, "beside that field alone, not in a shared area",
      String(other.othersElsewhere));
    check(other.value === "Guest Star", "the typed one-off becomes the substituted value", other.value);

    // Back to a real option, so the rest of the run is unaffected.
    await ev(`(() => {
      const sel = document.querySelector('#fields-body select[data-fv-key="talent"]');
      sel.value = ""; sel.dispatchEvent(new Event("change"));
      return true;
    })()`);

    // ── 2. Values reach a real job, and a disabled field is omitted ───────
    console.log("\n2. Values reach a REAL copy, and a disabled field is dropped");
    await ev(`(() => {
      // §65.3 — talent is a Choice field now, so it is picked, not typed.
      // Choosing "Alex Rivera" must carry its TOKEN ("AR") forward, not its
      // label, which is the whole reason the two are separate.
      const t = document.querySelector('#fields-body select[data-fv-key="talent"]');
      t.value = "AR"; t.dispatchEvent(new Event("change"));
      // Switch the talent field OFF for this transfer.
      const toggles = [...document.querySelectorAll("#fields-body .fv-toggle")];
      toggles[1].checked = false; toggles[1].dispatchEvent(new Event("change"));
      return true;
    })()`);
    const payload = await ev(`JSON.stringify(namingPayload())`).then(JSON.parse);
    check(payload.disabledFields.join(",") === "talent", "the disabled field is reported to main",
      JSON.stringify(payload.disabledFields));
    check(payload.values.operator === "Mathias" && payload.values.talent === "AR",
      "the picked option's TOKEN is carried, not its label — disabling is not erasing",
      JSON.stringify(payload.values));

    const summary = await ev(`(async () => await window.freeframe.startCopy(
      ${JSON.stringify(cardA)},
      [{ id: "n1", path: ${JSON.stringify(dest)}, parentId: null }],
      "xxhash64", null, null, namingPayload(), "free"))()`);
    check(summary.allVerified === true, "the copy verified",
      JSON.stringify({ files: summary.totalFiles, errors: summary.errors.length }));

    const onDisk = await walk(dest);
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    console.log("     " + onDisk.join("\n     "));
    check(onDisk.length === 1, "one file landed", `${onDisk.length}`);
    check(onDisk[0].startsWith(`${stamp}_Mathias/`),
      `the entered value is in the folder name (${stamp}_Mathias)`, onDisk[0]);
    check(!onDisk[0].includes("AR"), "the DISABLED field's value is absent", onDisk[0]);
    // The separator has to go with the token, or the folder is "..._Mathias_".
    check(!/_\//.test(onDisk[0]) && !onDisk[0].endsWith("_"),
      "and its separator went with it — no dangling underscore", onDisk[0]);
    check(!/[{}]/.test(onDisk[0]), "no literal {token} survived");

    // ── 3. Values are per source ─────────────────────────────────────────
    console.log("\n3. Each source keeps its own values");
    const perSource = await ev(`(() => {
      setSource(${JSON.stringify(cardB)}); render();
      const bOperator = (document.querySelector('#fields-body input[data-fv-key="operator"]') || {}).value;
      const bSource = document.querySelector("#fields-body .fv-source").textContent;
      const bToggle = [...document.querySelectorAll("#fields-body .fv-toggle")][1].checked;
      // Give B its own value, then go back to A.
      const i = document.querySelector('#fields-body input[data-fv-key="operator"]');
      i.value = "Ana"; i.dispatchEvent(new Event("input"));
      setSource(${JSON.stringify(cardA)}); render();
      const aOperator = (document.querySelector('#fields-body input[data-fv-key="operator"]') || {}).value;
      const aToggle = [...document.querySelectorAll("#fields-body .fv-toggle")][1].checked;
      setSource(${JSON.stringify(cardB)}); render();
      const backB = (document.querySelector('#fields-body input[data-fv-key="operator"]') || {}).value;
      return { bSource, bOperator, bToggle, aOperator, aToggle, backB };
    })()`);
    check(perSource.bSource === "B002", "the panel follows the newly-assigned source", perSource.bSource);
    // INVERTED BY §80, not deleted. This asserted that a brand-new card
    // starts blank; §80 makes it seed from the card before it, because the
    // values that change between cards on one shoot are the minority — the
    // operator and the shoot rarely do. The per-card isolation the rest of
    // this section checks is unchanged and still the point: seeding happens
    // ONCE, at creation, from a shallow copy, so the two cards never share
    // a values object. (§80's own spec calls that out as a bug it must not
    // reintroduce.) A card that has been seen before is untouched by it.
    check(perSource.bOperator === "Mathias",
      "a brand-new card seeds from the previous card's values (§80)",
      JSON.stringify(perSource.bOperator));
    check(perSource.bToggle === true,
      "…but NOT its per-transfer toggles — a new card starts with every field enabled",
      JSON.stringify(perSource.bToggle));
    check(perSource.aOperator === "Mathias", "switching back restores the first card's value", perSource.aOperator);
    check(perSource.aToggle === false, "…including its per-transfer toggle state");
    check(perSource.backB === "Ana",
      "and the second card keeps its own — seeding is a starting value, not a shared reference",
      perSource.backB);

    // ── 4. Nothing leaked into the saved preset ──────────────────────────
    console.log("\n4. The toggle never reaches the saved preset");
    const reread = await ev(`(async () => {
      const store = await window.freeframe.listPresets();
      const p = store.presets.find(x => x.id === ${JSON.stringify(presetId)});
      return { fields: p.fields, keys: Object.keys(p), raw: JSON.stringify(p) };
    })()`);
    check(reread.fields.length === 3, "the preset still has all its fields", `${reread.fields.length}`);
    check(reread.fields.every((f) => !("disabled" in f) && !("value" in f)),
      "no per-transfer state was written onto a field", JSON.stringify(reread.fields));
    check(!/disabledFields|"Mathias"|"Ana"/.test(reread.raw),
      "and no entered value or toggle is anywhere in the saved preset");
    // The authored options ARE part of the preset and must survive — they
    // are the field's definition, unlike anything typed for one transfer.
    check(/"Alex Rivera"/.test(reread.raw) && /"AR"/.test(reread.raw),
      "…while the Choice field's authored options are still there");
    check(reread.fields[0].required === true, "Required is untouched — it is a different thing from the toggle");

    // ── §71 — the counter advances on a renaming job, and only then ──────
    console.log("\n5. (\u00a771) The card number advances only for a renaming job");
    const store = `window.freeframe.listPresets().then(s => s.sourceCounter)`;
    await ev(`window.freeframe.setSourceCounter(200)`);
    await ev(`(async () => { nextSourceCounter = (await window.freeframe.listPresets()).sourceCounter; return true; })()`);

    // Assigning a source used to burn a number here (§22h). It must not.
    await ev(`clearAll(); setSource(${JSON.stringify(cardB)}); render(); true`);
    await ev(`setSource(${JSON.stringify(cardA)}); render(); true`);
    check(await ev(store) === 200,
      "assigning a source — twice — consumes nothing", String(await ev(store)));
    check(await ev(`document.getElementById("fv-counter-input").value`) === "200",
      "and the card shows the number the next renaming job will use");

    // A plain copy with no preset must not consume one either.
    const dest71 = path.join(tmp, "RAID71");
    await fsp.mkdir(dest71, { recursive: true });
    await ev(`activePresetId = null; updatePresetLabel();
      extraFolders = ${JSON.stringify([cardA, cardB, dest, dest71])};
      clearAll(); setSource(${JSON.stringify(cardA)}); addDest(${JSON.stringify(dest71)}, null); render(); true`);
    await ev(`startCopy()`);
    check(await ev(store) === 200, "a plain copy with no naming consumes nothing", String(await ev(store)));

    // The distinction the spec actually draws: a preset that IS active but
    // renames nothing (folder pattern only, empty file pattern). Without a
    // separate fixture the no-preset case above passes vacuously, since a
    // null payload skips the whole claim path.
    const pNoRename = await ev(`(async () => {
      const st = await window.freeframe.savePreset({ id: null, name: "S71 No Rename",
        folderTemplate: "plain{sourcecounter}", fileTemplate: "", fields: [] });
      presetStore = st;
      const p = st.presets.find(x => x.name === "S71 No Rename");
      setActivePreset(p.id);
      return p.id;
    })()`);
    await ev(`clearAll(); setSource(${JSON.stringify(cardA)}); addDest(${JSON.stringify(dest71)}, null); render(); true`);
    await ev(`startCopy()`);
    check(await ev(store) === 200,
      "an ACTIVE preset that renames nothing consumes nothing either", String(await ev(store)));
    await ev(`window.freeframe.deletePreset(${JSON.stringify(pNoRename)})`);
    await fsp.rm(dest71, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(dest71, { recursive: true });

    // A renaming job takes exactly one, and renders THAT number.
    const p71 = await ev(`(async () => {
      const st = await window.freeframe.savePreset({ id: null, name: "S71 Field Panel",
        folderTemplate: "card{sourcecounter}", fileTemplate: "{name}_{counter}", fields: [] });
      presetStore = st;
      const p = st.presets.find(x => x.name === "S71 Field Panel");
      setActivePreset(p.id);
      return p.id;
    })()`);
    await ev(`clearAll(); setSource(${JSON.stringify(cardA)}); addDest(${JSON.stringify(dest71)}, null); render(); true`);
    await ev(`startCopy()`);
    check(await ev(store) === 201, "a renaming job takes exactly one", String(await ev(store)));

    const landed = await walk(dest71);
    check(landed.some((f) => f.startsWith("card200/")),
      "and the job rendered the number it claimed, not the one after it",
      landed.join(" | "));

    await ev(`window.freeframe.deletePreset(${JSON.stringify(p71)})`);
    await fsp.rm(dest71, { recursive: true, force: true }).catch(() => {});

    check(pageErrors.length === 0, "no uncaught exception across the whole run", pageErrors.join(" | "));
  } finally {
    if (presetId) {
      await ev(`window.freeframe.deletePreset(${JSON.stringify(presetId)})`).catch(() => {});
    }
    ws.close();
    child.kill("SIGKILL");
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\nHARNESS ERROR", err);
  process.exit(1);
});
