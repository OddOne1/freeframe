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
      const store = await window.freeframe.savePreset({
        name: "Field Panel Test",
        folderTemplate: "{date}_{operator}_{talent}",
        fileTemplate: "",
        fields: [
          { key: "operator", label: "Operator", type: "text", required: true },
          { key: "talent", label: "Talent", type: "select", required: false },
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
               inputs: document.querySelectorAll("#fields-body input[data-fv-key]").length };
    })()`);
    check(empty.inputs === 0, "no inputs before a source is assigned");
    check(/Assign a source/.test(empty.text), "and it says why", empty.text.slice(0, 60));

    const shown = await ev(`(() => {
      extraFolders = ${JSON.stringify([cardA, cardB, dest])};
      setSource(${JSON.stringify(cardA)});
      render();
      const keys = [...document.querySelectorAll("#fields-body input[data-fv-key]")].map(i => i.dataset.fvKey);
      const toggles = document.querySelectorAll("#fields-body .fv-toggle").length;
      return {
        keys, toggles,
        source: document.querySelector("#fields-body .fv-source").textContent,
        required: !!document.querySelector("#fields-body .req"),
        hasDatalist: !!document.querySelector("#fields-body datalist"),
      };
    })()`);
    check(shown.keys.join(",") === "operator,talent", "one input per field, in preset order", shown.keys.join(","));
    check(shown.toggles === 2, "each field has its own toggle", `${shown.toggles}`);
    check(shown.source === "A001", "the panel names the source it describes", shown.source);
    check(shown.required, "the required field is marked");
    check(shown.hasDatalist, "the suggesting field gets a datalist, like the preset modal");

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

    // ── 2. Values reach a real job, and a disabled field is omitted ───────
    console.log("\n2. Values reach a REAL copy, and a disabled field is dropped");
    await ev(`(() => {
      const t = document.querySelector('#fields-body input[data-fv-key="talent"]');
      t.value = "Rey"; t.dispatchEvent(new Event("input"));
      // Switch the talent field OFF for this transfer.
      const toggles = [...document.querySelectorAll("#fields-body .fv-toggle")];
      toggles[1].checked = false; toggles[1].dispatchEvent(new Event("change"));
      return true;
    })()`);
    const payload = await ev(`JSON.stringify(namingPayload())`).then(JSON.parse);
    check(payload.disabledFields.join(",") === "talent", "the disabled field is reported to main",
      JSON.stringify(payload.disabledFields));
    check(payload.values.operator === "Mathias" && payload.values.talent === "Rey",
      "the typed values are still carried — disabling is not erasing");

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
    check(!onDisk[0].includes("Rey"), "the DISABLED field's value is absent", onDisk[0]);
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
      return { bSource, bOperator, aOperator, aToggle, backB };
    })()`);
    check(perSource.bSource === "B002", "the panel follows the newly-assigned source", perSource.bSource);
    check(perSource.bOperator === "", "a fresh card starts empty, not with the other card's value",
      JSON.stringify(perSource.bOperator));
    check(perSource.aOperator === "Mathias", "switching back restores the first card's value", perSource.aOperator);
    check(perSource.aToggle === false, "…including its per-transfer toggle state");
    check(perSource.backB === "Ana", "and the second card keeps its own", perSource.backB);

    // ── 4. Nothing leaked into the saved preset ──────────────────────────
    console.log("\n4. The toggle never reaches the saved preset");
    const reread = await ev(`(async () => {
      const store = await window.freeframe.listPresets();
      const p = store.presets.find(x => x.id === ${JSON.stringify(presetId)});
      return { fields: p.fields, keys: Object.keys(p), raw: JSON.stringify(p) };
    })()`);
    check(reread.fields.length === 2, "the preset still has both fields", `${reread.fields.length}`);
    check(reread.fields.every((f) => !("disabled" in f) && !("value" in f)),
      "no per-transfer state was written onto a field", JSON.stringify(reread.fields));
    check(!/disabledFields|"Mathias"|"Rey"|"Ana"/.test(reread.raw),
      "and no entered value or toggle is anywhere in the saved preset");
    check(reread.fields[0].required === true, "Required is untouched — it is a different thing from the toggle");

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
