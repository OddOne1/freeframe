#!/usr/bin/env node
// When does a stored FreeFrame session get thrown away?
//
// This exists because the answer used to be "on literally any non-ok
// response, and the token file is deleted too" — so a single 502 from a
// restarting api container at launch signed the user out permanently, with
// nothing to recover from. That failure is invisible in normal use and
// impossible to notice in a test that only ever sees a healthy server, so
// each response class is asserted explicitly.
//
// Runs under plain node. `electron` is stubbed through require.cache
// rather than by booting a window — the only electron surface this module
// touches is app.getPath and safeStorage, both trivially faked.
//
// Run: node scripts/test-auth-refresh.js
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-auth-"));

// Stub electron before freeframe.js is required.
const fakeElectron = {
  app: { getPath: () => tmp },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: (b) => b.toString("utf8"),
  },
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron-stub";
  return realResolve.call(this, request, ...rest);
};
require.cache["electron-stub"] = { id: "electron-stub", filename: "electron-stub", loaded: true, exports: fakeElectron };

const freeframe = require(path.join(__dirname, "..", "src", "main", "freeframe.js"));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const tokenFile = path.join(tmp, "freeframe-session.bin");
const realFetch = global.fetch;

/** Put a session on disk and in memory, then run one refresh against a
 *  server that responds however `respond` says. */
async function scenario(respond) {
  fs.writeFileSync(tokenFile, "placeholder");
  freeframe.__setState({
    baseUrl: "https://example.invalid/api",
    accessToken: null,
    refreshToken: "stored-refresh-token",
    user: { email: "someone@example.com" },
  });
  global.fetch = respond;
  const token = await freeframe.refreshAccessToken();
  const state = freeframe.__getState();
  return { token, state, fileExists: fs.existsSync(tokenFile) };
}

(async () => {
  console.log("1. A healthy refresh");
  {
    const r = await scenario(async () => new Response(
      JSON.stringify({ access_token: "new-access", refresh_token: "rotated-refresh" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    check(r.token === "new-access", "returns the new access token", String(r.token));
    check(r.state.refreshToken === "rotated-refresh", "stores a rotated refresh token");
    check(r.fileExists, "session file kept");
  }

  console.log("\n2. The credential is actually rejected — the session SHOULD go");
  for (const status of [401, 403]) {
    const r = await scenario(async () => new Response(JSON.stringify({ detail: "nope" }), { status }));
    check(r.token === null, `${status}: returns null`);
    check(r.state.refreshToken === null, `${status}: refresh token dropped from memory`);
    check(!r.fileExists, `${status}: session file deleted`);
  }

  console.log("\n3. The SERVER is broken — the session must SURVIVE");
  // The regression this file exists for. Each of these used to delete the
  // token file, which is unrecoverable: relaunching can't help.
  for (const status of [500, 502, 503, 504, 429]) {
    const r = await scenario(async () => new Response("upstream is having a day", { status }));
    check(r.token === null, `${status}: returns null (no token this time)`);
    check(r.state.refreshToken === "stored-refresh-token", `${status}: refresh token KEPT in memory`);
    check(r.fileExists, `${status}: session file KEPT — a retry can still succeed`);
  }

  console.log("\n4. The network is down — the session must survive that too");
  {
    const r = await scenario(async () => { throw new TypeError("fetch failed"); });
    check(r.token === null, "returns null rather than throwing into the caller");
    check(r.state.refreshToken === "stored-refresh-token", "refresh token kept — a laptop offline on a plane stays signed in");
    check(r.fileExists, "session file kept");
  }

  global.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
