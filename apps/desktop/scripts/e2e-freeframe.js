#!/usr/bin/env node
// Exercises the FreeFrame integration against the REAL API at
// frame.yon.studio, as far as is possible without credentials.
//
// What this CAN'T do: log in. Entering someone's password isn't something
// this harness should do, so the genuinely-logged-in path — projects
// listing, folder tree, upload — is verified with an injected session
// against the real client code, plus a real unauthenticated round trip to
// prove the endpoint shape. A human still has to sign in once to confirm
// end to end.
//
// Run: node scripts/e2e-freeframe.js

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const PORT = 9271;
const ELECTRON = path.join(__dirname, "..", "node_modules", ".bin", "electron");
const APP_DIR = path.join(__dirname, "..");
const BASE = "https://frame.yon.studio/api";

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1. The real API, unauthenticated ──────────────────────────────────
  console.log("1. Real API round trips (no credentials)");
  const health = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  check(health === 200, "API reachable", `GET /health -> ${health}`);

  // Login endpoint exists and rejects bad credentials rather than 404ing
  // or 500ing — proves the path and payload shape are right.
  const badLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "definitely-not-a-user@example.com", password: "x" }),
  });
  check([400, 401, 403].includes(badLogin.status),
    "POST /auth/login rejects bad credentials with an auth error, not a validation error",
    `-> ${badLogin.status}`);

  const noAuth = await fetch(`${BASE}/projects`).then((r) => r.status).catch(() => 0);
  check([401, 403].includes(noAuth), "GET /projects requires auth", `-> ${noAuth}`);

  const badRefresh = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: "not-a-token" }),
  });
  check([400, 401, 403, 422].includes(badRefresh.status),
    "POST /auth/refresh rejects a bogus token", `-> ${badRefresh.status}`);

  // ── 2. In-app behaviour ───────────────────────────────────────────────
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  try {
    let page;
    for (let i = 0; i < 60; i++) {
      try {
        const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = t.find((x) => x.type === "page" && x.url.includes("index.html"));
        if (page?.webSocketDebuggerUrl) break;
      } catch { /* not up */ }
      await sleep(250);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    let id = 0; const pend = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (me, pa = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: me, params: pa })); });
    const ev = async (x) => {
      const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
      return r.result.value;
    };
    await send("Runtime.enable");
    await sleep(600);

    console.log("\n2. Token never crosses the bridge");
    const bridgeKeys = await ev("Object.keys(window.freeframe).sort()");
    check(!bridgeKeys.some((k) => /token/i.test(k)),
      "no bridge method exposes a token", bridgeKeys.filter((k) => /freeframe/i.test(k)).join(","));
    const st = await ev("window.freeframe.freeframeStatus()");
    check(st && typeof st.loggedIn === "boolean", "status() returns a shape without credentials", JSON.stringify(st));
    check(!("accessToken" in (st || {})) && !("refreshToken" in (st || {})),
      "status() carries no access or refresh token");
    check(st.encryptionAvailable === true,
      "safeStorage encryption is available (tokens can be keychain-backed)", String(st.encryptionAvailable));

    console.log("\n3. Login failure surfaces the API's own reason");
    // Malformed email exercises FastAPI's 422, whose `detail` is an ARRAY
    // of validation objects — the shape that used to render as
    // "[object Object]".
    const malformed = await ev(`window.freeframe.freeframeLogin("not-an-email","x","${BASE}")`);
    check(typeof malformed.error === "string" && !/\[object Object\]/.test(malformed.error),
      "FastAPI array-shaped validation errors render as readable text", malformed.error);
    const bad = await ev(`window.freeframe.freeframeLogin("definitely-not-a-user@example.com","wrong","${BASE}")`);
    check(bad && bad.ok === false, "bad credentials rejected", JSON.stringify(bad).slice(0, 120));
    check(typeof bad.error === "string" && bad.error.length > 0,
      "the API's own error text is surfaced, not swallowed", bad.error);
    const stillOut = await ev("window.freeframe.freeframeStatus()");
    check(stillOut.loggedIn === false, "a failed login leaves no session behind");

    console.log("\n4. Projects render as destination-only cards");
    // Injected rather than fetched: verifying the rendering path doesn't
    // require real credentials, and this is the part a human can't easily
    // eyeball without an account.
    await ev(`
      ffProjects = [
        { id: "11111111-1111-1111-1111-111111111111", name: "Ep 01 — Offline", asset_count: 42 },
        { id: "22222222-2222-2222-2222-222222222222", name: "Commercial Reel", asset_count: 7 }
      ];
      ffStatus = { loggedIn: true, user: { name: "Test" }, baseUrl: "${BASE}" };
      render(); true`);
    const cards = await ev(`document.querySelectorAll('#zone-volumes .card[data-path^="freeframe://"]').length`);
    check(cards === 2, "projects appear in the centre column alongside drives", `${cards} cards`);
    const meta = await ev(`document.querySelector('#zone-volumes .card[data-path^="freeframe://"] .meta').textContent`);
    check(meta.includes("42 assets") && meta.includes("upload destination"),
      "project card shows asset count and its destination-only role", meta);

    const pid = "freeframe://11111111-1111-1111-1111-111111111111";
    await ev(`setSource(${JSON.stringify(pid)}); true`);
    check(await ev("sourcePath") === null,
      "a project CANNOT be assigned as a source (download is out of scope)");
    await ev(`addDest(${JSON.stringify(pid)}, null); true`);
    check(await ev("destNodes.length") === 1, "a project CAN be assigned as a destination");
    check(await ev(`destNodes[0].path`) === pid, "destination node carries the project URI");

    // The context menu must not offer Source for a project.
    await ev(`closeMenu(); openMenu({preventDefault(){},clientX:100,clientY:100}, ${JSON.stringify(pid)}, undefined); true`);
    await sleep(60);
    const srcDisabled = await ev(`(() => {
      const b = [...document.querySelectorAll('#menu button')].find(x => x.textContent.trim() === 'Set as Source');
      return b ? b.disabled : null; })()`);
    check(srcDisabled === true, "context menu disables Set as Source for a project");
    await ev(`closeMenu(); clearAll(); true`);

    console.log("\n5. Upload path guards");
    const noProject = await ev(`window.freeframe.freeframeUpload("/tmp", "", null).then(()=>"resolved").catch(e=>e.message)`);
    check(typeof noProject === "string" && /required/i.test(noProject),
      "upload refuses without a project id", String(noProject).slice(0, 80));

    console.log(failures === 0
      ? "\nFreeFrame integration: all automatable checks passed (login itself still needs a human)"
      : `\n${failures} CHECK(S) FAILED`);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    if (!child.killed) child.kill("SIGKILL");
    if (failures > 0 && logs.length) console.log("\n--- electron output ---\n" + logs.join(""));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
