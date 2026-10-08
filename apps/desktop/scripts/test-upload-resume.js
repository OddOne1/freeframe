#!/usr/bin/env node
// §213 — an upload that cannot be lost.
//
// §212 made one bad part survivable for seven minutes and then aborted the
// whole multipart upload. On the real job that prompted it — 392 GiB over
// Cloudflare — that still meant losing hours to one bad minute, five times
// over. §213's contract is narrower and much stronger:
//
//   The ONLY things that may end an upload are the user pressing Cancel,
//   the server saying the session no longer exists, and the source file
//   having changed. Network loss, 5xx, 429, timeouts, an expired login, a
//   sleeping laptop, an app quit or a crash all PAUSE it, and it continues.
//
// What is asserted here is that contract, scenario by scenario. None of it
// is reproducible against the real thing — there is no way to make the
// tunnel return a real 502, and there is no MinIO here — so the shape is
// the same as test-upload-resilience.js: a fake FreeFrame + S3 over
// `global.fetch`, an injected instant `sleep`, real files on disk so the
// part reads and the file handle are genuine, and `electron` stubbed
// through require.cache the way test-auth-refresh.js does it.
//
// DETERMINISM. Every scenario that needs two things to happen in a
// particular order uses a gate or a barrier released by an OBSERVED EVENT
// (a PUT having started, a part having been recorded), never a sleep.
// §212's review found a scheduler-dependent assertion in exactly this kind
// of test; the note in test-upload-resilience.js scenario 6 is the full
// account of why.
//
// Run: node scripts/test-upload-resume.js
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-resume-"));

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
const journal = require(path.join(__dirname, "..", "src", "main", "job-journal.js"));
const { planResumeSweep } = require(path.join(__dirname, "..", "src", "renderer", "resume-policy.js"));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

// A scenario that HANGS must report a FAIL line, not hang: a non-verdict
// names nothing and blocks the suite.
const SCENARIO_TIMEOUT_MS = Number(process.env.FF_SCENARIO_TIMEOUT_MS || 8000);

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
      check(false, `${name} — threw`, String(err && err.message || err));
    }
  } finally {
    clearTimeout(timer);
  }
}

const realFetch = global.fetch;
const MIB = 1024 * 1024;

/** A real file of `parts` whole parts of `partSize`, plus `tailBytes`. */
function makeFile(name, parts, partSize = 4 * MIB, tailBytes = 0) {
  const p = path.join(tmp, name);
  const fd = fs.openSync(p, "w");
  const chunk = Buffer.alloc(Math.min(partSize, MIB), 7);
  let written = 0;
  const total = parts * partSize;
  while (written < total) {
    const n = Math.min(chunk.length, total - written);
    fs.writeSync(fd, chunk, 0, n);
    written += n;
  }
  if (tailBytes) fs.writeSync(fd, Buffer.alloc(tailBytes, 9));
  fs.closeSync(fd);
  return p;
}

const json = (o) => new Response(JSON.stringify(o), {
  status: 200, headers: { "Content-Type": "application/json" },
});
function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/**
 * A fake FreeFrame + S3, §213 flavour.
 *
 * Differences from test-upload-resilience.js's: it answers
 * `GET /upload/parts`, it can advertise a `part_size` on initiate, and it
 * REMEMBERS which parts it has been given — so "only the missing parts are
 * sent" is observable rather than inferred.
 */
function server({
  partBehaviour = () => ({ status: 200 }),
  partSize = 4 * MIB,
  completeStatus = 200,
  abortStatus = 204,
  // Parts the store already holds before this run starts, as
  // {PartNumber, ETag, Size}. This is what a crash leaves behind.
  existingParts = [],
  // Answer /upload/parts with a 404 carrying the machine-readable code.
  partsGone = false,
  onPutStarted = null,
  refreshOk = true,
} = {}) {
  const calls = {
    initiate: 0, presign: 0, put: 0, complete: 0, abort: 0, parts: 0, refresh: 0,
    presignByPart: new Map(), putByPart: new Map(),
    putsStarted: [], putsFinished: [],
    completeBody: null, abortBody: null,
    stored: new Map(existingParts.map((p) => [p.PartNumber, p])),
  };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  global.fetch = async (url, opts = {}) => {
    const u = String(url);

    if (u.endsWith("/upload/initiate")) {
      calls.initiate++;
      return json({
        s3_key: "k/1", upload_id: `u-${calls.initiate}`,
        asset_id: "a-1", version_id: "v-1",
        part_size: partSize, total_parts: null,
      });
    }
    if (u.includes("/upload/parts")) {
      calls.parts++;
      if (partsGone) {
        return new Response(
          JSON.stringify({ detail: { code: "no_such_upload", message: "gone" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return json({ parts: [...calls.stored.values()] });
    }
    if (u.endsWith("/auth/refresh")) {
      calls.refresh++;
      if (!refreshOk()) return new Response("nope", { status: 401 });
      return json({ access_token: "fresh-access", refresh_token: "refresh-token" });
    }
    if (u.endsWith("/upload/presign-part")) {
      calls.presign++;
      const body = JSON.parse(opts.body);
      bump(calls.presignByPart, body.part_number);
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
    calls.putsStarted.push(partNumber);
    if (onPutStarted) onPutStarted(partNumber, calls);
    const behaviour = partBehaviour(partNumber, calls.putByPart.get(partNumber), calls);

    if (behaviour.throw) throw new TypeError("fetch failed");
    if (behaviour.waitFor) await behaviour.waitFor;
    if (behaviour.hang) {
      return new Promise((_res, rej) => {
        const s = opts.signal;
        if (!s) return;
        if (s.aborted) return rej(abortError());
        s.addEventListener("abort", () => rej(abortError()), { once: true });
      });
    }
    const status = behaviour.status ?? 200;
    if (status === 401) return new Response("expired", { status: 401 });
    const headers = {};
    if (status < 400 && behaviour.etag !== null) {
      headers.ETag = behaviour.etag ?? `"etag-${partNumber}"`;
      // Recorded as the store would, including the real byte length — the
      // resume scenarios compare against this.
      calls.stored.set(partNumber, {
        PartNumber: partNumber, ETag: headers.ETag,
        Size: Number(opts.body && opts.body.length) || 0,
      });
    }
    calls.putsFinished.push(partNumber);
    return new Response(status < 400 ? "" : "upstream", { status, headers });
  };

  return calls;
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

/** Yield to the macrotask queue — a synchronisation primitive, not a wait. */
const drain = () => new Promise((r) => setImmediate(() => setImmediate(r)));

(async () => {
  const PART = 4 * MIB;
  const file3 = makeFile("three.mxf", 3, PART);
  const file1 = makeFile("one.mxf", 0, PART, 1024);

  // ── 1 — a storm longer than §212's whole budget ─────────────────────────

  await scenario("1. 40 consecutive 502s do not end the upload", async () => {
    session();
    const { cfg, delays } = instantRetry();
    const notes = [];
    // 40 failures is more than three times §212's 12-attempt budget. Under
    // §212 this file was lost; under §213 it is a delay.
    const calls = server({
      partSize: PART,
      partBehaviour: (part, attempt) =>
        (part === 2 && attempt <= 40 ? { status: 502 } : { status: 200 }),
    });

    let res = null, threw = null;
    try {
      res = await freeframe.uploadFile({
        projectId: "p", filePath: file3, assetName: "three.mxf",
        retry: cfg, onRetry: (n) => notes.push(n),
      });
    } catch (e) { threw = e; }

    check(!threw, "does not throw", String(threw && threw.message));
    check(Boolean(res && res.assetId === "a-1"), "completes once the fake server recovers");
    check(calls.putByPart.get(2) === 41, "part 2 was attempted 41 times", String(calls.putByPart.get(2)));
    check(calls.complete === 1, "/upload/complete called once");
    check(calls.abort === 0, "never aborted");
    // The distinct waiting state, which is what replaces "retrying 12/12".
    const waiting = notes.filter((n) => n.waitingFor === "connection");
    check(waiting.length > 0, "reports the waiting-for-connection state", String(waiting.length));
    check(notes.every((n) => n.of === null), "no denominator is ever reported");
    check(waiting.every((n) => typeof n.nextAttemptAt === "number"),
      "says when the next attempt is");
    // The backoff doubles to the cap and then stays there, which is what
    // makes the wait indefinite rather than ever-growing.
    const capped = delays.filter((d) => d >= 30000).length;
    check(capped >= 30, "the schedule settles at the cap and stays", String(capped));
  });

  await scenario("2. Cancel during the storm ends it, and aborts", async () => {
    session();
    const { cfg } = instantRetry();
    const ac = new AbortController();
    // Cancelled from inside the storm, on an observed event: the 5th
    // attempt at part 1. No timer decides this.
    const calls = server({
      partSize: PART,
      partBehaviour: (part, attempt) => {
        if (attempt >= 5) ac.abort();
        return { status: 502 };
      },
    });

    let err = null;
    try {
      await freeframe.uploadFile({
        projectId: "p", filePath: file1, assetName: "one.mxf",
        retry: cfg, signal: ac.signal,
      });
    } catch (e) { err = e; }

    check(/cancel/i.test(String(err && err.message)), "ends as cancelled",
      String(err && err.message));
    check(calls.abort === 1, "cancel is one of the three things that DOES abort",
      String(calls.abort));
    check(calls.complete === 0, "never completed");
  });

  // ── 3 — pause, at part granularity ──────────────────────────────────────

  await scenario("3. Pause: in-flight parts finish, no new part starts", async () => {
    session();
    const { cfg } = instantRetry();

    // DETERMINISTIC, with no sleep used as synchronisation.
    //
    // Three workers run (see workerCountFor), so they claim parts 1-3 up
    // front. The barrier holds all three PUTs until every one of them has
    // STARTED — only then is Pause pressed, so all three are provably
    // in flight before the flag exists. The gate then releases them, each
    // finishes, and each worker loops back round to waitIfPaused and parks.
    //
    // What the code guarantees is about CLAIMS: once paused, the loop
    // claims nothing further. So parts 4-6 must never be touched — not
    // presigned, not PUT — while parts 1-3 must all COMPLETE rather than
    // be aborted. Both halves matter: a pause that killed in-flight parts
    // would throw away bytes that were nearly there.
    const file6 = makeFile("pause-six.mxf", 6, PART);
    const WORKERS = freeframe.workerCountFor(PART, 6);

    let paused = false;
    let pressedPause = false;
    let waiters = [];
    let onParked;
    const allParked = new Promise((r) => { onParked = r; });
    const waitIfPaused = () => {
      if (!paused) return Promise.resolve();
      return new Promise((r) => {
        waiters.push(r);
        if (waiters.length >= WORKERS) onParked();
      });
    };
    const resume = () => {
      paused = false;
      const w = waiters; waiters = [];
      w.forEach((r) => r());
    };

    let openGate;
    const gate = new Promise((r) => { openGate = r; });
    let openBarrier;
    const barrier = new Promise((r) => { openBarrier = r; });

    const calls = server({
      partSize: PART,
      onPutStarted: (_part, c) => {
        // Every one of the claimed parts is in flight. Pause is pressed
        // HERE rather than after a delay, which is what removes the race.
        //
        // ONCE. Without the guard this condition is true for every later
        // part too, so the job re-paused itself the instant it resumed and
        // the scenario deadlocked — caught by this scenario's own timeout.
        if (!pressedPause && c.putsStarted.length >= WORKERS) {
          pressedPause = true;
          paused = true;
          openBarrier();
        }
      },
      // Held until the barrier says all workers are in flight, then until
      // the gate opens. Two stages, because "paused while in flight" and
      // "allowed to finish" are different moments.
      partBehaviour: () => ({ status: 200, waitFor: barrier.then(() => gate) }),
    });

    const done = freeframe.uploadFile({
      projectId: "p", filePath: file6, assetName: "six.mxf",
      retry: cfg, waitIfPaused,
    });

    await barrier;
    openGate();
    await allParked;

    const started = [...calls.putsStarted].sort((a, b) => a - b);
    const finished = [...calls.putsFinished].sort((a, b) => a - b);
    check(started.length === WORKERS, `only the ${WORKERS} already-claimed parts started`,
      JSON.stringify(started));
    check(finished.length === WORKERS, "and every one of them FINISHED rather than being aborted",
      JSON.stringify(finished));
    check(JSON.stringify(started) === JSON.stringify(finished),
      "nothing was left half-sent", `${JSON.stringify(started)} vs ${JSON.stringify(finished)}`);
    const presigned = [...calls.presignByPart.keys()].sort((a, b) => a - b);
    check(presigned.length === WORKERS, "no further part was even presigned while paused",
      JSON.stringify(presigned));
    check(calls.abort === 0, "pause never aborts the S3 session", String(calls.abort));
    check(calls.complete === 0, "and never completes it early");

    resume();
    const res = await done;
    check(Boolean(res && res.assetId), "resume continues from the next unclaimed part");
    check(calls.putsStarted.length === 6, "all six parts eventually went",
      String(calls.putsStarted.length));
    check(calls.abort === 0, "still never aborted");
    check(calls.complete === 1, "and completed exactly once");
  });

  // ── 4 — resume after a crash ────────────────────────────────────────────

  await scenario("4. Resume sends only the parts the server does not have", async () => {
    session();
    const { cfg } = instantRetry();
    const st = fs.statSync(file3);
    // Parts 1 and 2 landed before the crash; part 3 did not.
    const calls = server({
      partSize: PART,
      existingParts: [
        { PartNumber: 1, ETag: '"e1"', Size: PART },
        { PartNumber: 2, ETag: '"e2"', Size: PART },
      ],
    });

    const progress = [];
    const res = await freeframe.uploadFile({
      projectId: "p", filePath: file3, assetName: "three.mxf", retry: cfg,
      onProgress: (p) => progress.push(p),
      resumeSession: {
        s3Key: "k/1", uploadId: "u-old", assetId: "a-1", versionId: "v-1",
        partSize: PART, size: st.size, mtimeMs: st.mtimeMs,
      },
    });

    check(calls.initiate === 0, "no new upload was initiated", String(calls.initiate));
    check(calls.parts === 1, "asked the server once what it already had", String(calls.parts));
    check(JSON.stringify(calls.putsStarted) === "[3]", "only part 3 was PUT",
      JSON.stringify(calls.putsStarted));
    check(res.partsAlreadyPresent === 2, "reports 2 parts already present",
      String(res.partsAlreadyPresent));
    // Progress starts at the bytes already there, not at 0%.
    check(progress.length > 0 && progress[0].uploaded === st.size,
      "progress counts the pre-existing bytes", String(progress[0] && progress[0].uploaded));
    check(res.resumedBytes === 2 * PART, "and says how many were already there",
      String(res.resumedBytes));
    const sent = (calls.completeBody || {}).parts || [];
    check(sent.length === 3, "complete got the merged list of all three parts", String(sent.length));
    check(JSON.stringify(sent.map((p) => p.PartNumber)) === "[1,2,3]",
      "in part order", JSON.stringify(sent.map((p) => p.PartNumber)));
    check(sent[0].ETag === '"e1"', "reusing the ETags the server reported", sent[0].ETag);
  });

  await scenario("5. A listed part of the wrong size is re-uploaded, never trusted", async () => {
    session();
    const { cfg } = instantRetry();
    const st = fs.statSync(file3);
    // Part 2 is SHORT — a partial write. Completing an upload around it
    // would produce a corrupt object that passes every other check.
    const calls = server({
      partSize: PART,
      existingParts: [
        { PartNumber: 1, ETag: '"e1"', Size: PART },
        { PartNumber: 2, ETag: '"e2"', Size: PART - 17 },
        { PartNumber: 3, ETag: '"e3"', Size: PART },
      ],
    });

    const res = await freeframe.uploadFile({
      projectId: "p", filePath: file3, assetName: "three.mxf", retry: cfg,
      resumeSession: {
        s3Key: "k/1", uploadId: "u-old", assetId: "a-1", versionId: "v-1",
        partSize: PART, size: st.size, mtimeMs: st.mtimeMs,
      },
    });

    check(JSON.stringify(calls.putsStarted) === "[2]", "the short part was re-uploaded",
      JSON.stringify(calls.putsStarted));
    check(res.partsAlreadyPresent === 2, "the other two were trusted", String(res.partsAlreadyPresent));
    const sent = (calls.completeBody || {}).parts || [];
    check(sent[1] && sent[1].ETag === '"etag-2"',
      "complete carries the NEW ETag for the re-sent part", sent[1] && sent[1].ETag);
  });

  await scenario("6. A gone session starts a fresh upload instead of failing", async () => {
    session();
    const { cfg } = instantRetry();
    const st = fs.statSync(file3);
    const calls = server({ partSize: PART, partsGone: true });

    let err = null, res = null;
    try {
      res = await freeframe.uploadFile({
        projectId: "p", filePath: file3, assetName: "three.mxf", retry: cfg,
        resumeSession: {
          s3Key: "k/1", uploadId: "u-old", assetId: "a-1", versionId: "v-1",
          partSize: PART, size: st.size, mtimeMs: st.mtimeMs,
        },
      });
    } catch (e) { err = e; }

    check(!err, "does not fail the file", String(err && err.message));
    check(calls.initiate === 1, "a fresh upload was initiated", String(calls.initiate));
    check(calls.putsStarted.length === 3, "and every part was sent",
      JSON.stringify(calls.putsStarted));
    check(res && /no longer existed/.test(String(res.freshBecause || "")),
      "and it says why it started over", String(res && res.freshBecause));
    check(calls.abort === 0, "nothing was aborted — there was nothing to abort",
      String(calls.abort));
  });

  await scenario("7. A changed source is never resumed into the old session", async () => {
    session();
    const { cfg } = instantRetry();
    const st = fs.statSync(file3);
    const calls = server({ partSize: PART });

    const res = await freeframe.uploadFile({
      projectId: "p", filePath: file3, assetName: "three.mxf", retry: cfg,
      resumeSession: {
        s3Key: "k/1", uploadId: "u-old", assetId: "a-1", versionId: "v-1",
        // Same size, DIFFERENT mtime: the file was replaced. Splicing two
        // different files into one object and completing it as whole is the
        // one outcome worse than re-uploading.
        partSize: PART, size: st.size, mtimeMs: st.mtimeMs - 50_000,
      },
    });

    check(calls.parts === 0, "never even asked what the old session held", String(calls.parts));
    check(calls.initiate === 1, "a fresh upload was initiated", String(calls.initiate));
    check(calls.abort === 1, "the stale session was aborted — it can never be completed",
      String(calls.abort));
    check(calls.abortBody && calls.abortBody.upload_id === "u-old",
      "and it was the OLD session that was aborted", JSON.stringify(calls.abortBody));
    check(/source file changed/.test(String(res.freshBecause || "")),
      "and it says why", String(res.freshBecause));
  });

  await scenario("8. A size mismatch is caught the same way", async () => {
    // Paired with 7 deliberately: an implementation checking only mtime
    // passes 7 and fails here, and one checking only size does the reverse.
    const st = fs.statSync(file3);
    const match = freeframe.uploadSessionMatchesSource;
    const base = { s3Key: "k", uploadId: "u", size: st.size, mtimeMs: st.mtimeMs };
    check(match(base, st) === true, "an unchanged file matches");
    check(match({ ...base, size: st.size - 1 }, st) === false, "a different size does not");
    check(match({ ...base, mtimeMs: st.mtimeMs + 1000 }, st) === false, "a different mtime does not");
    check(match({ ...base, s3Key: null }, st) === false, "a session with no key is unusable");
    check(match(null, st) === false, "no session at all");
  });

  // ── 9 — an expired login parks, it does not fail ───────────────────────

  await scenario("9. A 401 that cannot refresh parks the upload, then continues", async () => {
    session();
    const { cfg } = instantRetry();
    // The refresh fails while `signedIn` is false, which is the case
    // `apiRequest`'s own refresh-once cannot rescue. It starts working when
    // the user signs in — and the sign-in is triggered by an OBSERVED
    // event: the second 401 on part 1.
    let signedIn = false;
    let parks = 0;
    const calls = server({
      partSize: PART,
      refreshOk: () => signedIn,
      partBehaviour: (part, attempt) => {
        if (part === 1 && attempt <= 2) return { status: 401 };
        return { status: 200 };
      },
    });

    const notes = [];
    const res = await freeframe.uploadFile({
      projectId: "p", filePath: file1, assetName: "one.mxf", retry: cfg,
      onRetry: (n) => { notes.push(n); },
      waitForAuth: async () => {
        parks++;
        // What a real sign-in does. Counted, so "it parked" is observable.
        if (parks >= 2) signedIn = true;
      },
    });

    check(Boolean(res && res.assetId), "the file uploads once a session exists again");
    check(parks === 2, "it parked rather than failing, once per 401", String(parks));
    check(calls.abort === 0, "an expired login never aborts the upload", String(calls.abort));
    check(notes.some((n) => n.waitingFor === "auth"),
      "and the job reports the sign-in state distinctly");
    // The attempt counter must not advance on a park: a sign-in wait is not
    // a backoff, and counting it would burn an injected budget.
    check(notes.filter((n) => n.waitingFor === "auth").every((n) => n.attempt === 1),
      "a park does not consume a retry attempt",
      JSON.stringify(notes.filter((n) => n.waitingFor === "auth").map((n) => n.attempt)));
  });

  // ── 10 — the server decides the part size ──────────────────────────────

  await scenario("10. The part size comes from the server, with a fallback", async () => {
    session();
    const { cfg } = instantRetry();
    // 12 MiB parts over a 12 MiB file -> one part. A client still using its
    // own 16 MiB would also send one part, so the file is sized so the two
    // answers DIFFER: 3 parts at 4 MiB, 1 at 16 MiB.
    const calls = server({ partSize: 4 * MIB });
    const res = await freeframe.uploadFile({
      projectId: "p", filePath: file3, assetName: "three.mxf", retry: cfg,
    });
    check(res.partSize === 4 * MIB, "used the server's part_size", String(res.partSize));
    check(res.totalParts === 3, "and split the file accordingly", String(res.totalParts));
    check(calls.putsStarted.length === 3, "three PUTs, not one",
      JSON.stringify(calls.putsStarted));

    // An api that predates §213 sends no part_size at all.
    const old = server({ partSize: undefined });
    global.fetch = ((inner) => async (url, opts) => {
      if (String(url).endsWith("/upload/initiate")) {
        return json({ s3_key: "k/1", upload_id: "u-1", asset_id: "a-1", version_id: "v-1" });
      }
      return inner(url, opts);
    })(global.fetch);
    const res2 = await freeframe.uploadFile({
      projectId: "p", filePath: file3, assetName: "three.mxf", retry: cfg,
    });
    check(res2.partSize === freeframe.PART_SIZE,
      "falls back to the client's own size when the field is absent", String(res2.partSize));
    check(old.putsStarted.length === 1, "which for this file is a single part",
      JSON.stringify(old.putsStarted));
  });

  await scenario("11. Concurrency is bounded by a memory budget, not a constant", async () => {
    // Why this is asserted at all: each worker holds a whole part in a
    // Buffer, because a presigned PUT needs a known Content-Length. At the
    // 512 MiB parts §214 makes possible, a fixed 3 workers would mean
    // 1.5 GiB resident for one file.
    const w = freeframe.workerCountFor;
    const budget = freeframe.PART_BUFFER_BUDGET_BYTES;
    check(w(16 * MIB, 100) === freeframe.CONCURRENT_PARTS,
      "16 MiB parts get the full worker count", String(w(16 * MIB, 100)));
    check(w(90 * MIB, 100) === freeframe.CONCURRENT_PARTS,
      "so do 90 MiB parts (today's cap)", String(w(90 * MIB, 100)));
    check(w(512 * MIB, 100) === 1, "512 MiB parts drop to one worker", String(w(512 * MIB, 100)));
    for (const size of [1, 4 * MIB, 16 * MIB, 90 * MIB, 256 * MIB, 512 * MIB, 5 * 1024 * MIB]) {
      check(w(size, 100) * size <= Math.max(budget, size),
        `never over budget at ${(size / MIB).toFixed(0)} MiB parts`,
        `${w(size, 100)} x ${(size / MIB).toFixed(0)} MiB`);
      check(w(size, 100) >= 1, "always at least one worker");
    }
    check(w(4 * MIB, 2) === 2, "and never more workers than there are parts", String(w(4 * MIB, 2)));
  });

  // ── 12 — the journal carries the session ───────────────────────────────

  await scenario("12. The journal records the session before the first part", async () => {
    const dir = path.join(tmp, "journals");
    const job = { id: "job-213", label: "CARD_A", kind: "upload", destPaths: [] };
    await journal.startJournal(dir, job, { projectId: "p1", folderId: null });

    const doc0 = await journal.readJournal(dir, job.id);
    check(doc0 && typeof doc0.sessions === "object", "a fresh journal has a sessions map");
    check(journal.uploadSessionFor(doc0, "A001.mxf") === null, "and nothing in it yet");

    await journal.recordUploadSession(job.id, "A001.mxf", {
      s3Key: "k/1", uploadId: "u-1", assetId: "a-1", versionId: "v-1",
      partSize: 4 * MIB, totalParts: 3, size: 12 * MIB, mtimeMs: 1234,
    });
    const doc1 = await journal.readJournal(dir, job.id);
    const s1 = journal.uploadSessionFor(doc1, "A001.mxf");
    check(Boolean(s1), "the session survives a read back from disk");
    check(s1.uploadId === "u-1" && s1.partSize === 4 * MIB,
      "with the upload id and the part size the run used");
    check(s1.size === 12 * MIB && s1.mtimeMs === 1234,
      "and the source identity a resume has to re-check");

    // A session without a key is not a session.
    await journal.recordUploadSession(job.id, "B001.mxf", { partSize: 1 });
    check(journal.uploadSessionFor(await journal.readJournal(dir, job.id), "B001.mxf") === null,
      "an incomplete session is not recorded");

    await journal.clearUploadSession(job.id, "A001.mxf");
    check(journal.uploadSessionFor(await journal.readJournal(dir, job.id), "A001.mxf") === null,
      "a finished file's session is dropped, not left to be resumed");

    // Pause survives a quit — including when nothing holds the journal.
    await journal.setPaused(dir, job.id, true);
    check((await journal.readJournal(dir, job.id)).paused === true, "pause is persisted");
    journal.releaseJournal(job.id);
    await journal.setPaused(dir, job.id, true);
    check((await journal.readJournal(dir, job.id)).paused === true,
      "and can be set with the journal only on disk");
    await journal.setPaused(dir, job.id, false);
    check((await journal.readJournal(dir, job.id)).paused === false, "and cleared again");

    // A version-1 journal has neither field. It must still read.
    const legacy = path.join(dir, "legacy.journal.json");
    fs.writeFileSync(legacy, JSON.stringify({
      freeframeJobJournal: 1, status: "running", jobId: "legacy", kind: "upload", files: [],
    }));
    const old = await journal.readJournal(dir, "legacy");
    check(Boolean(old), "a pre-§213 journal still parses");
    check(journal.uploadSessionFor(old, "x") === null, "and simply has no session to resume");
  });

  // ── 13 — which jobs resume by themselves ───────────────────────────────

  await scenario("13. Automatic resume fires when the setting is on, and not when off", async () => {
    const up = { jobId: "u1", kind: "upload", startedAt: "2026-10-01T10:00:00Z" };
    const up2 = { jobId: "u2", kind: "upload", startedAt: "2026-10-01T11:00:00Z" };
    const copy = { jobId: "c1", kind: "copy", startedAt: "2026-10-01T09:00:00Z" };
    const base = { trigger: "launch", loggedIn: true, alreadyOffered: new Set() };

    let r = planResumeSweep({ ...base, docs: [up, up2], autoResume: true });
    check(r.auto.length === 2, "both uploads resume automatically", String(r.auto.length));
    check(r.prompt === null, "and nothing is asked about");

    r = planResumeSweep({ ...base, docs: [up, up2], autoResume: false });
    check(r.auto.length === 0, "with the setting off, nothing resumes by itself");
    check(r.prompt && r.prompt.jobId === "u2", "the newest is offered instead",
      String(r.prompt && r.prompt.jobId));

    r = planResumeSweep({ ...base, docs: [up], autoResume: true, loggedIn: false });
    check(r.auto.length === 0, "signed out, nothing starts on its own");
    check(r.prompt && r.prompt.jobId === "u1", "it is offered instead");

    r = planResumeSweep({ ...base, docs: [up, copy], autoResume: true });
    check(r.auto.length === 1 && r.auto[0].jobId === "u1", "a COPY never resumes silently");
    check(r.prompt && r.prompt.jobId === "c1", "the copy is asked about",
      String(r.prompt && r.prompt.jobId));

    r = planResumeSweep({
      ...base, autoResume: true,
      docs: [{ ...up, paused: true }],
    });
    check(r.auto.length === 1, "a paused job is still resumed");
    check(r.auto[0].startPaused === true,
      "but it comes back PAUSED — auto-resume may not undo a deliberate stop");

    r = planResumeSweep({
      ...base, autoResume: true,
      docs: [{ ...up, hiddenFromPrompt: true }],
    });
    check(r.auto.length === 0 && r.prompt === null,
      "a job the user parked is neither resumed nor re-offered");

    r = planResumeSweep({
      ...base, autoResume: true, alreadyOffered: new Set(["u1"]), docs: [up],
    });
    check(r.auto.length === 0 && r.prompt === null, "and nothing is handled twice");

    // trigger "source" — only what matches the selection now.
    r = planResumeSweep({
      docs: [up, up2], trigger: "source", autoResume: true, loggedIn: true,
      alreadyOffered: new Set(), matchesSource: (d) => d.jobId === "u2",
    });
    check(r.auto.length === 1 && r.auto[0].jobId === "u2",
      "a re-selected source resumes only its own job", JSON.stringify(r.auto.map((d) => d.jobId)));

    check(planResumeSweep({ ...base, docs: [], autoResume: true }).prompt === null,
      "nothing to do with no journals");
  });

  global.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
