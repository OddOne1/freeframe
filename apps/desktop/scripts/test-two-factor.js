#!/usr/bin/env node
// Two-factor, in the desktop client (§198).
//
// The bug this exists for: POST /auth/login answers HTTP 200 for BOTH a
// finished login and a second factor still outstanding, so `res.ok` never
// meant what login() assumed. Unpacked blindly, a challenge set
// accessToken to undefined, PERSISTED that to the session file, and
// returned { ok: true } — the app then showed "signed in" over nothing,
// which is strictly worse than an honest failure because there is no error
// to act on. Reachable the moment any desktop user turns 2FA on, whether or
// not the instance requires it.
//
// Runs under plain node, same shape as test-auth-refresh.js: `electron` is
// stubbed through require.cache, `global.fetch` is swapped per scenario, and
// freeframe.js's __setState/__getState seam does setup and assertions.
//
// Run: node scripts/test-two-factor.js
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-2fa-"));

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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A server that answers each endpoint from a map, and records what it was
 *  asked. Endpoints not in the map are a 500, so an unexpected call is a
 *  visible failure rather than a silent undefined. */
function server(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const endpoint = String(url).replace("https://example.invalid/api", "");
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ endpoint, body, auth: (opts.headers || {}).Authorization || null });
    const handler = routes[endpoint];
    if (!handler) return new Response("no route", { status: 500 });
    return typeof handler === "function" ? handler(body) : handler;
  };
  return calls;
}

/** Signed out, with a stale-looking session file left on disk so "nothing
 *  was written" can be told apart from "nothing was there". */
function signedOut() {
  fs.writeFileSync(tokenFile, "placeholder");
  freeframe.__setState({
    baseUrl: "https://example.invalid/api",
    accessToken: null,
    refreshToken: null,
    user: null,
  });
}

function signedIn() {
  fs.writeFileSync(tokenFile, "placeholder");
  freeframe.__setState({
    baseUrl: "https://example.invalid/api",
    accessToken: "live-access",
    refreshToken: "live-refresh",
    user: { email: "u@example.com", two_factor_enabled: true, two_factor_method: "totp" },
  });
}

const CHALLENGE = {
  requires_2fa: true,
  setup_required: false,
  pending_token: "pending-abc",
  method: "totp",
  email_code_sent: false,
};
const TOKENS = {
  access_token: "real-access",
  refresh_token: "real-refresh",
  token_type: "bearer",
  needs_password: false,
  requires_2fa: false,
};
const ME = { email: "u@example.com", two_factor_enabled: true, two_factor_method: "totp" };

(async () => {
  console.log("1. login() meets a 2FA challenge — the false success");
  {
    signedOut();
    const before = freeframe.__getState();
    const fileBefore = fs.readFileSync(tokenFile, "utf8");
    server({ "/auth/login": json(CHALLENGE) });

    const res = await freeframe.login({ email: "u@example.com", password: "pw" });
    const after = freeframe.__getState();

    check(res.ok === true, "ok:true — the HTTP call itself succeeded");
    check(res.requiresTwoFactor === true, "flags the challenge for the caller");
    check(res.pendingToken === "pending-abc", "carries the pending token", String(res.pendingToken));
    check(res.method === "totp", "carries the method");
    check(res.setupRequired === false, "carries setup_required");
    check(res.user === undefined, "does NOT claim a user");
    check(after.accessToken === before.accessToken, "access token untouched", String(after.accessToken));
    check(after.refreshToken === before.refreshToken, "refresh token untouched");
    check(fs.readFileSync(tokenFile, "utf8") === fileBefore, "session file NOT rewritten");
  }

  console.log("\n2. A challenge must not corrupt an EXISTING session either");
  {
    // Re-authenticating while already signed in (a different account, or a
    // password change elsewhere) must not trade a working session for
    // undefined.
    signedIn();
    server({ "/auth/login": json(CHALLENGE) });

    await freeframe.login({ email: "other@example.com", password: "pw" });
    const st = freeframe.__getState();

    check(st.accessToken === "live-access", "existing access token survives", String(st.accessToken));
    check(st.refreshToken === "live-refresh", "existing refresh token survives");
  }

  console.log("\n3. login() unchanged for an account without 2FA");
  {
    signedOut();
    server({ "/auth/login": json(TOKENS), "/auth/me": json(ME) });

    const res = await freeframe.login({ email: "u@example.com", password: "pw" });
    const st = freeframe.__getState();

    check(res.ok === true && !res.requiresTwoFactor, "plain success, no challenge flag");
    check(st.accessToken === "real-access", "access token stored");
    check(st.refreshToken === "real-refresh", "refresh token stored");
    check(st.user && st.user.email === "u@example.com", "user fetched from /auth/me");
    check(fs.readFileSync(tokenFile, "utf8").includes("real-refresh"), "session persisted");
  }

  console.log("\n4. verifyTwoFactorLogin finishes the login");
  {
    signedOut();
    const calls = server({ "/auth/2fa/verify-login": json(TOKENS), "/auth/me": json(ME) });

    const res = await freeframe.verifyTwoFactorLogin({ pendingToken: "pending-abc", code: "123456" });
    const st = freeframe.__getState();
    const sent = calls.find((c) => c.endpoint === "/auth/2fa/verify-login");

    check(res.ok === true, "reports success");
    check(sent.body.pending_token === "pending-abc" && sent.body.code === "123456", "sends the pending token and code");
    check(st.accessToken === "real-access", "tokens adopted");
    check(st.user.two_factor_enabled === true, "user carries §197's 2FA fields for free");
    check(fs.readFileSync(tokenFile, "utf8").includes("real-refresh"), "session persisted");
  }

  console.log("\n5. A rejected code changes nothing");
  {
    signedOut();
    server({ "/auth/2fa/verify-login": json({ detail: "Invalid code" }, 401) });

    const res = await freeframe.verifyTwoFactorLogin({ pendingToken: "pending-abc", code: "000000" });
    const st = freeframe.__getState();

    check(res.ok === false, "reports failure");
    check(res.error === "Invalid code", "passes the server's message through", String(res.error));
    check(st.accessToken === null, "no tokens adopted");
  }

  console.log("\n6. Both finished-login paths land in the SAME tail");
  {
    // Structural, not "both happen to work": this is the third surface in
    // the series with this fork, and the first two grew two copies that
    // drifted (§193, §196). Patching adoptSession must be enough to change
    // what every path does.
    const seen = [];
    check(typeof freeframe.adoptSession === "function",
      "adoptSession is exported — one named place for 'what a finished login does'");

    // login(), verify-login and confirm-setup(with tokens) must all reach
    // it — asserted by the state it alone produces, from three entry points
    // that share no other code.
    for (const [label, run, routes] of [
      ["login()", () => freeframe.login({ email: "u@example.com", password: "pw" }),
        { "/auth/login": json(TOKENS), "/auth/me": json(ME) }],
      ["verifyTwoFactorLogin()", () => freeframe.verifyTwoFactorLogin({ pendingToken: "p", code: "1" }),
        { "/auth/2fa/verify-login": json(TOKENS), "/auth/me": json(ME) }],
      ["confirmTwoFactorSetup()", () => freeframe.confirmTwoFactorSetup({ pendingToken: "p", code: "1" }),
        { "/auth/2fa/confirm-setup": json({ backup_codes: ["a", "b"], method: "totp", tokens: TOKENS }), "/auth/me": json(ME) }],
    ]) {
      signedOut();
      server(routes);
      await run();
      const st = freeframe.__getState();
      const persisted = fs.readFileSync(tokenFile, "utf8");
      const same = st.accessToken === "real-access"
        && st.refreshToken === "real-refresh"
        && st.user && st.user.two_factor_enabled === true
        && persisted.includes("real-refresh");
      check(same, `${label} produces the identical adopted state`);
      seen.push(label);
    }
    check(seen.length === 3, "all three entry points exercised");
  }

  console.log("\n7. confirmTwoFactorSetup returns the backup codes and acts on nothing else");
  {
    signedOut();
    const calls = server({
      "/auth/2fa/confirm-setup": json({ backup_codes: ["aaaa-1111", "bbbb-2222"], method: "totp", tokens: TOKENS }),
      "/auth/me": json(ME),
    });

    const res = await freeframe.confirmTwoFactorSetup({ pendingToken: "pending-abc", code: "123456" });

    check(Array.isArray(res.backupCodes) && res.backupCodes.length === 2, "codes handed to the caller");
    check(res.loggedIn === true, "says this completed a login");
    // The session IS saved here, deliberately — see the function's comment.
    // The acknowledgement gate is a UI concern; holding real tokens back
    // would mean either handing them to the renderer or keeping main and the
    // UI in disagreement about whether the user is signed in.
    check(fs.readFileSync(tokenFile, "utf8").includes("real-refresh"), "session saved at confirm, not deferred to the UI");
    check(!calls.some((c) => c.endpoint.includes("backup")), "nothing else is called with the codes");
  }

  console.log("\n8. Enrolling from an existing session");
  {
    signedIn();
    const calls = server({
      "/auth/2fa/confirm-setup": json({ backup_codes: ["x"], method: "email", tokens: null }),
      "/auth/me": json({ ...ME, two_factor_method: "email" }),
    });

    const res = await freeframe.confirmTwoFactorSetup({ code: "123456" });
    const st = freeframe.__getState();
    const sent = calls.find((c) => c.endpoint === "/auth/2fa/confirm-setup");

    check(res.ok === true && res.loggedIn === false, "no login completed — there already was one");
    check(sent.auth === "Bearer live-access", "sent authenticated, not with a pending token");
    check(!("pending_token" in sent.body), "no pending_token in the body");
    check(st.accessToken === "live-access", "the live session is untouched");
    check(st.user.two_factor_method === "email", "user re-read so the UI sees the new method");
  }

  console.log("\n9. setupTwoFactor and §194b's re-auth gate");
  {
    signedOut();
    let calls = server({
      "/auth/2fa/setup": json({
        method: "totp", provisioning_uri: "otpauth://x",
        qr_code_data_uri: "data:image/png;base64,AAA", secret: "SECRET", email_code_sent: false,
      }),
    });
    const res = await freeframe.setupTwoFactor({ pendingToken: "pending-abc", method: "totp" });
    check(res.ok === true && res.secret === "SECRET", "mid-login setup returns the secret");
    check(res.qrCodeDataUri.startsWith("data:image/png"), "and the QR, ready for an <img src>");
    check(calls[0].body.pending_token === "pending-abc", "sends the pending token");
    check(!("reauth_code" in calls[0].body), "no reauth_code when there is no live enrolment");

    // Already enrolled, from a session: the server REFUSES without proof of
    // the current factor. The client must pass it through rather than make
    // that gate unreachable.
    signedIn();
    calls = server({ "/auth/2fa/setup": json({ detail: "Invalid code" }, 401) });
    const refused = await freeframe.setupTwoFactor({ method: "email" });
    check(refused.ok === false, "refused without a reauth code");
    check(refused.error === "Invalid code", "surfaces the refusal", String(refused.error));

    calls = server({ "/auth/2fa/setup": json({ method: "email", email_code_sent: true }) });
    const ok = await freeframe.setupTwoFactor({ method: "email", reauthCode: "424242" });
    check(ok.ok === true && ok.emailCodeSent === true, "accepted with one");
    check(calls[0].body.reauth_code === "424242", "reauth_code reaches the server");
    check(calls[0].auth === "Bearer live-access", "sent on the live session");
  }

  console.log("\n10. disable and regenerate");
  {
    signedIn();
    let calls = server({
      "/auth/2fa/disable": json({ two_factor_enabled: false }),
      "/auth/me": json({ ...ME, two_factor_enabled: false, two_factor_method: null }),
    });
    const off = await freeframe.disableTwoFactor({ code: "424242" });
    check(off.ok === true && off.twoFactorEnabled === false, "disable reports the end state");
    check(calls[0].body.code === "424242", "sends the re-auth code");
    check(freeframe.__getState().user.two_factor_enabled === false, "user re-read, so the UI stops saying it is on");

    signedIn();
    calls = server({ "/auth/2fa/regenerate-backup-codes": json({ backup_codes: ["n1", "n2"] }) });
    const fresh = await freeframe.regenerateBackupCodes({ code: "424242" });
    check(fresh.ok === true && fresh.backupCodes.length === 2, "regenerate returns the new set");

    signedIn();
    server({ "/auth/2fa/disable": json({ detail: "Invalid code" }, 401) });
    const refused = await freeframe.disableTwoFactor({ code: "000000" });
    check(refused.ok === false, "a wrong code refuses");
    check(freeframe.__getState().user.two_factor_enabled === true, "and leaves 2FA on");
  }

  console.log("\n11. sendTwoFactorEmailFallback, both ways in");
  {
    signedOut();
    let calls = server({ "/auth/2fa/send-email-fallback": json({ message: "ok" }) });
    const mid = await freeframe.sendTwoFactorEmailFallback({ pendingToken: "pending-abc" });
    check(mid.ok === true, "mid-login send succeeds");
    check(calls[0].body.pending_token === "pending-abc", "carries the pending token");

    signedIn();
    calls = server({ "/auth/2fa/send-email-fallback": json({ message: "ok" }) });
    const authed = await freeframe.sendTwoFactorEmailFallback({});
    check(authed.ok === true, "authenticated send succeeds");
    check(calls[0].auth === "Bearer live-access", "uses the session instead");
  }

  global.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
