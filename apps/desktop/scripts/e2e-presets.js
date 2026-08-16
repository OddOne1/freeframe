#!/usr/bin/env node
// Naming presets, end to end through the real app (CLAUDE.md §10 / §18b).
//
// The acceptance criteria from the prompt, in order:
//   * create a preset with a text field AND a suggesting field
//   * run a REAL copy job with it
//   * confirm the names ON DISK contain the substituted values — not that
//     the editor UI looks right
//   * confirm an unfilled required field blocks the job with a clear
//     message, rather than copying with a literal {token} in the name
//
// Run: node scripts/e2e-presets.js
const { spawn, execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9318;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { execSync(`pkill -f 'remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(1200);

  // ── Real files on disk ──
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-preset-"));
  const source = path.join(tmp, "A001");
  const dest = path.join(tmp, "RAID");
  await fsp.mkdir(path.join(source, "DCIM", "100MEDIA"), { recursive: true });
  await fsp.mkdir(dest, { recursive: true });
  for (const name of ["CLIP0001.MOV", "CLIP0002.MOV"]) {
    await fsp.writeFile(path.join(source, "DCIM", "100MEDIA", name), crypto.randomBytes(64 * 1024));
  }
  await fsp.writeFile(path.join(source, "notes.txt"), "shot list\n");

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
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 300000 });
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

  console.log("0. Page load");
  check(pageErrors.length === 0, "no uncaught exception during load", pageErrors.join(" | "));

  // ── 1. Layout ratio (§18a) ──
  console.log("\n1. Column ratio (§18a)");
  const cols = await ev(`(() => {
    const c = document.querySelector(".columns");
    const w = getComputedStyle(c).gridTemplateColumns.split(" ").map(parseFloat);
    return { w, total: w.reduce((a,b)=>a+b,0) };
  })()`);
  const middleShare = cols.w[1] / cols.total;
  check(middleShare > 0.55 && middleShare < 0.65,
    "Volumes column is ~60% of the window", `${(middleShare * 100).toFixed(1)}%`);
  check(Math.abs(cols.w[0] - cols.w[2]) < 2, "Sources and Destinations stay equal",
    `${cols.w[0].toFixed(0)} vs ${cols.w[2].toFixed(0)}`);

  // §22f — there is no list/grid toggle any more, and the grid is an inner
  // .grid-view per section rather than the zone itself, so the Volumes
  // column is measured where the tracks actually live now.
  const tiles = await ev(`(() => {
    render();
    const g = document.querySelector("#zone-volumes .grid-view");
    if (!g) return 0;
    return getComputedStyle(g).gridTemplateColumns.split(" ").length;
  })()`);
  check(tiles >= 3, "the Volumes grid fits several tiles per row at the new width", `${tiles} columns`);

  // ── 2. Create a preset with both field types ──
  console.log("\n2. Preset with a text field and a suggesting field");
  const saved = await ev(`(async () => {
    const store = await window.freeframe.savePreset({
      name: "Shoot Night",
      folderTemplate: "{date}_{operator}/{camera}",
      fileTemplate: "",
      fields: [
        { label: "Operator", type: "text", required: true },
        { label: "Camera", type: "select", required: false },
      ],
    });
    // reloadPresets() is what the app's own save handler does — without
    // it the renderer keeps a stale in-memory copy and activePreset()
    // resolves to nothing.
    await reloadPresets();
    return store.presets.find(p => p.name === "Shoot Night");
  })()`);
  check(Boolean(saved), "preset saved to userData");
  check(saved.fields.length === 2, "both fields stored", `${saved.fields.length}`);
  check(saved.fields[0].key === "operator" && saved.fields[1].key === "camera",
    "tokens derived from the labels", saved.fields.map(f => f.key).join(","));
  check(saved.fields[0].required === true && saved.fields[1].required === false,
    "per-field required/optional kept");
  check(saved.fields[1].type === "select", "suggesting field type kept");

  // ── 3. A required field left blank must BLOCK the job ──
  console.log("\n3. An unfilled required field blocks the job");
  await ev(`
    activePresetId = ${JSON.stringify(saved.id)};
    presetValues = { camera: "Alexa" };   // operator deliberately blank
    clearAll();
    setSource(${JSON.stringify(source)});
    addDest(${JSON.stringify(dest)}, null);
    render(); true`);

  check((await ev(`missingRequired().join(",")`)) === "Operator",
    "the blank required field is identified by name");

  await ev(`startCopy(); true`);
  await sleep(400);
  check(await ev(`$("values-backdrop").classList.contains("open")`),
    "the job does not start — the values dialog opens instead");
  const msg = await ev(`$("values-error").textContent`);
  check(/Operator/.test(msg) && /folder name/.test(msg),
    "with a message naming the field and why it matters", msg);
  check((await fsp.readdir(dest)).length === 0, "nothing was written to the destination");

  // The main process must refuse it too, not just the renderer.
  const refused = await ev(`(async () => {
    try {
      await window.freeframe.startCopy(${JSON.stringify(source)},
        [{ id: "n1", path: ${JSON.stringify(dest)}, parentId: null }],
        "xxhash64", null, null,
        { folderTemplate: "{date}_{operator}", fileTemplate: "",
          fields: [{ key: "operator", label: "Operator", required: true }], values: {} });
      return "NO ERROR";
    } catch (e) { return String(e.message || e); }
  })()`);
  check(/Operator/.test(refused), "main refuses it independently of the UI", refused.slice(0, 90));
  check((await fsp.readdir(dest)).length === 0, "still nothing written");

  await ev(`$("values-backdrop").classList.remove("open"); valuesDone = null; true`);

  // ── 4. A real copy, with the values filled in ──
  console.log("\n4. Real copy job with the preset applied");
  await ev(`presetValues = { operator: "Mathias", camera: "Alexa 35" }; true`);
  const summary = await ev(`(async () => {
    return await window.freeframe.startCopy(${JSON.stringify(source)},
      [{ id: "n1", path: ${JSON.stringify(dest)}, parentId: null }],
      "xxhash64", null, null, namingPayload());
  })()`);

  check(summary.allVerified === true, "copy verified", JSON.stringify({
    files: summary.totalFiles, mismatches: summary.mismatches.length, errors: summary.errors.length }));

  // ── 5. THE ACTUAL CHECK: names on disk ──
  console.log("\n5. Substituted values are on disk");
  // "FreeFrame Logs" is the per-job transfer log the copy now drops in
  // each destination (§18c). Skipped here: this test is about what the
  // NAMING TEMPLATE produced, and counting the log as a copied file would
  // make every assertion below off by one.
  const walk = async (dir, base = "") => {
    const out = [];
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.name === "FreeFrame Logs") continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...await walk(path.join(dir, e.name), rel));
      else out.push(rel);
    }
    return out;
  };
  const onDisk = await walk(dest);
  console.log("     " + onDisk.join("\n     "));

  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const expectedRoot = `${stamp}_Mathias/Alexa 35`;

  check(onDisk.length === 3, "all three files landed", `${onDisk.length}`);
  check(onDisk.every((f) => f.startsWith(expectedRoot + "/")),
    `every file is under "${expectedRoot}"`, onDisk[0]);
  check(onDisk.includes(`${expectedRoot}/DCIM/100MEDIA/CLIP0001.MOV`),
    "the source's own folder structure is preserved beneath it");
  check(onDisk.includes(`${expectedRoot}/notes.txt`), "root-level file too");
  check(!onDisk.some((f) => /[{}]/.test(f)), "no literal {token} survived into a name");

  // ── 6. Values are remembered for the suggesting field ──
  console.log("\n6. Suggesting fields grow their own list");
  const history = await ev(`(async () => (await window.freeframe.listPresets()).history)()`);
  check((history.camera || []).includes("Alexa 35"),
    "the value used is offered next time", JSON.stringify(history.camera || []));
  check((history.operator || []).includes("Mathias"), "text fields are remembered too");

  // ── 7. A file template renames, keeping the extension ──
  console.log("\n7. File-name template");
  const dest2 = path.join(tmp, "RAID2");
  await fsp.mkdir(dest2, { recursive: true });
  const s2 = await ev(`(async () => {
    return await window.freeframe.startCopy(${JSON.stringify(source)},
      [{ id: "n1", path: ${JSON.stringify(dest2)}, parentId: null }],
      "xxhash64", null, null,
      { folderTemplate: "{operator}", fileTemplate: "{operator}_{counter}",
        fields: [{ key: "operator", label: "Operator", required: true }],
        values: { operator: "Mathias" } });
  })()`);
  check(s2.allVerified === true, "renamed copy still verifies");
  const renamed = await walk(dest2);
  console.log("     " + renamed.join("\n     "));
  check(renamed.every((f) => /Mathias_\d{4}\.\w+$/.test(f)), "every file renamed with a counter");
  check(renamed.some((f) => f.endsWith(".MOV")) && renamed.some((f) => f.endsWith(".txt")),
    "original extensions preserved");

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  console.log(`Left on disk for inspection: ${tmp}`);
  child.kill("SIGKILL");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
