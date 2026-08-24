#!/usr/bin/env node
// The renderer half of §23c/§23d, in the real app.
//
// scripts/e2e-filters.js proves the engine's behaviour against files on
// disk. This one covers the two renderer failures that produce no error and
// no test failure anywhere else:
//
//   * a modal backdrop styled by CLASS in a file where every other backdrop
//     is styled by ID sits permanently on top of the app. Nothing throws;
//     the app is simply unusable. This was a real bug in the first draft,
//     caught by reading rather than by running, which is exactly why it is
//     pinned here.
//   * the filtering block writing into the preset draft but never reaching
//     disk, so a configured filter silently does nothing on the next job.
//
// Run: node scripts/e2e-filter-ui.js
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9331;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { execSync(`pkill -f 'remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(1000);

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
  if (!page) { console.error("Electron never came up"); child.kill("SIGKILL"); process.exit(1); }

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

  /** §61 — the preset editor moved into the Settings window, so this
   *  section drives that window instead of the main one. */
  async function attachSettings(tries = 40) {
    for (let i = 0; i < tries; i++) {
      try {
        const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const pg = t.find((x) => x.type === "page" && x.url.includes("settings.html"));
        if (pg?.webSocketDebuggerUrl) {
          const w = new WebSocket(pg.webSocketDebuggerUrl);
          await new Promise((r) => w.addEventListener("open", r));
          let n = 0; const q = new Map();
          w.addEventListener("message", (e) => {
            const m = JSON.parse(e.data);
            if (m.id && q.has(m.id)) { const f = q.get(m.id); q.delete(m.id); f(m.result); }
          });
          const call = (me, pa = {}) => new Promise((res) => {
            const i = ++n; q.set(i, res); w.send(JSON.stringify({ id: i, method: me, params: pa }));
          });
          await call("Runtime.enable");
          return { ws: w, ev: async (x) => (await call("Runtime.evaluate",
            { expression: x, awaitPromise: true, returnByValue: true, timeout: 30000 })).result?.value };
        }
      } catch {}
      await sleep(250);
    }
    return null;
  }

  const pageErrors = [];
  await send("Runtime.enable");
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || "unknown");
    }
  });
  await sleep(1800);

  try {
    console.log("1. Load");
    check(pageErrors.length === 0, "no uncaught exception during load", pageErrors.join(" | "));

    console.log("\n2. The rename-fragility modal is hidden until it is needed");
    const modal = await ev(`(() => {
      const b = document.getElementById("fragile-backdrop");
      if (!b) return { missing: true };
      return {
        display: getComputedStyle(b).display,
        hasOpen: b.classList.contains("open"),
        ackExists: !!document.getElementById("fragile-ack"),
        goDisabled: document.getElementById("fragile-go").disabled,
      };
    })()`);
    check(!modal.missing, "the modal exists");
    check(modal.display === "none", "it is hidden on load — styled by id, like every other backdrop", modal.display);
    check(!modal.hasOpen, "and carries no .open class");
    check(modal.ackExists, "the acknowledgement checkbox is present");
    check(modal.goDisabled, "'Rename anyway' starts disabled — a tick is required, not just a click");

    console.log("\n3. …and it opens, gates on the tick, and resolves");
    const flow = await ev(`(async () => {
      const p = openFragileDialog("test message");
      const b = document.getElementById("fragile-backdrop");
      const shown = getComputedStyle(b).display;
      const body = document.getElementById("fragile-body").textContent;
      const go = document.getElementById("fragile-go");
      const disabledBefore = go.disabled;
      const ack = document.getElementById("fragile-ack");
      ack.checked = true;
      ack.dispatchEvent(new Event("change"));
      const disabledAfter = go.disabled;
      go.click();
      const result = await p;
      return { shown, body, disabledBefore, disabledAfter, result,
               hiddenAfter: getComputedStyle(b).display };
    })()`);
    check(flow.shown === "flex", "opens when asked", flow.shown);
    check(flow.body === "test message", "shows the engine's own explanation");
    check(flow.disabledBefore === true && flow.disabledAfter === false,
      "the button unlocks only once the box is ticked");
    check(flow.result === true, "resolves true when confirmed");
    check(flow.hiddenAfter === "none", "and closes itself");

    const cancelled = await ev(`(async () => {
      const p = openFragileDialog("x");
      document.getElementById("fragile-cancel").click();
      return await p;
    })()`);
    check(cancelled === false, "resolves false when cancelled");

    console.log("\n4. Filtering survives a save/reload round trip");
    // Cleared FIRST, not only at the end: presets live in userData and
    // outlive the process, so a run that dies mid-way leaves one behind and
    // the next run's find-by-name picks up the stale copy instead of what
    // it just wrote. That mimics a pass or a failure that has nothing to do
    // with the code under test.
    await ev(`(async () => {
      const s = await window.freeframe.listPresets();
      for (const p of s.presets.filter((x) => ["Filter Test", "Plain", "Filter Open Test"].includes(x.name))) {
        await window.freeframe.deletePreset(p.id);
      }
      return true;
    })()`);

    const round = await ev(`(async () => {
      const store = await window.freeframe.savePreset({
        name: "Filter Test",
        folderTemplate: "{date}",
        fileTemplate: "",
        fields: [],
        filters: {
          doNotCopyExtensions: ["THM", ".ppn"],
          doNotCopyNames: ["index.mif"],
          ignoreBundles: { extensions: [".rdc"], maxBytes: 1048576 },
          ignoreFolders: { mode: "flatten" },
        },
      });
      const saved = store.presets.find((p) => p.name === "Filter Test");
      const reread = (await window.freeframe.listPresets()).presets.find((p) => p.name === "Filter Test");
      return { saved, reread };
    })()`);
    check(!!round.saved?.filters, "filters are stored on the preset");
    check(JSON.stringify(round.saved.filters.doNotCopyExtensions) === JSON.stringify([".thm", ".ppn"]),
      "extensions normalized on the way in", JSON.stringify(round.saved.filters.doNotCopyExtensions));
    check(round.saved.filters.ignoreFolders.mode === "flatten", "folder mode kept");
    check(JSON.stringify(round.reread?.filters) === JSON.stringify(round.saved.filters),
      "and they survive a reload from disk");

    console.log("\n5. A preset that never opens the section stays unfiltered");
    const plain = await ev(`(async () => {
      const store = await window.freeframe.savePreset({
        name: "Plain", folderTemplate: "{date}", fileTemplate: "", fields: [],
      });
      const p = store.presets.find((x) => x.name === "Plain");
      return p.filters;
    })()`);
    check(plain === null, "filters is null, which the engine treats as no filtering at all",
      JSON.stringify(plain));

    console.log("\n6. The editor renders the section without throwing");
    // Driven through the real UI now that the editor lives in its own
    // window: its draft is private to the module, and poking at it from
    // outside would be testing a shape this no longer has.
    await ev(`document.getElementById("settings-btn").click(); true`);
    const st = await attachSettings();
    check(Boolean(st), "the Settings window opened");
    if (st) {
      await st.ev(`document.querySelector('nav button[data-tab="presets"]').click(); true`);
      for (let i = 0; i < 40 && !(await st.ev(`!!document.getElementById("preset-new")`)); i++) await sleep(200);
      await st.ev(`document.getElementById("preset-new").click(); true`);
      await sleep(400);
      const editor = await st.ev(`(() => {
        const block = document.querySelector(".filter-block");
        return {
          rendered: !!block,
          openByDefault: block ? block.open : null,
          rows: document.querySelectorAll(".filter-block .filter-row").length,
        };
      })()`);
      check(editor && editor.rendered, "the filtering block renders");
      check(editor && editor.openByDefault === false,
        "collapsed by default — it is opt-in, not a decision to make");
      check(editor && editor.rows >= 4, "all four controls are present", String(editor?.rows));

      // A preset that already HAS filtering, selected from the list the
      // same way a user would.
      await ev(`window.freeframe.savePreset({ id: null, name: "Filter Open Test",
        folderTemplate: "{date}", fileTemplate: "", fields: [],
        filters: { doNotCopyExtensions: [".thm"] } })`);
      // The Settings window follows the presets:changed broadcast, so the
      // row appears without this window being told directly.
      for (let i = 0; i < 40; i++) {
        if (await st.ev(`[...document.querySelectorAll("#preset-list button")].some(x => x.textContent.trim() === "Filter Open Test")`)) break;
        await sleep(200);
      }
      const opened = await st.ev(`(() => {
        const b = [...document.querySelectorAll("#preset-list button")]
          .find(x => x.textContent.trim() === "Filter Open Test");
        if (!b) return null;
        b.click();
        const block = document.querySelector(".filter-block");
        return { open: block.open, summary: block.querySelector("summary").textContent };
      })()`);
      check(opened && opened.open === true, "a preset that HAS filtering opens the section on sight");
      check(opened && /ON/.test(opened.summary), "and says so in the heading", opened?.summary);
      try { st.ws.close(); } catch {}
    }

    // Cleanup, so a later run of any other suite doesn't inherit these.
    await ev(`(async () => {
      const s = await window.freeframe.listPresets();
      for (const p of s.presets.filter((x) => ["Filter Test", "Plain"].includes(x.name))) {
        await window.freeframe.deletePreset(p.id);
      }
      return true;
    })()`);

    check(pageErrors.length === 0, "no uncaught exception during the whole run", pageErrors.join(" | "));
  } finally {
    ws.close();
    child.kill("SIGKILL");
  }

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\nHARNESS ERROR", err);
  process.exit(1);
});
