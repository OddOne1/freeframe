#!/usr/bin/env node
// Two-factor parity with the web (§206), in the real Settings window.
//
// §205 fixed four defects on the web and flagged the desktop as unexamined.
// All four were present here, and three of them then behaved DIFFERENTLY from
// the web, which is worse than both being broken:
//
//   * `promptForCode` stripped every non-digit and refused anything under six,
//     while four of its callers said "a backup code works too" and
//     showBackupCodes had just asked the user to save ten of them. The app
//     issued credentials it could not accept, and the login challenge — the
//     lockout path — was one of those callers.
//   * the disable / regenerate / change-method prompts sent no re-auth code,
//     so an email-factor user was asked for something that never arrived.
//   * the Turn-off button opened a prompt and failed afterwards with a red
//     line, where the web disables it and states the reason up front.
//
// Why this is an Electron script and not a node one: all three live in the
// renderer. `settings-window.js` is a classic script with no exports, and its
// logic is inseparable from the DOM it drives — a node test would have to
// assert on source text, which is the shape §203 removed from this codebase.
// The Settings window is a real BrowserWindow (§61), so CDP attaches to it
// directly and the assertions below are about what the actual panel does.
//
// Driven against a REAL fake API rather than a stubbed `window.freeframe`:
// contextBridge exposes that object non-writable and non-configurable, so a
// renderer cannot replace it or any of its methods (measured, not assumed —
// `Object.getOwnPropertyDescriptor` reports `{writable:false,
// configurable:false}` and `defineProperty` throws "Cannot redefine
// property"). Logging in against a local server makes every call a request
// this script can see, which is also a stronger assertion: it catches a call
// being DROPPED, where a DOM-text check would not.
//
// `ffStatus` is a plain module-scope `let`, so it IS assignable from CDP, and
// the policy tests set it directly. Everything under test — promptForCode,
// promptForReauthCode, renderAccount — is the shipping code, unmodified.
//
// Run: node scripts/e2e-2fa-parity.js
const path = require("node:path");
const http = require("node:http");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9391;
const API_PORT = 9392;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (me, pa = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method: me, params: pa }));
    });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", {
      expression: x,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || "threw");
    }
    return r.result.value;
  };
  return { ws, send, ev, ready };
}

async function attach(urlPart, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = t.find((x) => x.type === "page" && x.url.includes(urlPart));
      if (page?.webSocketDebuggerUrl) {
        const c = connect(page);
        await c.ready;
        await c.send("Runtime.enable");
        return c;
      }
    } catch {}
    await sleep(250);
  }
  return null;
}

/** Every request the app made, newest last. */
const seen = [];
/** Scenario 7 makes the send fail, to prove a failed mail still opens the
 *  panel — a backup code is a perfectly good way through it. */
let apiDown = false;
/** What /auth/me should say next. Mutated between scenarios. */
let me = {
  email: "u@example.com",
  name: "Test User",
  two_factor_enabled: true,
  two_factor_method: "totp",
  two_factor_required: false,
};

function startApi() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body });
        const json = (obj, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        const path_ = req.url.split("?")[0];
        if (path_ === "/auth/login") {
          return json({
            access_token: "acc", refresh_token: "ref", token_type: "bearer",
            needs_password: false, requires_2fa: false,
          });
        }
        if (path_ === "/auth/me") return json(me);
        if (path_ === "/auth/2fa/send-reauth-code") {
          return apiDown ? json({ detail: "Too many requests" }, 429) : json({ message: "ok" });
        }
        if (path_ === "/auth/2fa/verify-login") {
          return json({
            access_token: "acc", refresh_token: "ref", token_type: "bearer",
            needs_password: false, requires_2fa: false,
          });
        }
        if (path_ === "/auth/2fa/disable") return json({ two_factor_enabled: false, tokens: null });
        if (path_ === "/auth/2fa/regenerate-backup-codes") {
          return json({ backup_codes: ["AAAA-1111"], tokens: null });
        }
        if (path_ === "/auth/2fa/setup") {
          return json({ method: "totp", qr_code_data_uri: "data:,", secret: "S", email_code_sent: false });
        }
        if (path_ === "/auth/2fa/confirm-setup") {
          return json({ backup_codes: ["AAAA-1111"], method: "totp", tokens: null });
        }
        return json({ detail: "not found" }, 404);
      });
    });
    srv.listen(API_PORT, "127.0.0.1", () => resolve(srv));
  });
}

/** Requests to one endpoint since the last `seen.length = 0`. */
const hits = (p) => seen.filter((r) => r.url.split("?")[0] === p);

/** Put the panel into a known state: a signed-in user with this method, and
 *  this policy. `ffStatus` is assignable; `window.freeframe` is not. */
const setState = (method, { required = false } = {}) => `
  (() => {
    ffStatus = {
      loggedIn: true,
      baseUrl: "http://127.0.0.1:${API_PORT}",
      encryptionAvailable: true,
      user: {
        email: "u@example.com",
        name: "Test User",
        two_factor_enabled: true,
        two_factor_method: ${JSON.stringify(method)},
        two_factor_required: ${required},
      },
    };
    renderAccount();
    return true;
  })()
`;

const visible = (id) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  return !!el && !el.hidden;
})()`;

(async () => {
  const api = await startApi();
  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`],
    { stdio: "ignore" },
  );

  const main = await attach("index.html");
  if (!main) {
    console.error("Electron never came up");
    child.kill();
    process.exit(1);
  }
  await sleep(1500);
  await main.ev(`document.getElementById("settings-btn").click(); true`);

  const s = await attach("settings.html");
  if (!s) {
    console.error("the Settings window never opened");
    child.kill();
    process.exit(1);
  }
  const ev = s.ev;
  await sleep(500);

  // A real login against the fake API, so every later call is a request this
  // script can see. `window.freeframe` cannot be stubbed (see the header).
  await ev(`window.freeframe.freeframeLogin("u@example.com", "pw123456", "http://127.0.0.1:${API_PORT}")`);
  await sleep(400);
  check(hits("/auth/login").length === 1, "signed in against the fake API");

  // ── 1. the backup-code field exists and keeps what it is given ───────────
  console.log("1. a backup code can be typed at all");
  {
    await ev(setState("totp"));
    seen.length = 0;
    // Driven through the real login-challenge flow.
    await ev(`window.__p = runTwoFactorChallenge({ pendingToken: "p", method: "totp", setupRequired: false }); true`);
    await sleep(300);

    check(await ev(visible("tfa-prompt-backup-toggle")),
      "the login challenge offers 'Use a backup code instead'");

    await ev(`document.getElementById("tfa-prompt-backup-toggle").click(); true`);
    check(await ev(visible("tfa-prompt-backup-field")), "the backup field appears");
    check(!(await ev(visible("tfa-prompt-code-field"))), "and the digit field steps aside");

    // The bug, as one assertion: this value survives.
    await ev(`document.getElementById("tfa-prompt-backup").value = "A7K2-9QXM"; true`);
    await ev(`document.getElementById("tfa-prompt-confirm").click(); true`);
    await sleep(300);

    const sent = hits("/auth/2fa/verify-login").map((r) => JSON.parse(r.body || "{}").code);
    check(sent[0] === "A7K2-9QXM",
      "the whole dashed code reaches the API, letters intact", JSON.stringify(sent));
  }

  console.log("\n2. every shape a person might type is passed through raw");
  for (const typed of ["a7k2-9qxm", "A7K29QXM", "A7k2 9qxm"]) {
    await ev(setState("totp"));
    seen.length = 0;
    await ev(`window.__p = runTwoFactorChallenge({ pendingToken: "p", method: "totp", setupRequired: false }); true`);
    await sleep(250);
    await ev(`document.getElementById("tfa-prompt-backup-toggle").click(); true`);
    await ev(`document.getElementById("tfa-prompt-backup").value = ${JSON.stringify(typed)}; true`);
    await ev(`document.getElementById("tfa-prompt-confirm").click(); true`);
    await sleep(250);
    const sent = hits("/auth/2fa/verify-login").map((r) => JSON.parse(r.body || "{}").code);
    // Raw, because the server's normalize_backup_code already forgives case,
    // spaces and the dash — normalising here too would be a second opinion
    // about what counts as the same code.
    check(sent[0] === typed, `"${typed}" is sent unchanged`, JSON.stringify(sent));
  }

  console.log("\n3. a half-typed backup code is refused before it costs an attempt");
  {
    await ev(setState("totp"));
    seen.length = 0;
    await ev(`window.__p = runTwoFactorChallenge({ pendingToken: "p", method: "totp", setupRequired: false }); true`);
    await sleep(250);
    await ev(`document.getElementById("tfa-prompt-backup-toggle").click(); true`);
    await ev(`document.getElementById("tfa-prompt-backup").value = "A7K2"; true`);
    await ev(`document.getElementById("tfa-prompt-confirm").click(); true`);
    await sleep(250);
    const err = await ev(`document.getElementById("tfa-prompt-error").textContent`);
    check(/full backup code/i.test(err), "says so rather than sending four characters", err);
    check(hits("/auth/2fa/verify-login").length === 0, "and nothing reached the API");
  }

  // ── 4. offered on the four flows, absent on enrolment-confirm ────────────
  console.log("\n4. offered exactly where a backup code is valid");
  {
    for (const [label, expr] of [
      ["disable", `$("tfa-disable").click()`],
      ["regenerate", `$("tfa-regen").click()`],
      ["change method", `$("tfa-change").click()`],
    ]) {
      await ev(setState("totp"));
      seen.length = 0;
      await ev(`${expr}; true`);
      await sleep(300);
      check(await ev(visible("tfa-prompt-backup-toggle")), `${label} offers it`);
      await ev(`document.getElementById("tfa-prompt-cancel").click(); true`);
      await sleep(150);
    }

    // Enrolment-confirm must NOT: confirm_two_factor_setup refuses a backup
    // code by design, since it exists to prove the NEW factor works.
    await ev(setState("totp"));
    seen.length = 0;
    // runTwoFactorEnrolment asks for the METHOD first, so the confirm prompt
    // is two steps in — a test that stopped at the chooser would be asserting
    // about the wrong panel.
    await ev(`window.__p = runTwoFactorEnrolment({}); true`);
    await sleep(300);
    await ev(`document.getElementById("tfa-pick-totp").click(); true`);
    await sleep(500);
    check(!(await ev(visible("tfa-prompt-backup-toggle"))),
      "enrolment-confirm does NOT — the server would refuse one");
    await ev(`document.getElementById("tfa-prompt-cancel").click(); true`);
    await sleep(150);
  }

  // ── 5. the re-auth code is actually sent, for email users only ───────────
  console.log("\n5. the re-auth code is sent when it can be");
  {
    await ev(setState("email"));
    seen.length = 0;
    await ev(`$("tfa-disable").click(); true`);
    await sleep(400);
    const calls = hits("/auth/2fa/send-reauth-code");
    check(calls.length === 1, "an email-factor user is mailed one on open",
      JSON.stringify(calls.map((c) => c.url)));
    check(calls[0] && /force=false/.test(calls[0].url),
      "with force=false, so a code already in the inbox is not invalidated",
      calls[0] && calls[0].url);
    const desc = await ev(`document.getElementById("tfa-prompt-desc").textContent`);
    check(/emailed you/i.test(desc), "and is told to look in their email", desc);
    check(await ev(visible("tfa-prompt-extra")), "with a 'Send it again' action");

    await ev(`document.getElementById("tfa-prompt-extra").click(); true`);
    await sleep(300);
    const again = hits("/auth/2fa/send-reauth-code").map((c) => c.url);
    check(again.length === 2 && /force=true/.test(again[1]),
      "which forces a fresh one", JSON.stringify(again));
    await ev(`document.getElementById("tfa-prompt-cancel").click(); true`);
    await sleep(150);
  }

  console.log("\n6. a TOTP user is mailed nothing");
  {
    await ev(setState("totp"));
    seen.length = 0;
    await ev(`$("tfa-disable").click(); true`);
    await sleep(400);
    check(hits("/auth/2fa/send-reauth-code").length === 0,
      "no send — they have an authenticator");
    const desc = await ev(`document.getElementById("tfa-prompt-desc").textContent`);
    check(/authenticator/i.test(desc), "and the description says so", desc);
    check(!(await ev(visible("tfa-prompt-extra"))), "no resend offered for mail never sent");
    await ev(`document.getElementById("tfa-prompt-cancel").click(); true`);
    await sleep(150);
  }

  console.log("\n7. a failed send still opens the panel");
  {
    // A backup code is a perfectly good way through, and §206 just made
    // those typeable — so a rate-limited send must not bar the door.
    await ev(setState("email"));
    seen.length = 0;
    apiDown = true;
    await ev(`$("tfa-disable").click(); true`);
    await sleep(400);
    check(await ev(visible("tfa-prompt")), "the prompt is open");
    check(await ev(visible("tfa-prompt-backup-toggle")), "and a backup code is still offered");
    await ev(`document.getElementById("tfa-prompt-cancel").click(); true`);
    await sleep(150);
  }

  // ── 8. the policy removes the off switch, before anyone types ────────────
  console.log("\n8. require_2fa disables Turn off, with the reason beside it");
  {
    await ev(setState("totp", { required: true }));

    check(await ev(`document.getElementById("tfa-disable").disabled === true`),
      "Turn off is disabled");
    check(await ev(visible("tfa-disable-blocked")), "and the reason is rendered, not hidden");
    const why = await ev(`document.getElementById("tfa-disable-blocked").textContent`);
    check(/required on this instance/i.test(why), "naming the policy", why.trim());
    check(!(await ev(`document.getElementById("tfa-disable").hidden`)),
      "the button is still THERE — hidden would be a support ticket");

    check(await ev(`document.getElementById("tfa-regen").disabled !== true`),
      "regenerate stays enabled — it removes no protection");
    check(await ev(`document.getElementById("tfa-change").disabled !== true`),
      "change method stays enabled");
  }

  console.log("\n9. with the policy off, Turn off works as before");
  {
    await ev(setState("totp", { required: false }));
    check(await ev(`document.getElementById("tfa-disable").disabled !== true`),
      "enabled again");
    check(!(await ev(visible("tfa-disable-blocked"))), "and the reason is gone");
  }

  // Sign out before leaving. This script logs in FOR REAL, and the session
  // is persisted to the app's userData — so without this it leaves the next
  // script's app logged in against a fake API that is about to stop
  // listening. Caught by e2e-hide-pages failing three checks about the
  // embedded web view's base URL and tokens, which pass at HEAD and pass
  // again once this runs: test pollution, not a product defect, but it made
  // the suite lie about an unrelated script.
  try { await ev(`window.freeframe.freeframeLogout()`); } catch {}
  await sleep(300);

  try { s.ws.close(); } catch {}
  try { main.ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { api.close(); } catch {}
  await sleep(600);

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
