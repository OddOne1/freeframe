#!/usr/bin/env node
// §212 — one bad part must not cost the whole file.
//
// A 392 GiB folder upload ran 38 minutes and died on part 1,103 with a
// 502 Bad Gateway. Five earlier attempts died the same way at parts 160, 285,
// 883, 1,101 and 3,477, and every one of them left its multipart upload in
// the bucket: 92.3 GiB of orphaned parts, invisible to the app.
//
// Part PUTs go to S3_PUBLIC_ENDPOINT, which is behind Cloudflare, so a
// transient 502 over a multi-hour upload is the expected weather rather than
// an anomaly. None of that is reproducible from a test — there is no way to
// make the real tunnel return a real 502 on demand — so what is asserted here
// is the POLICY: given each response class, what does the uploader do?
//
// Fake S3 through `global.fetch`, an injected instant `sleep`, and a real file
// on disk so the part reads and the file handle are genuine. `electron` is
// stubbed through require.cache exactly as test-auth-refresh.js does.
//
// §213 CHANGED WHAT "GIVING UP" MEANS HERE, and several scenarios below say
// so explicitly rather than being quietly deleted. §212 aborted the multipart
// upload on any terminal failure, which is why the assertions used to read
// `calls.abort === 1`. That abort threw away every byte already transferred —
// on the real 392 GiB job, hours of it — so §213 narrowed aborting to the
// three cases where the session is provably worthless: the user cancelled,
// the source file changed, or the client and server disagree about the part
// plan. A part failure now KEEPS the session, and the file resumes.
//
// The never-gives-up policy itself, resume, and pause at part granularity
// live in scripts/test-upload-resume.js. This file stays what it was: the
// per-response-class policy table.
//
// Run: node scripts/test-upload-resilience.js
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-upload-"));

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
require.cache["electron-stub"] = {
  id: "electron-stub", filename: "electron-stub", loaded: true, exports: fakeElectron,
};

const freeframe = require(path.join(__dirname, "..", "src", "main", "freeframe.js"));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

// §212 fix 3 — a scenario that HANGS must report a FAIL line, not hang.
//
// Found by mutating away the `signal` passed to fetch: the cancel scenario
// then waited forever on a PUT nothing could abort, and the run produced no
// output at all. A hang is the least useful possible test result — it names
// nothing and blocks the suite — and CLAUDE.md rule 12 is explicit that a
// non-verdict is not a caught mutation.
const SCENARIO_TIMEOUT_MS = Number(process.env.FF_SCENARIO_TIMEOUT_MS || 5000);

async function scenario(name, fn) {
  console.log(name);
  let timer;
  const timeout = new Promise((_r, rej) => {
    timer = setTimeout(() => rej(new Error("__timeout__")), SCENARIO_TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
  } catch (err) {
    if (err && err.message === "__timeout__") {
      check(false, `${name} — timed out`, `no verdict within ${SCENARIO_TIMEOUT_MS}ms`);
    } else {
      // An unexpected throw is also a failure with a name, never a stack
      // trace that ends the run.
      check(false, `${name} — threw`, String(err && err.message || err));
    }
  } finally {
    clearTimeout(timer);
  }
}

const realFetch = global.fetch;
const PART = 16 * 1024 * 1024;

/** A real file of `parts` whole 16 MiB parts plus `tailBytes`. */
function makeFile(name, parts, tailBytes = 0) {
  const p = path.join(tmp, name);
  const fd = fs.openSync(p, "w");
  const chunk = Buffer.alloc(1024 * 1024, 7);
  for (let i = 0; i < parts * 16; i++) fs.writeSync(fd, chunk);
  if (tailBytes) fs.writeSync(fd, Buffer.alloc(tailBytes, 9));
  fs.closeSync(fd);
  return p;
}

/**
 * A fake FreeFrame + S3.
 *
 * `partBehaviour(partNumber, attemptForThisPart)` returns what the PUT should
 * do: `{status}`, `{status, etag}`, `{throw: true}`, or `{hang: true}` (which
 * waits on the abort signal, so a per-attempt timeout or a cancel is what ends
 * it — not a timer this harness invents).
 */
function server({ partBehaviour, completeStatus = 200, abortStatus = 204, onPutStarted = null }) {
  const calls = {
    initiate: 0, presign: 0, put: 0, complete: 0, abort: 0,
    presignByPart: new Map(), putByPart: new Map(),
    putsStarted: [],
    completeBody: null, abortBody: null,
  };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  global.fetch = async (url, opts = {}) => {
    const u = String(url);

    if (u.endsWith("/upload/initiate")) {
      calls.initiate++;
      return json({ s3_key: "k/1", upload_id: "u-1", asset_id: "a-1", version_id: "v-1" });
    }
    if (u.endsWith("/upload/presign-part")) {
      calls.presign++;
      const body = JSON.parse(opts.body);
      bump(calls.presignByPart, body.part_number);
      // The attempt number is encoded in the URL, so a reused (stale) URL is
      // detectable by the PUT handler below.
      return json({
        presigned_url: `https://s3.invalid/put?part=${body.part_number}`
          + `&presign=${calls.presignByPart.get(body.part_number)}`,
      });
    }
    if (u.endsWith("/upload/complete")) {
      calls.complete++;
      calls.completeBody = JSON.parse(opts.body);
      if (completeStatus >= 400) return new Response("complete refused", { status: completeStatus });
      return json({ ok: true });
    }
    if (u.endsWith("/upload/abort")) {
      calls.abort++;
      calls.abortBody = JSON.parse(opts.body);
      if (abortStatus >= 400) return new Response("abort refused", { status: abortStatus });
      return new Response(null, { status: 204 });
    }

    // A part PUT.
    calls.put++;
    const partNumber = Number(new URL(u).searchParams.get("part"));
    bump(calls.putByPart, partNumber);
    // STARTED, not finished. Scenario 6 asserts on this: the bug it guards
    // against is a worker CLAIMING another part after a sibling has failed,
    // and a claim is visible here before any response exists.
    calls.putsStarted.push(partNumber);
    // Fired BEFORE the behaviour is consulted, so a scenario can synchronise
    // on "this part's PUT has begun" without guessing how long that takes.
    if (onPutStarted) onPutStarted(partNumber, calls);
    const behaviour = partBehaviour(partNumber, calls.putByPart.get(partNumber));

    if (behaviour.throw) throw new TypeError("fetch failed");
    // Hold this part until the scenario opens its gate. Unlike `hang` below
    // this one is RELEASED rather than aborted, so a scenario can pin the
    // exact moment work is allowed to continue.
    if (behaviour.waitFor) await behaviour.waitFor;
    if (behaviour.hang) {
      // Resolve only when the caller's AbortController fires.
      return new Promise((_res, rej) => {
        const s = opts.signal;
        if (!s) return;
        if (s.aborted) return rej(abortError());
        s.addEventListener("abort", () => rej(abortError()), { once: true });
      });
    }
    const status = behaviour.status ?? 200;
    const headers = {};
    if (status < 400 && behaviour.etag !== null) {
      headers.ETag = behaviour.etag ?? `"etag-${partNumber}"`;
    }
    return new Response(status < 400 ? "" : "upstream", { status, headers });
  };

  return calls;
}
const json = (o) => new Response(JSON.stringify(o), {
  status: 200, headers: { "Content-Type": "application/json" },
});
function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/** Instant backoff, and a record of every delay asked for. */
function instantRetry(over = {}) {
  const delays = [];
  return {
    cfg: {
      sleep: async (ms) => { delays.push(ms); },
      random: () => 0.5,
      ...over,
    },
    delays,
  };
}

function session() {
  freeframe.__setState({
    baseUrl: "https://example.invalid/api",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    user: { email: "someone@example.com" },
  });
}

(async () => {
  const file3 = makeFile("three-parts.mxf", 3);          // exactly 3 parts
  const file1 = makeFile("one-part.mxf", 0, 1024);        // 1 small part

  await scenario("1. A part that 502s twice then succeeds", async () => {
      session();
      const { cfg, delays } = instantRetry();
      const calls = server({
        partBehaviour: (part, attempt) =>
          part === 2 && attempt <= 2 ? { status: 502 } : { status: 200 },
      });
      let res = null, threw = null;
      try {
        res = await freeframe.uploadFile({
          projectId: "p", filePath: file3, assetName: "three-parts.mxf", retry: cfg,
        });
      } catch (e) { threw = e; }
      // Caught rather than allowed to escape: an uncaught throw here would end
      // the run with a stack trace, and a stack trace is not a FAIL line
      // (CLAUDE.md rule 12). Deleting the retry makes this the failure that
      // names the cause.
      check(!threw, "does not throw", String(threw && threw.message));
      check(Boolean(res && res.assetId === "a-1"), "upload completes");
      check(calls.put === 5, "exactly 5 PUTs (3 parts + 2 retries)", `got ${calls.put}`);
      check(calls.complete === 1, "/upload/complete called once");
      check(calls.abort === 0, "no abort on a successful upload");
      const parts = (calls.completeBody || {}).parts || [];
      check(parts.length === 3, "complete got all 3 parts", `got ${parts.length}`);
      check(parts.every((p) => p.ETag && p.ETag.length > 0), "every part has a non-empty ETag");
      check(delays.length === 2, "backed off twice", JSON.stringify(delays));
  });

  await scenario("2. Presign runs again on every attempt", async () => {
      session();
      const { cfg } = instantRetry();
      const calls = server({
        partBehaviour: (part, attempt) =>
          part === 1 && attempt <= 2 ? { status: 503 } : { status: 200 },
      });
      let threw2 = null;
      try {
        await freeframe.uploadFile({ projectId: "p", filePath: file1, assetName: "one.mxf", retry: cfg });
      } catch (e) { threw2 = e; }
      check(!threw2, "does not throw", String(threw2 && threw2.message));
      // A presigned URL carries its own expiry and signature; reusing one
      // across a backoff is how a retry that should work returns 403.
      check(calls.presignByPart.get(1) === 3, "presigned 3 times for 3 attempts",
        String(calls.presignByPart.get(1)));
  });

  await scenario("3. A 400 fails fast and KEEPS the session (§213)", async () => {
      session();
      const { cfg, delays } = instantRetry();
      const calls = server({ partBehaviour: () => ({ status: 400 }) });
      let err = null;
      try {
        await freeframe.uploadFile({ projectId: "p", filePath: file1, assetName: "one.mxf", retry: cfg });
      } catch (e) { err = e; }
      check(Boolean(err), "throws");
      check(calls.put === 1, "exactly one PUT — no retries on a 400", String(calls.put));
      check(delays.length === 0, "never backed off");
      // §213 — NOT aborted. A 400 on one part is a reason to stop trying
      // that part, not a reason to destroy an upload the user can resume.
      // The parts that landed stay, and the session stays resumable.
      check(calls.abort === 0, "the session is kept, not aborted", String(calls.abort));
      check(calls.complete === 0, "never completed");
  });

  await scenario("4. A part that always 502s keeps the session (§213)", async () => {
      session();
      const { cfg, delays } = instantRetry();
      const calls = server({ partBehaviour: () => ({ status: 502 }), abortStatus: 500 });
      let err = null;
      try {
        await freeframe.uploadFile({
          projectId: "p", filePath: file1, assetName: "one.mxf",
          retry: { ...cfg, attempts: 4 },
        });
      } catch (e) { err = e; }
      // The budget is INJECTED. In production there is none — see
      // test-upload-resume.js scenario 1, which is the assertion that a
      // 502 storm longer than §212's old 12 attempts does not end an
      // upload at all. A finite budget here is only how this file gets a
      // boundary to assert around.
      check(calls.put === 4, "exactly the injected attempt budget (4)", String(calls.put));
      check(delays.length === 3, "backed off between attempts only", String(delays.length));
      check(calls.abort === 0, "the session is KEPT — §213's whole point", String(calls.abort));
      check(/502/.test(String(err && err.message)), "the part's own error is what surfaces",
        String(err && err.message));
  });

  await scenario("5. A 200 with no ETag is a failed attempt, never a success", async () => {
      session();
      const { cfg } = instantRetry();
      const calls = server({ partBehaviour: () => ({ status: 200, etag: null }) });
      let err = null;
      try {
        await freeframe.uploadFile({
          projectId: "p", filePath: file1, assetName: "one.mxf",
          retry: { ...cfg, attempts: 3 },
        });
      } catch (e) { err = e; }
      check(Boolean(err), "fails rather than completing");
      check(calls.put === 3, "retried the empty-ETag response", String(calls.put));
      check(calls.complete === 0, "never sent a part list containing an empty ETag");
      check(calls.abort === 0, "§213 — the session is kept and stays resumable",
        String(calls.abort));
  });

  await scenario("6. One worker's terminal failure stops the others", async () => {
    session();
    const { cfg } = instantRetry();

    // DETERMINISTIC. No sleeps as synchronisation, no tolerances.
    //
    // Two earlier versions of this scenario were flaky, and both were wrong
    // about what the code guarantees:
    //
    //   v1 asserted `calls.put <= 3` after a 50ms drain. That measured the
    //   scheduler: healthy workers can legitimately finish and claim the next
    //   part before the failing worker's error is recorded. 3 failures in 8.
    //
    //   v2 gated parts 2 and 3 and asserted nothing STARTED after the gate
    //   opened — but nothing forced workers 2 and 3 to issue their PUTs
    //   before worker 1 failed. Part 1 is refused immediately, so worker 1
    //   could set the shared flag while worker 3 had not yet started the part
    //   it had ALREADY CLAIMED. Worker 3 then starting that PUT is correct
    //   behaviour, so the assertion was wrong, not the code. 27/30.
    //
    // What the code actually guarantees is about CLAIMS, not starts: once the
    // flag is set, the loop claims nothing further. With 3 workers and 6
    // parts, parts 1-3 are claimed up front and parts 4-6 must never be
    // touched at all — neither presigned nor PUT.
    //
    // Two synchronisation points, both on observed events:
    //
    //   barrier — part 1's 400 is withheld until the PUTs for parts 2 AND 3
    //             have both STARTED and are parked at the gate. That removes
    //             the race entirely: all three parts are provably claimed and
    //             in flight before any failure exists.
    //   gate    — released only once worker 1's failure has been recorded.
    //             After the 400 is handed back, worker 1 runs to `failed =
    //             true` with no further awaits — only microtask resumption —
    //             so a macrotask (setImmediate) scheduled at that moment is
    //             guaranteed to run after it. Draining the microtask queue is
    //             a synchronisation primitive, not a duration.
    let openGate;
    const gate = new Promise((res) => { openGate = res; });
    let openBarrier;
    const barrier = new Promise((res) => { openBarrier = res; });

    // Chained off the BARRIER, not scheduled inside partBehaviour: the server
    // calls partBehaviour when the PUT starts, which for part 1 is before the
    // barrier exists — scheduling there opened the gate almost immediately
    // and part 4 got claimed (caught by this scenario's own assertion).
    //
    // Ordering, once the barrier resolves: microtasks run first — part 1's
    // handler resumes, returns the 400, worker 1's fetch settles and the
    // worker runs straight through to `failed = true`, with no awaits in
    // between. Only then do macrotasks run, so the gate cannot open early.
    barrier.then(() => setImmediate(() => setImmediate(openGate)));

    const calls = server({
      onPutStarted: (_part, c) => {
        // ALL THREE, including part 1 — the condition that made this
        // deterministic under load.
        //
        // Requiring only 2 and 3 was not enough: each worker does
        // `await fh.read(...)` and then presigns before it PUTs, so under CPU
        // contention workers 2 and 3 can reach their PUTs while worker 1 is
        // still presigning. The barrier then resolved, the gate opened, and
        // parts 4-5 were claimed before any failure existed. (Caught by this
        // scenario at 1 failure in 30 under 12 busy loops — never once in 100
        // unloaded runs, which is exactly why the loaded run is worth doing.)
        //
        // `includes(1)` is true as soon as part 1's handler is entered, and it
        // parks at this barrier synchronously after that — so this condition
        // means all three parts are claimed AND all three are in flight.
        const p = c.putsStarted;
        if (p.includes(1) && p.includes(2) && p.includes(3)) openBarrier();
      },
      partBehaviour: (part) => {
        // Refused only once both siblings are parked at the gate.
        if (part === 1) return { status: 400, waitFor: barrier };
        return { status: 200, waitFor: gate };
      },
    });

    let err = null;
    try {
      await freeframe.uploadFile({
        projectId: "p", filePath: makeFile("stop-together.mxf", 6), assetName: "s.mxf",
        retry: cfg,
      });
    } catch (e) { err = e; }

    check(Boolean(err), "throws");
    check(/400/.test(String(err && err.message)), "the terminal error is what surfaces",
      String(err && err.message));

    // THE assertion, as an end state over the whole run: three workers, three
    // claims, and parts 4-6 untouched. Under Promise.all the survivors kept
    // claiming parts against a file handle `finally` was about to close.
    const everPut = [...new Set(calls.putsStarted)].sort((a, b) => a - b);
    check(JSON.stringify(everPut) === "[1,2,3]",
      "parts 1, 2 and 3 were the only parts ever PUT", JSON.stringify(everPut));

    const presigned = [...calls.presignByPart.keys()].sort((a, b) => a - b);
    check(JSON.stringify(presigned) === "[1,2,3]",
      "parts 4-6 were never even presigned", JSON.stringify(presigned));

    check(calls.abort === 0, "§213 — no abort: the other parts stay uploaded",
      String(calls.abort));
  });

  await scenario("7. No read-after-close: the handle outlives every worker", async () => {
      session();
      const { cfg } = instantRetry();
      // Part 1 fails terminally while parts 2 and 3 are mid-PUT. If `fh` closed
      // before they settled, their `fh.read` would throw EBADF — which would
      // surface as that error instead of the 400.
      const calls = server({
        partBehaviour: (part, attempt) => {
          if (part === 1) return { status: 400 };
          return attempt === 1 ? { status: 503 } : { status: 200 };
        },
      });
      let err = null;
      try {
        await freeframe.uploadFile({
          projectId: "p", filePath: makeFile("handle.mxf", 3), assetName: "h.mxf", retry: cfg,
        });
      } catch (e) { err = e; }
      check(/400/.test(String(err && err.message)), "the real error survives",
        String(err && err.message));
      check(!/EBADF|closed/i.test(String(err && err.message)), "no read-after-close error");
  });

  await scenario("8. Cancel mid-file aborts the in-flight PUT", async () => {
      session();
      const { cfg } = instantRetry();
      const ac = new AbortController();
      const calls = server({
        partBehaviour: (part) => {
          // Part 1 hangs until the signal fires; cancel is what ends it.
          if (part === 1) { setTimeout(() => ac.abort(), 10); return { hang: true }; }
          return { status: 200 };
        },
      });
      const started = Date.now();
      let err = null;
      try {
        await freeframe.uploadFile({
          projectId: "p", filePath: makeFile("cancel.mxf", 2), assetName: "c.mxf",
          retry: cfg, signal: ac.signal,
        });
      } catch (e) { err = e; }
      check(/cancel/i.test(String(err && err.message)), "ends as cancelled",
        String(err && err.message));
      check(Date.now() - started < 5000, "did not wait for the file", `${Date.now() - started}ms`);
      check(calls.abort === 1, "/upload/abort called on cancel", String(calls.abort));
      check(calls.complete === 0, "never completed");
  });

  await scenario("9. A part plan that cannot work is refused, not attempted (§213)", async () => {
      // §212 refused an oversized file in the CLIENT, against its own
      // hardcoded 16 MiB part size. §213 moved the ceiling to the server
      // (services/upload_policy.py refuses with 413 before creating
      // anything), so the client's own arithmetic is no longer the gate —
      // it is the check that the server's answer is actually usable.
      //
      // What is asserted here is that disagreement: a server that hands
      // back a part_size needing more than 10,000 parts is stopped at once
      // rather than discovered at part 10,001 after several hours. This IS
      // one of the three cases that still aborts — the session can never be
      // completed, so leaving it would be pure orphaned storage.
      session();
      const calls = server({ partBehaviour: () => ({ status: 200 }) });
      // Faked rather than written: a real 157 GiB file is not a test fixture.
      const big = path.join(tmp, "huge.mxf");
      fs.writeFileSync(big, "x");
      const realStat = fs.promises.stat;
      const fakeSize = (freeframe.MAX_PARTS + 1) * freeframe.PART_SIZE;
      fs.promises.stat = async (p, ...r) =>
        (String(p) === big
          ? { size: fakeSize, mtimeMs: 1, isDirectory: () => false }
          : realStat(p, ...r));
      let err = null;
      try {
        await freeframe.uploadFile({ projectId: "p", filePath: big, assetName: "huge.mxf" });
      } catch (e) { err = e; }
      fs.promises.stat = realStat;
      check(Boolean(err), "throws");
      check(/10001 parts|more than the 10000/.test(String(err && err.message)),
        "names the part count the server's answer would need", String(err && err.message));
      check(calls.put === 0, "not one part was uploaded", String(calls.put));
      check(calls.complete === 0, "never completed");
      check(calls.abort === 1, "the unusable session is aborted", String(calls.abort));
  });

  await scenario("9b. /upload/complete is retried, and never aborted (§213)", async () => {
    session();
    const { cfg, delays } = instantRetry();
    // Every part succeeds; it is the FINAL call that 502s. §212 aborted
    // here — throwing away a fully transferred file because one request
    // was unlucky. §213 retries the complete on the same policy as a part,
    // and keeps the session whatever happens, so the next resume finds
    // every part already present and only has to complete it.
    const calls = server({ partBehaviour: () => ({ status: 200 }), completeStatus: 502 });

    let err = null;
    try {
      await freeframe.uploadFile({
        projectId: "p", filePath: file3, assetName: "three-parts.mxf",
        retry: { ...cfg, attempts: 3 },
      });
    } catch (e) { err = e; }

    check(Boolean(err), "throws once the injected budget runs out");
    check(calls.complete === 3, "/upload/complete was RETRIED, not attempted once",
      String(calls.complete));
    check(delays.length === 2, "backed off between completes", String(delays.length));
    check(calls.abort === 0, "the session is kept so a resume can just complete it",
      String(calls.abort));
    check(/complete refused|502/.test(String(err && err.message)),
      "the original /complete error is what is thrown", String(err && err.message));
  });

  await scenario("9c. A cancel is not an error", async () => {
    // §212 fix 4 — the predicate runUpload's per-file catch uses to decide
    // whether a file FAILED or was merely stopped. Tested here rather than by
    // driving the IPC handler: this is the decision, and main.js calls it.
    const c = freeframe.isCancellationError;
    check(c(new Error("Upload cancelled")) === true, "our own cancel error");
    const ab = new Error("The operation was aborted.");
    ab.name = "AbortError";
    check(c(ab) === true, "a DOM AbortError from the network stack");
    check(c(new Error("Part 1103 failed: 502 Bad Gateway")) === false,
      "a real part failure is NOT a cancellation");
    check(c(new Error("Unrecognised file type \".mxfindex\"")) === false,
      "an unknown type is NOT a cancellation");
    check(c(null) === false, "no error at all");
  });

  await scenario("9d. The heading never claims an upload that did not happen", async () => {
    // §212 fix 4 — with every file skipped, filesCopied === totalFiles is
    // 0 === 0, which is true, and the heading read "Upload complete" for a
    // job that uploaded nothing. Pure, so asserted directly.
    const { uploadHeadline } = require(path.join(__dirname, "..", "src", "renderer", "panel.js"));
    const h = (o) => uploadHeadline({ cancelled: false, errorCount: 0, ...o });

    check(h({ filesCopied: 0, totalFiles: 0, skippedCount: 2 }) === "Nothing was uploaded — 2 files skipped",
      "nothing uploaded, everything skipped", h({ filesCopied: 0, totalFiles: 0, skippedCount: 2 }));
    check(h({ filesCopied: 0, totalFiles: 0, skippedCount: 1 }) === "Nothing was uploaded — 1 file skipped",
      "singular reads correctly");
    check(h({ filesCopied: 3, totalFiles: 3, skippedCount: 1 }) === "Upload complete — 1 file skipped",
      "some uploaded, one skipped");
    check(h({ filesCopied: 3, totalFiles: 3, skippedCount: 0 }) === "Upload complete",
      "the ordinary success case is unchanged");
    check(h({ filesCopied: 0, totalFiles: 0, skippedCount: 0 }) === "Nothing to upload",
      "an empty job says so rather than claiming success");
    check(uploadHeadline({ cancelled: true, errorCount: 0, filesCopied: 1, totalFiles: 3, skippedCount: 0 })
      === "Upload cancelled", "a cancel is named as a cancel, not a problem");
    check(h({ filesCopied: 1, totalFiles: 3, skippedCount: 0 }) === "Upload finished with problems",
      "a short upload is still a problem");
  });

  await scenario("10. The retry policy, class by class", async () => {
      const r = freeframe.isRetryablePartFailure;
      for (const s of [null, 408, 425, 429, 500, 502, 503, 504]) {
        check(r(s) === true, `${s === null ? "threw" : s} is retried`);
      }
      for (const s of [400, 403, 409, 422]) {
        check(r(s) === false, `${s} fails fast`);
      }
      // §213 — these two are NOT decided by this predicate any more, and
      // the predicate still answering "false" for them is correct: both are
      // handled before it is consulted.
      //
      //   401 — an expired login that could not refresh. The upload PARKS
      //         (see test-upload-resume.js scenario 5); retrying a dead
      //         token on a backoff would just fail faster.
      //   404 — the multipart session is gone. The file gets a FRESH
      //         upload; there is nothing to retry and nothing to abort.
      check(r(401) === false, "401 is not retried as weather — it parks instead");
      check(r(404) === false, "404 is not retried — it means start fresh");
  });

  global.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
