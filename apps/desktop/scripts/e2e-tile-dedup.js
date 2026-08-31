#!/usr/bin/env node
// Boot-volume duplicate tile, outline-only roles, menu cleanup (§59).
//
// The priority item is #0: picking two folders on the SAME drive must
// outline that one drive, never sprout extra tiles. It reproduces with a
// synthetic volume list because the real one depends on what is plugged in
// — the bug is in deviceFor's matching, not in enumeration, and driving
// the renderer's own state is what exercises it deterministically.
//
// Run: node scripts/e2e-tile-dedup.js
const { execSync } = require("node:child_process");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9379;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

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
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
    return r.result.value;
  };
  await send("Runtime.enable");
  await sleep(1800);

  /** A boot volume plus one external, as listVolumes() would report them. */
  const setup = (src, dst) => `
    (() => {
      volumes = [
        { name: "Macintosh HD", mountPoint: "/Volumes/Macintosh HD", type: "internal",
          deviceId: "disk1s1", totalBytes: 1e12, freeBytes: 5e11, fileSystem: "APFS" },
        { name: "CARD_A", mountPoint: "/Volumes/CARD_A", type: "removable",
          deviceId: "disk4s1", totalBytes: 1e11, freeBytes: 9e10, fileSystem: "ExFAT" },
      ];
      extraFolders = [${JSON.stringify(src)}, ${JSON.stringify(dst)}];
      sourcePath = ${JSON.stringify(src)};
      sourceFiles = null;
      destNodes = [{ id: "d1", path: ${JSON.stringify(dst)}, parentId: null }];
      render();
      return true;
    })()
  `;

  const tiles = `[...document.querySelectorAll("#zone-volumes .tile")].map(t =>
      (t.querySelector(".tile-name") || {}).textContent || "")`;

  try {
    console.log("0. The duplicate tile (the priority fix)");
    await ev(setup("/Users/me/Downloads", "/Users/me/Desktop"));
    await sleep(300);

    const bootTiles = await ev(tiles);
    check(bootTiles.filter((n) => n.includes("Downloads") || n.includes("Desktop")).length === 0,
      "two boot-drive folders produce NO standalone tiles", JSON.stringify(bootTiles));
    check(bootTiles.filter((n) => n.includes("Macintosh HD")).length === 1,
      "exactly one tile for the drive itself", JSON.stringify(bootTiles));
    check(await ev(`deviceFor("/Users/me/Downloads")`) === "/Volumes/Macintosh HD",
      "a /Users path resolves to the internal volume rather than null",
      "the whole root cause: APFS firmlinks mean it never carries the mount prefix");

    const cls = await ev(`
      [...document.querySelectorAll("#zone-volumes .tile")]
        .find(t => (t.querySelector(".tile-name")||{}).textContent.includes("Macintosh HD")).className
    `);
    check(/role-both/.test(cls), "and it is outlined as holding both roles", cls);

    console.log("1. Externals still work (no regression)");
    await ev(setup("/Volumes/CARD_A/DCIM", "/Volumes/CARD_A/Proxies"));
    await sleep(300);
    const ext = await ev(tiles);
    check(ext.filter((n) => n.includes("DCIM") || n.includes("Proxies")).length === 0,
      "picked folders on an external collapse onto its tile too", JSON.stringify(ext));
    check(await ev(`deviceFor("/Volumes/CARD_A/DCIM")`) === "/Volumes/CARD_A",
      "and the longest-prefix match still wins over the internal fallback");

    console.log("2. Outlines only");
    check(await ev(`document.querySelectorAll(".tile-roles, .tile-role").length`) === 0,
      "no Source/Dest text badge anywhere, in any column");
    check(await ev(`
      (() => {
        const t = [...document.querySelectorAll("#zone-volumes .tile")]
          .find(x => x.className.includes("role-both"));
        return getComputedStyle(t).backgroundImage.includes("repeating-linear-gradient");
      })()
    `), "role-both is repeating diagonal stripes, not a half-and-half split");
    check(await ev(`
      (() => {
        const t = [...document.querySelectorAll("#zone-volumes .tile")]
          .find(x => x.className.includes("role-both"));
        return parseFloat(getComputedStyle(t).borderTopLeftRadius) > 0;
      })()
    `), "and the corners are still round — the reason border-image was avoided");

    console.log("3. Context menu on a source tile");
    const srcMenu = await ev(`
      (() => {
        openMenu({ preventDefault(){}, stopPropagation(){}, clientX: 20, clientY: 20 },
                 "/Volumes/CARD_A/DCIM", "source");
        return [...document.querySelectorAll("#menu button")].map(i => i.textContent.trim());
      })()
    `);
    check(srcMenu.length > 0,
      "the menu rendered at all — every 'is absent' check below is vacuous otherwise",
      `${srcMenu.length} items`);
    check(!srcMenu.some((t) => t === "Set as Source"),
      "own role is gone, not greyed", JSON.stringify(srcMenu));
    check(!srcMenu.some((t) => t.startsWith("Rename")),
      "Rename is gone — the tile name is already click-to-rename");
    check(srcMenu.includes("Remove"), "Remove stays for a source");
    check(srcMenu.includes("Choose a different folder/file…"),
      "and a swap-in-place entry is offered");

    console.log("4. Context menu on a destination tile");
    const dstMenu = await ev(`
      (() => {
        closeMenu();
        openMenu({ preventDefault(){}, stopPropagation(){}, clientX: 20, clientY: 20 },
                 "/Volumes/CARD_A/Proxies", "dest");
        return [...document.querySelectorAll("#menu button")].map(i => i.textContent.trim());
      })()
    `);
    check(dstMenu.length > 0, "the menu rendered at all", `${dstMenu.length} items`);
    check(!dstMenu.some((t) => t === "Set as Destination"), "own role gone", JSON.stringify(dstMenu));
    check(!dstMenu.some((t) => t.startsWith("Rename")), "Rename gone");
    check(!dstMenu.includes("Remove"),
      "Remove is gone entirely for a destination — swap, never clear to empty");
    check(dstMenu.includes("Choose a different folder/file…"), "swap-in-place is how it changes");

    console.log("5. A FreeFrame project keeps its own folder actions");
    const projMenu = await ev(`
      (() => {
        closeMenu();
        ffProjects = [{ id: "p1", name: "Padel", posterUrl: null }];
        destNodes = [{ id: "d9", path: "freeframe://p1", parentId: null }];
        render();
        openMenu({ preventDefault(){}, stopPropagation(){}, clientX: 20, clientY: 20 },
                 "freeframe://p1", "dest");
        return [...document.querySelectorAll("#menu button")].map(i => i.textContent.trim());
      })()
    `);
    check(projMenu.length > 0, "the menu rendered at all", `${projMenu.length} items`);
    check(projMenu.some((t) => /Destination Folder/.test(t)),
      "its §24a submenus are untouched", JSON.stringify(projMenu));
    check(!projMenu.includes("Choose a different folder/file…"),
      "and it does NOT also get the generic swap entry — that ambiguity is what §24a removed");

    // ── §66 — the tile says used or free depending on its role ──────────
    console.log("6b. (\u00a766) Storage shown depends on the tile's role");
    const meta = await ev(`(() => {
      volumes = [
        { name: "S66_Card", mountPoint: "/Volumes/S66_Card", type: "external",
          totalBytes: 512 * 1024 ** 3, freeBytes: 100 * 1024 ** 3 },
        { name: "S66_Raid", mountPoint: "/Volumes/S66_Raid", type: "external",
          totalBytes: 8 * 1024 ** 4, freeBytes: 3 * 1024 ** 4 },
        { name: "S66_Idle", mountPoint: "/Volumes/S66_Idle", type: "external",
          totalBytes: 4 * 1024 ** 4, freeBytes: 1 * 1024 ** 4 },
        // A network volume reports no sizes at all.
        { name: "S66_Nas", mountPoint: "/Volumes/S66_Nas", type: "network",
          totalBytes: null, freeBytes: null },
        // And the half-reported case: free known, total missing. Without a
        // separate fixture the total-is-null guard is unreachable, since
        // the free-is-null check above would already have returned.
        // (No backticks in here — this comment lives inside a template
        // literal, and one would end it.)
        { name: "S66_Half", mountPoint: "/Volumes/S66_Half", type: "network",
          totalBytes: null, freeBytes: 50 * 1024 ** 3 },
      ];
      ffProjects = [{ id: "s66", name: "S66_Project", asset_count: 7 }];
      extraFolders = [];
      clearAll();
      render();
      setSource("/Volumes/S66_Card");
      addDest("/Volumes/S66_Raid", null);
      // A network share as a second destination: the free-is-null guard is
      // only observable HERE, because the dest branch returns before the
      // total-is-null check that would otherwise cover for it.
      addDest("/Volumes/S66_Nas", null);
      render();
      const pick = (zone, name) => {
        const t = [...document.querySelectorAll(zone + " .tile")]
          .find(x => (x.querySelector(".tile-name") || {}).textContent === name);
        if (!t) return null;
        const m = t.querySelector(".tile-meta");
        return { text: m.textContent, clipped: m.scrollWidth > m.clientWidth + 1,
                 twoLine: m.classList.contains("two-line") };
      };
      return {
        source: pick("#zone-source", "S66_Card"),
        dest: pick("#zone-dest", "S66_Raid"),
        idle: pick("#zone-volumes", "S66_Idle"),
        nasDest: pick("#zone-dest", "S66_Nas"),
        project: pick("#zone-volumes", "S66_Project"),
        half: pick("#zone-volumes", "S66_Half"),
      };
    })()`);

    // 512 total - 100 free = 412 used. Asserting the NUMBER, not just the
    // word: showing free space labelled "used" would pass a word check.
    check(meta.source && meta.source.text === "412.0 GB used",
      "a source shows what the card HOLDS — that is what is about to be copied",
      meta.source && meta.source.text);
    check(meta.dest && meta.dest.text === "3.0 TB free",
      "a destination still shows what REMAINS, unchanged", meta.dest && meta.dest.text);
    check(meta.idle && /3\.0 TB used/.test(meta.idle.text) && /1\.0 TB free/.test(meta.idle.text),
      "an unassigned tile shows both, since neither question has been asked yet",
      meta.idle && JSON.stringify(meta.idle.text));
    // The Volumes column caps tiles at 118px (§22f) and the pair does not
    // fit on one line there — it ellipsised the free figure away entirely
    // before this wrapped.
    check(meta.idle && meta.idle.twoLine && !meta.idle.clipped,
      "on two lines, so neither figure is ellipsised away",
      meta.idle && JSON.stringify(meta.idle));
    check(meta.nasDest && meta.nasDest.text === "/Volumes/S66_Nas",
      "a destination reporting no sizes falls back to its mount point, not \u201c\u2014 free\u201d",
      meta.nasDest && meta.nasDest.text);
    check(meta.half && meta.half.text === "/Volumes/S66_Half",
      "a volume that reports free but not total also falls back — used cannot be computed",
      meta.half && meta.half.text);
    check(meta.project && meta.project.text === "7 assets",
      "and a FreeFrame project is untouched", meta.project && meta.project.text);

    // ── §69 — Destination "Choose folder…" narrows, it does not duplicate ─
    console.log("6c. (\u00a769) Choose folder narrows a same-drive destination");
    const narrow = await ev(`(async () => {
      volumes = [
        { name: "S69_Main", mountPoint: "/Volumes/S69_Main", type: "internal",
          totalBytes: 1e12, freeBytes: 5e11 },
        { name: "S69_Shuttle", mountPoint: "/Volumes/S69_Shuttle", type: "external",
          totalBytes: 2e12, freeBytes: 1e12 },
      ];
      // Stubbed so the scenario does not depend on what is plugged in; the
      // real deviceFor resolves a path to its volume the same way.
      deviceFor = (p) => p.startsWith("/Volumes/S69_Shuttle") ? "/Volumes/S69_Shuttle"
                       : p.startsWith("/Volumes/S69_Main") ? "/Volumes/S69_Main" : null;
      const pick = (f) => { pickFolder = async () => {
        if (!extraFolders.includes(f)) extraFolders.push(f);
        return f;
      }; };
      const press = () => document.querySelector('[data-choose="dest"]').click();
      const snap = () => ({
        tops: destNodes.filter(n => n.parentId === null).map(n => n.path),
        total: destNodes.length,
        // §92 — the counts are icon+number groups now, so the arrow is an
        // SVG and textContent no longer carries it. aria-label is where the
        // same statement lives, and is what a screen reader is given.
        label: document.getElementById("start").getAttribute("aria-label") || "",
      });
      const out = {};

      // The recorded repro: whole drive, then a folder ON that drive.
      clearAll(); render();
      addDest("/Volumes/S69_Main", null); render();
      out.before = snap();
      pick("/Volumes/S69_Main/Desktop"); press();
      await new Promise(r => setTimeout(r, 350));
      out.same = snap();

      // A folder on a DIFFERENT drive is still a new parallel destination.
      clearAll(); render();
      addDest("/Volumes/S69_Main", null); render();
      pick("/Volumes/S69_Shuttle/Dailies"); press();
      await new Promise(r => setTimeout(r, 350));
      out.different = snap();

      // Picking a second folder on the SAME drive narrows again rather than
      // stacking up — the bug was cumulative, not a one-off.
      pick("/Volumes/S69_Shuttle/Other"); press();
      await new Promise(r => setTimeout(r, 350));
      out.twice = snap();

      // Re-picking the folder that is ALREADY the destination. addDest
      // returns early for a path it already holds, so without a guard the
      // follow-up removeDest would delete it and leave Destination empty.
      clearAll(); render();
      addDest("/Volumes/S69_Main/Desktop", null); render();
      pick("/Volumes/S69_Main/Desktop"); press();
      await new Promise(r => setTimeout(r, 350));
      out.samePath = snap();

      // A CASCADED node is not a narrowing candidate: it copies FROM
      // another destination rather than from the source, so replacing it
      // would silently restructure the chain.
      clearAll(); render();
      addDest("/Volumes/S69_Main", null);
      addDest("/Volumes/S69_Shuttle", null);
      cascadeFrom("/Volumes/S69_Shuttle", destNodes[0].id); render();
      pick("/Volumes/S69_Shuttle/Leg"); press();
      await new Promise(r => setTimeout(r, 350));
      out.cascadeKept = {
        nodes: destNodes.map(n => ({ p: n.path, hasParent: n.parentId !== null })),
        total: destNodes.length,
      };

      // And narrowing a node that IS a cascade parent promotes its
      // children, because removeDest re-parents rather than dropping them.
      clearAll(); render();
      addDest("/Volumes/S69_Main", null);
      addDest("/Volumes/S69_Shuttle", null);
      cascadeFrom("/Volumes/S69_Shuttle", destNodes[0].id); render();
      pick("/Volumes/S69_Main/Desktop"); press();
      await new Promise(r => setTimeout(r, 350));
      out.parentNarrowed = destNodes.map(n => ({ p: n.path, hasParent: n.parentId !== null }));
      return out;
    })()`);

    check(narrow.before.tops.length === 1, "one destination after the drag", JSON.stringify(narrow.before.tops));
    check(narrow.same.tops.length === 1 && narrow.same.tops[0] === "/Volumes/S69_Main/Desktop",
      "picking a folder on that same drive NARROWS it — one tile, not two",
      JSON.stringify(narrow.same.tops));
    // The recording's own tell: the button read "Copy & Verify -> 2".
    check(!/2 destinations/.test(narrow.same.label),
      "and Copy & Verify does not report a second leg", narrow.same.label || "(no count shown)");
    check(narrow.different.tops.length === 2,
      "a folder on a DIFFERENT drive still adds a parallel destination",
      JSON.stringify(narrow.different.tops));
    check(/2 destinations/.test(narrow.different.label),
      "and that one does report two legs", narrow.different.label);
    check(narrow.twice.tops.length === 2
      && narrow.twice.tops.includes("/Volumes/S69_Shuttle/Other")
      && !narrow.twice.tops.includes("/Volumes/S69_Shuttle/Dailies"),
      "narrowing is repeatable — the second pick replaces the first, it does not stack",
      JSON.stringify(narrow.twice.tops));

    check(narrow.samePath.tops.length === 1
      && narrow.samePath.tops[0] === "/Volumes/S69_Main/Desktop",
      "re-picking the folder already set keeps it — it does not empty the Destination column",
      JSON.stringify(narrow.samePath.tops));

    // INVERTED BY §89, not deleted. §73 exempted cascaded nodes from
    // narrowing on the reasoning that a cascade copies from another
    // destination rather than the source. §89 found that leaves the same
    // duplicate-tile bug reachable through the cascade's own "Destination
    // Folder" item, and made it narrow like any other node — keeping its
    // parent, so it still copies from that parent, just into a subfolder.
    const cascaded = narrow.cascadeKept.nodes.find((n) => n.p === "/Volumes/S69_Shuttle/Leg");
    check(Boolean(cascaded) && cascaded.hasParent,
      "a cascaded node narrows into the picked folder AND stays cascaded (§89)",
      JSON.stringify(narrow.cascadeKept.nodes));
    check(!narrow.cascadeKept.nodes.some((n) => n.p === "/Volumes/S69_Shuttle"),
      "…with the unnarrowed node gone rather than left beside it",
      JSON.stringify(narrow.cascadeKept.nodes));
    check(narrow.cascadeKept.total === 2,
      "so picking a folder on its drive narrows rather than adding a third leg",
      String(narrow.cascadeKept.total));

    // Recorded rather than discovered later: narrowing a node that IS a
    // cascade parent promotes its children to top level, because
    // removeDest re-parents them. Identical to what the context-menu
    // "Choose a different folder/file…" path has always done — verified
    // against that path directly — so it is inherited, not introduced.
    check(narrow.parentNarrowed.every((n) => !n.hasParent),
      "narrowing a cascade PARENT promotes its children, matching the context-menu path",
      JSON.stringify(narrow.parentNarrowed));

    // Asserted at the SOURCE, and labelled as such: add-before-remove only
    // differs from remove-before-add if something throws between the two,
    // so the final state is identical either way and no runtime probe can
    // tell them apart. The spec asks for this order so a failure leaves the
    // destination populated rather than empty.
    const src = require("node:fs").readFileSync(
      path.join(APP, "src", "renderer", "index.html"), "utf8");
    // Bounded by the end of addDest, NOT by a byte count. The previous
    // version took a fixed 1400-char window, which §89 pushed the second
    // marker out of: indexOf then returned -1 and `1182 < -1` failed while
    // the code was correct the whole time. Both markers are asserted found,
    // so a marker that moves fails as a missing marker rather than as a
    // false ordering verdict.
    const addDestAt = src.indexOf("\u00a773 — picking a folder on a drive");
    const block = src.slice(addDestAt, src.indexOf("\n    function ", addDestAt));
    const pushAt = block.indexOf("destNodes.push(");
    const dropAt = block.indexOf("removeDest(narrowed.path)");
    check(pushAt !== -1 && dropAt !== -1,
      "addDest still both adds and drops (markers present)", `push ${pushAt}, drop ${dropAt}`);
    check(pushAt !== -1 && dropAt !== -1 && pushAt < dropAt,
      "the new destination is added BEFORE the old one is dropped (source-level check)");

    // ── §73 — the rule lives in addDest(), so every entry point has it ───
    // §69 wrote this logic at ONE of nine call sites. The identical bug
    // then resurfaced through the tile context menu, which §69 never
    // touched. What is checked here is not "the context menu was also
    // patched" but that each independent entry point inherits the rule —
    // the distinction that stops the tenth call site reintroducing it.
    console.log("6d. (\u00a773) Every destination entry point narrows");
    const every = await ev(`(async () => {
      volumes = [
        { name: "S73_Main", mountPoint: "/Volumes/S73_Main", type: "internal",
          totalBytes: 1e12, freeBytes: 5e11 },
        { name: "S73_Shuttle", mountPoint: "/Volumes/S73_Shuttle", type: "external",
          totalBytes: 2e12, freeBytes: 1e12 },
      ];
      // Mirrors the REAL deviceFor, fallback included: it ends in
      // \`best || internal\`, so a path it cannot place — a freeframe:// URI
      // among them — resolves to the internal volume rather than to null.
      // A stub that returned null there would quietly hide the project
      // hazard this section exists to pin.
      deviceFor = (p) => p.startsWith("/Volumes/S73_Shuttle") ? "/Volumes/S73_Shuttle"
                       : "/Volumes/S73_Main";
      const tops = () => destNodes.filter(n => n.parentId === null).map(n => n.path);
      const seed = (p) => { clearAll(); addDest(p, null); render(); };
      // The third argument is which COLUMN the tile was right-clicked in.
      // Several entries are gated on it — "Choose a different folder/file…"
      // is only offered on a tile that actually holds a role — so passing
      // undefined silently tests a different menu than the user sees.
      const menuOn = (p, role) => {
        closeMenu();
        openMenu({ preventDefault(){}, clientX: 40, clientY: 40 }, p, role);
      };
      const clickItem = (label) => {
        const b = [...document.querySelectorAll("#menu button")]
          .find(x => x.textContent.trim().replace(/\u2026$/, "") === label.replace(/\u2026$/, ""));
        if (!b) return false;
        b.click();
        return true;
      };
      const out = {};

      // ── The recorded repro: tile menu → Destination Folder ▸ → a recent.
      // Driven through the real submenu rather than by calling addDest,
      // because "the menu wires apply() straight to addDest" was exactly
      // the gap.
      // Through the app's own recorder, so the submenu reads it the same
      // way it reads a folder the user really picked.
      rememberRecent("/Volumes/S73_Main", "destination",
        "/Volumes/S73_Main/01_Projects/ReShuffle");
      seed("/Volumes/S73_Main");
      menuOn("/Volumes/S73_Main");
      const trigger = [...document.querySelectorAll("#menu .sub-trigger")]
        .find(x => /Destination Folder/.test(x.textContent));
      out.submenuFound = Boolean(trigger);
      if (trigger) trigger.click();
      const recent = [...document.querySelectorAll("#menu .submenu button")]
        .find(x => /ReShuffle/.test(x.textContent));
      out.recentFound = Boolean(recent);
      out.menuDump = [...document.querySelectorAll("#menu button")]
        .map(x => x.textContent.trim()).join(" | ");
      if (recent) recent.click();
      await new Promise(r => setTimeout(r, 250));
      out.viaRecent = { tops: tops(), // §92 — the counts are icon+number groups now, so the arrow is an
        // SVG and textContent no longer carries it. aria-label is where the
        // same statement lives, and is what a screen reader is given.
        label: document.getElementById("start").getAttribute("aria-label") || "" };
      closeMenu();

      // ── Its "Browse…" sibling, same submenu, separate wiring.
      pickFolder = async () => "/Volumes/S73_Main/Browsed";
      seed("/Volumes/S73_Main");
      menuOn("/Volumes/S73_Main");
      const t2 = [...document.querySelectorAll("#menu .sub-trigger")]
        .find(x => /Destination Folder/.test(x.textContent));
      if (t2) t2.click();
      const browse = [...document.querySelectorAll("#menu .submenu button")]
        .find(x => /^Browse/.test(x.textContent.trim()));
      out.browseFound = Boolean(browse);
      if (browse) browse.click();
      await new Promise(r => setTimeout(r, 300));
      out.viaBrowse = { tops: tops() };
      closeMenu();

      // ── "Set as Destination" on a subfolder tile of a drive already held.
      seed("/Volumes/S73_Main");
      if (!extraFolders.includes("/Volumes/S73_Main/Sub")) extraFolders.push("/Volumes/S73_Main/Sub");
      render();
      menuOn("/Volumes/S73_Main/Sub");
      out.setAsFound = clickItem("Set as Destination");
      await new Promise(r => setTimeout(r, 200));
      out.viaSetAs = { tops: tops() };
      closeMenu();

      // ── Dragging a tile onto the Destination zone.
      seed("/Volumes/S73_Main");
      addDest("/Volumes/S73_Main/Dragged", null);
      out.viaDrag = { tops: tops() };

      // ── "Also use as Destination\u2026", offered on a tile that holds the
      // SOURCE role. Its own separate wiring, and the one path where the
      // dual-role modal can also fire — so what is checked is that the
      // narrowing happened, not that nothing else did.
      // It lives in the isVolume branch, so the source has to be a drive
      // root — a subfolder tile is not offered it at all.
      clearAll();
      setSource("/Volumes/S73_Shuttle");
      addDest("/Volumes/S73_Main/Old", null);
      render();
      menuOn("/Volumes/S73_Shuttle");
      out.alsoFound = clickItem("Also use as Destination\u2026");
      await new Promise(r => setTimeout(r, 200));
      out.viaAlso = { tops: tops() };
      closeMenu();
      // Same drive on both sides now, so a narrowing pick on THAT drive
      // must still land — the shuttle is the source, the main drive is not.
      setSource(null); sourcePath = null; sourceFiles = null;
      closeModal && closeModal();

      // ── Negative case, and the one that must NOT collapse: a genuinely
      // different drive is still a second parallel destination.
      seed("/Volumes/S73_Main");
      addDest("/Volumes/S73_Shuttle/Dailies", null);
      out.differentDrive = { tops: tops(), // §92 — the counts are icon+number groups now, so the arrow is an
        // SVG and textContent no longer carries it. aria-label is where the
        // same statement lives, and is what a screen reader is given.
        label: document.getElementById("start").getAttribute("aria-label") || "" };

      // ── A cascaded child shares its parent's device by necessity. If
      // narrowing applied to it, chaining a drive to itself would eat the
      // parent it copies from.
      clearAll();
      addDest("/Volumes/S73_Main", null);
      const parent = destNodes[0].id;
      addDest("/Volumes/S73_Main/Leg", parent);
      render();
      out.cascadeChild = destNodes.map(n => ({ p: n.path, child: n.parentId !== null }));

      // ── Projects, both directions. deviceFor() falls back to the
      // internal volume for anything it cannot place, so a freeframe:// URI
      // resolves to a REAL mount point — without an explicit exclusion a
      // project would evict a boot-drive folder and vice versa.
      ffProjects = [{ id: "p73", name: "Proj 73", assetCount: 3 }];
      clearAll();
      addDest("/Volumes/S73_Main/Keep", null);
      addDest("freeframe://p73", null);
      out.projectAdded = tops();
      clearAll();
      addDest("freeframe://p73", null);
      addDest("/Volumes/S73_Main/Keep", null);
      out.projectKept = tops();
      ffProjects = [];

      // ── The PRE-EXISTING "Choose a different folder/file…" handler,
      // which §73 deliberately did not touch. It does its own
      // addDest(f) + removeDest(path), so now that addDest narrows on its
      // own there is a shape where it evicts one node and the handler's
      // own removeDest then drops a SECOND — losing a destination the user
      // never asked to lose. Driven rather than reasoned about.
      pickFolder = async () => "/Volumes/S73_Main/Swapped";
      clearAll();
      addDest("/Volumes/S73_Main/Old", null);
      addDest("/Volumes/S73_Shuttle/Keep", null);
      render();
      menuOn("/Volumes/S73_Main/Old", "dest");
      out.chooseDifferentFound = clickItem("Choose a different folder/file\u2026");
      await new Promise(r => setTimeout(r, 350));
      out.chooseDifferent = tops();
      closeMenu();

      // ── No volumes enumerated at all. The real deviceFor returns
      // \`best || internal\`, i.e. null when there is nothing to place a
      // path against — which is the app's own state before the first
      // listVolumes resolves. Without the null guard, dev === null would
      // compare equal to every other unplaceable node and the second
      // destination would evict the first.
      const realVolumes = volumes;
      volumes = [];
      deviceFor = (p) => null;
      clearAll();
      addDest("/tmp/s73/one", null);
      addDest("/tmp/s73/two", null);
      out.noVolumes = tops();
      volumes = realVolumes;

      clearAll(); render();
      return out;
    })()`);

    check(every.chooseDifferentFound, "the tile menu still offers \"Choose a different folder/file\u2026\"");
    check(every.chooseDifferent.length === 2
      && every.chooseDifferent.includes("/Volumes/S73_Main/Swapped")
      && every.chooseDifferent.includes("/Volumes/S73_Shuttle/Keep")
      && !every.chooseDifferent.includes("/Volumes/S73_Main/Old"),
      "\u2026and it swaps ONE tile — addDest's narrowing plus its own removeDest do not drop two",
      JSON.stringify(every.chooseDifferent));

    check(every.noVolumes.length === 2,
      "with no volumes enumerated, two destinations stay two — nothing is placeable, so nothing narrows",
      JSON.stringify(every.noVolumes));

    check(every.submenuFound && every.recentFound,
      "the tile menu's Destination Folder submenu offers the recent folder",
      every.menuDump);
    check(every.viaRecent.tops.length === 1
      && every.viaRecent.tops[0] === "/Volumes/S73_Main/01_Projects/ReShuffle",
      "a Recent Folders pick NARROWS the drive it is on — the recorded bug",
      JSON.stringify(every.viaRecent.tops));
    check(!/2 destinations/.test(every.viaRecent.label),
      "and Copy & Verify does not report a second leg", every.viaRecent.label || "(no count shown)");
    check(every.browseFound && every.viaBrowse.tops.length === 1
      && every.viaBrowse.tops[0] === "/Volumes/S73_Main/Browsed",
      "so does that submenu's own Browse\u2026, which is separately wired",
      JSON.stringify(every.viaBrowse.tops));
    check(every.setAsFound && every.viaSetAs.tops.length === 1
      && every.viaSetAs.tops[0] === "/Volumes/S73_Main/Sub",
      "so does \"Set as Destination\" on a subfolder of a drive already held",
      JSON.stringify(every.viaSetAs.tops));
    check(every.viaDrag.tops.length === 1 && every.viaDrag.tops[0] === "/Volumes/S73_Main/Dragged",
      "and so does dropping a tile straight onto the Destination zone",
      JSON.stringify(every.viaDrag.tops));
    check(every.alsoFound, "\"Also use as Destination\u2026\" is offered on a source drive tile");
    check(every.viaAlso.tops.length === 2
      && every.viaAlso.tops.includes("/Volumes/S73_Shuttle")
      && every.viaAlso.tops.includes("/Volumes/S73_Main/Old"),
      "\u2026and it adds beside a destination on a DIFFERENT drive, not over it",
      JSON.stringify(every.viaAlso.tops));

    // The OS drag-and-drop handler is the one entry point no synthetic
    // event can reach — Electron populates the drop's file list from the
    // real Finder, which CDP cannot forge (the same limitation
    // e2e-copy.js's own header records). Asserted at the source instead,
    // and labelled as such: what matters is that it reaches addDest()
    // plainly, i.e. that it has no private copy of the rule to drift.
    // §89 changed the call from `addDest(folder, null)` to `addDest(folder)`:
    // the omitted argument is a sentinel meaning "narrow if there is
    // something to narrow, and let the replacement inherit that node's
    // parent", which an explicit null would have overridden. Matched on the
    // call rather than on its exact arity, since the property under test is
    // that this path holds no private copy of the rule.
    const dropHandler = src.slice(src.indexOf("A destination has to be a folder to copy into"));
    const callAt = dropHandler.search(/addDest\(folder[,)]/);
    check(callAt !== -1, "the OS drop handler still reaches addDest at all", String(callAt));
    const dropBody = dropHandler.slice(0, callAt + 30);
    check(callAt !== -1 && !dropBody.includes("removeDest"),
      "the OS drop handler adds plainly and inherits the rule (source-level check)");

    check(every.differentDrive.tops.length === 2,
      "a genuinely different drive is STILL a second parallel destination",
      JSON.stringify(every.differentDrive.tops));
    check(/2 destinations/.test(every.differentDrive.label),
      "and that one does report two legs", every.differentDrive.label);

    check(every.cascadeChild.length === 2
      && every.cascadeChild.some(n => n.p === "/Volumes/S73_Main" && !n.child)
      && every.cascadeChild.some(n => n.p === "/Volumes/S73_Main/Leg" && n.child),
      "a cascaded child never narrows the parent whose device it shares",
      JSON.stringify(every.cascadeChild));

    check(every.projectAdded.length === 2 && every.projectAdded.includes("/Volumes/S73_Main/Keep"),
      "assigning a project does not evict a folder on the boot drive",
      JSON.stringify(every.projectAdded));
    check(every.projectKept.length === 2 && every.projectKept.includes("freeframe://p73"),
      "and a boot-drive folder does not evict a project",
      JSON.stringify(every.projectKept));

    console.log("6. The panel's Clear controls exist in both windows");
    check(await ev(`!!document.getElementById("jobs-clear")`), "docked panel has Clear");
    const panelSrc = require("node:fs").readFileSync(
      path.join(APP, "src", "renderer", "panel.html"), "utf8");
    check(/id="clear"/.test(panelSrc) && /clearFinishedJobs/.test(panelSrc),
      "and so does the detached window");
    const js = require("node:fs").readFileSync(
      path.join(APP, "src", "renderer", "panel.js"), "utf8");
    check(/job-remove/.test(js) && /onRemove/.test(js),
      "renderJobs emits a per-row remove");
    // Ordering again, and again NOT by a fixed gap: §95's Pause/Resume and
    // §96's "Cancelling…" landed between these two markers and grew the
    // distance from under 400 characters to over 1200. What matters is that
    // the remove branch is an `else if` reached only when the job is not
    // running or queued — the distance between them is not the property.
    const cancelAt = js.indexOf(`status === "running" || j.status === "queued"`);
    const removeAt = js.indexOf("else if (onRemove)", cancelAt);
    check(cancelAt !== -1 && removeAt !== -1 && cancelAt < removeAt,
      "and only ever instead of Cancel, never alongside it",
      `cancel ${cancelAt}, remove ${removeAt}`);
  } finally {
    try { ws.close(); } catch {}
    try { child.kill(); } catch {}
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
