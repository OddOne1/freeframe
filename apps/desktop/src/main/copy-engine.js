// Checksummed drive-to-drive copy — SECURE tier.
//
// Copy-mode tiers (naming borrowed from ingesto as a *concept*, not code —
// see CLAUDE.md's roadmap on the GPL/MIT split): FAST = no checks,
// VERIFIED = size only, SECURE = copy + xxHash64 verify, PRO = full
// checksum lists + ASC MHL + optional double source read. Only SECURE is
// implemented here; the others are deliberate follow-ups.
//
// Deliberately free of any `electron` import. This module is plain Node so
// it can be exercised directly by `scripts/test-copy.js` against real
// files without booting an Electron window — the copy path the app runs is
// the copy path the test runs.
//
// Two design points that matter more than they look:
//
//  1. **The source is read exactly once**, no matter how many destinations
//     there are. One read stream fans out to N write streams and feeds the
//     hasher at the same time. Re-reading per destination would multiply
//     wear and time on the one device you least want to stress — a camera
//     card that hasn't been backed up yet.
//  2. **Verification re-reads each destination from disk.** Hashing the
//     bytes we just held in memory would only prove we hashed our own
//     buffer correctly; it would sail straight past a truncated write, a
//     full disk, or a failing cable. The whole point of SECURE is proving
//     what actually landed.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { getHasherFactory, DEFAULT_ALGORITHM, ALGORITHMS } = require("./hashers");
const { applyFilters } = require("./filters");
const { fragileRenameExtensions } = require("./naming");

// 4 MiB. Large enough that per-chunk overhead is irrelevant on big media
// files, small enough that N destinations * this stays modest in memory.
const CHUNK_SIZE = 4 * 1024 * 1024;

// The live hasher factory for the current job. Set once at the start of
// runCopyJob and read by the copy and verify paths, which MUST agree: a
// file hashed with one algorithm and verified with another would report a
// mismatch on a perfectly good copy.
let makeHasher = null;

/** Recursively list every file under `root`, as paths relative to it.
 *  Directories are not returned as entries — they're recreated implicitly
 *  from each file's relative path, so an empty directory tree is not
 *  preserved. Symlinks are skipped rather than followed: following them
 *  can escape the source tree entirely and silently copy unrelated data. */
/**
 * A **source provider** — everything the engine needs from "wherever the
 * bytes come from", and nothing else:
 *
 *   kind   — for messages and for the checks that are filesystem-specific
 *   label  — what to call it in the summary
 *   root   — the local path, for a local source only; null otherwise
 *   list() — [{ rel, size }]
 *   open(rel) — a Readable of that file's bytes
 *
 * **Contract for open():** the chunks it emits must own their memory. The
 * engine hashes a chunk synchronously and then passes that same object to
 * an asynchronous write, so a provider that yields views into a buffer it
 * later reuses will produce files of the correct length with corrupted
 * contents — and a source hash that looks perfectly fine. A TLS fetch body
 * does exactly this; see the copy in freeframe.js's openAssetStream.
 * fs.createReadStream already satisfies the contract, which is why the
 * local path does no copying.
 *
 * This exists so a FreeFrame project can be a source (item 3) without being
 * forced through the local-filesystem read path — no staging directory, no
 * download-then-copy pass that would write every byte twice and defeat the
 * point of verifying what actually landed. Once `open()` hands back a
 * stream, the fan-out, the hashing, and the read-back-from-disk
 * verification are all bit-for-bit the same code they were.
 *
 * The FreeFrame provider is *injected* by main.js rather than built here:
 * it needs the API client, which imports electron, and this module's whole
 * point is that it doesn't (see the header). A fake provider is also how
 * scripts/test-copy.js exercises the non-local path without a server.
 */
function localSource(root) {
  return {
    kind: "local",
    label: root,
    root,
    list: async () => {
      const rels = await listFilesRecursive(root);
      const out = [];
      for (const rel of rels) {
        const st = await fsp.stat(path.join(root, rel));
        out.push({ rel, size: st.size });
      }
      return out;
    },
    open: (rel) => fs.createReadStream(path.join(root, rel), { highWaterMark: CHUNK_SIZE }),
  };
}

/**
 * One or more individually-chosen files, with no directory to walk.
 *
 * A separate provider rather than a special case inside localSource,
 * because the two differ in the one place that matters: a directory source
 * has a root that destination paths must be checked against, and a set of
 * hand-picked files has no common root at all. Everything downstream — the
 * fan-out, the hashing, the read-back verification — is identical.
 */
function localFilesSource(filePaths) {
  const byRel = new Map();
  for (const f of filePaths) {
    const rel = path.basename(f);
    if (byRel.has(rel)) {
      // Silently suffixing one of them would hand back a file the user
      // didn't name; silently overwriting would lose one. Neither belongs
      // in a tool whose job is not losing footage.
      throw new Error(
        `Two selected files are both named "${rel}". Rename one, or select their folder instead.`
      );
    }
    byRel.set(rel, f);
  }

  return {
    kind: "local-files",
    label: filePaths.length === 1 ? filePaths[0] : `${filePaths.length} selected files`,
    root: null,
    files: [...filePaths],
    list: async () => {
      const out = [];
      for (const [rel, full] of byRel) {
        const st = await fsp.stat(full);
        if (!st.isFile()) throw new Error(`Not a file: ${full}`);
        out.push({ rel, size: st.size });
      }
      return out;
    },
    open: (rel) => fs.createReadStream(byRel.get(rel), { highWaterMark: CHUNK_SIZE }),
  };
}

async function listFilesRecursive(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        // macOS scatters these through every removable volume; copying
        // them is noise at best and confusing in a verification report.
        if (entry.name === ".DS_Store") continue;
        out.push(path.relative(root, full));
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Copy one file to N destinations from a single source read, hashing the
 * source as those bytes go past.
 *
 * Backpressure is handled explicitly: if any destination's write buffer
 * fills, the source read pauses until every destination has drained.
 * Without that, a fast source feeding one slow destination buffers the
 * difference in memory — which on a 200 GB card offload is not a small
 * mistake.
 *
 * @returns {Promise<{sourceHash: string, bytes: number}>}
 */
async function copyOneFileFanOut(openRead, destPaths, onBytes) {
  // Resolved before the Promise constructor deliberately: an `async`
  // executor swallows its own rejections (the constructor ignores the
  // returned promise), so a hasher-init failure in here would hang the
  // copy forever instead of surfacing.
  const factory = makeHasher || (await getHasherFactory(DEFAULT_ALGORITHM));

  // Opened before the constructor for the same reason — a FreeFrame source
  // has to make an HTTP request to get its stream, and a rejection from
  // that inside an async executor would hang rather than fail.
  const readStream = await openRead();

  return new Promise((resolve, reject) => {
    const hasher = factory();

    const writeStreams = destPaths.map((p) => fs.createWriteStream(p));

    let bytes = 0;
    let settled = false;
    let pendingDrains = 0;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      readStream.destroy();
      for (const ws of writeStreams) ws.destroy();
      reject(err);
    };

    readStream.on("error", fail);
    for (const ws of writeStreams) ws.on("error", fail);

    readStream.on("data", (chunk) => {
      if (settled) return;
      hasher.update(chunk);
      bytes += chunk.length;
      if (onBytes) onBytes(chunk.length);

      let anyBackpressure = false;
      for (const ws of writeStreams) {
        // write() returning false means this stream's buffer is over its
        // high-water mark — keep writing to the others, but don't pull
        // more from the source until they've all caught up.
        if (!ws.write(chunk)) anyBackpressure = true;
      }

      if (anyBackpressure) {
        readStream.pause();
        pendingDrains = writeStreams.length;
        for (const ws of writeStreams) {
          // once(): a stream already below its watermark never emits
          // 'drain', so ask each one individually and count them in.
          if (ws.writableLength === 0) {
            if (--pendingDrains === 0) readStream.resume();
          } else {
            ws.once("drain", () => {
              if (--pendingDrains === 0 && !settled) readStream.resume();
            });
          }
        }
      }
    });

    readStream.on("end", () => {
      if (settled) return;
      let remaining = writeStreams.length;
      for (const ws of writeStreams) {
        ws.end(() => {
          // 'finish' fires when the stream's own buffer is flushed; the
          // callback form of end() is the documented point at which the
          // underlying fd has been closed.
          if (--remaining === 0 && !settled) {
            settled = true;
            resolve({ sourceHash: hasher.digest(), bytes });
          }
        });
      }
    });
  });
}

/** Read a file back off disk and hash it. Separate pass on purpose — see
 *  the module header. */
async function hashFileOnDisk(filePath, algorithm = null) {
  const factory = algorithm
    ? await getHasherFactory(algorithm)
    : makeHasher || (await getHasherFactory(DEFAULT_ALGORITHM));
  const hasher = factory();
  const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest();
}

/**
 * Copy `relFiles` from one root into N destination roots, from a single
 * source read, verifying each written file.
 *
 * Split out of runCopyJob so a cascaded leg (A → B) runs the exact same
 * code path as the primary leg (source → A) — the only difference is which
 * source provider it reads from. A cascaded leg is always a local one; only
 * the primary leg can be reading from FreeFrame.
 */
async function runLeg({ from, toRoots, relFiles, sizes, onFileEvent, isCancelled, mapRel }) {
  const fileResults = [];

  for (const rel of relFiles) {
    if (isCancelled()) break;

    // `mapRel` applies the job's naming template. Only the ROOT leg gets
    // one: a cascaded leg reads from a destination whose layout is already
    // the mapped one, so applying it again would nest the template inside
    // itself and, worse, break the byte-for-byte correspondence the
    // cascade's verification depends on.
    const destRel = mapRel ? mapRel(rel) : rel;
    const destFiles = toRoots.map((d) => path.join(d, destRel));
    const size = sizes.get(rel) ?? 0;

    onFileEvent({ type: "file-start", file: rel, bytes: size });

    const entry = { file: rel, bytes: size, sourceHash: null, destinations: [], ok: false, error: null };

    try {
      await Promise.all(destFiles.map((f) => fsp.mkdir(path.dirname(f), { recursive: true })));

      const { sourceHash } = await copyOneFileFanOut(() => from.open(rel), destFiles, (n) => {
        onFileEvent({ type: "bytes", file: rel, delta: n });
      });
      entry.sourceHash = sourceHash;

      onFileEvent({ type: "verifying", file: rel });

      const verifications = await Promise.all(
        destFiles.map(async (destFile, i) => {
          try {
            const destHash = await hashFileOnDisk(destFile);
            const destSize = (await fsp.stat(destFile)).size;
            return {
              destRoot: toRoots[i],
              path: destFile,
              hash: destHash,
              bytes: destSize,
              // Size is checked alongside the hash because a zero-byte file
              // has a valid, stable hash of its own — matching hashes alone
              // wouldn't catch source and destination both being empty for
              // different reasons.
              ok: destHash === sourceHash && destSize === size,
              error: null,
            };
          } catch (err) {
            return { destRoot: toRoots[i], path: destFile, hash: null, bytes: null, ok: false, error: String(err.message || err) };
          }
        })
      );

      entry.destinations = verifications;
      entry.ok = verifications.every((v) => v.ok);
    } catch (err) {
      entry.error = String(err.message || err);
      entry.ok = false;
    }

    fileResults.push(entry);
    onFileEvent({ type: "file-done", file: rel, ok: entry.ok });
  }

  return fileResults;
}

/** Per-destination-root outcome extracted from one leg's file results. */
function summarizeRoot(root, fileResults, expectedFileCount) {
  const mismatches = [];
  const errors = [];
  let verified = 0;

  for (const f of fileResults) {
    if (f.error) {
      errors.push({ file: f.file, destRoot: root, error: f.error });
      continue;
    }
    const d = f.destinations.find((x) => x.destRoot === root);
    if (!d) continue;
    if (d.error) errors.push({ file: f.file, destRoot: root, error: d.error });
    else if (!d.ok) mismatches.push({ file: f.file, destRoot: root, sourceHash: f.sourceHash, destHash: d.hash });
    else verified += 1;
  }

  return {
    filesVerified: verified,
    mismatches,
    errors,
    ok: verified === expectedFileCount && mismatches.length === 0 && errors.length === 0,
  };
}

/**
 * Run a copy job over a **tree** of destinations.
 *
 * `nodes` is a flat list where each node optionally names a `parentId`:
 *
 *   parentId === null  → copies from the original source
 *   parentId === "x"   → copies from node x, and only after x has copied
 *                        AND verified successfully (a cascade)
 *
 * Why a parent-per-node tree rather than, say, an explicit list of chains:
 * it expresses today's flat 1→N case, v1's single cascade (source → A → B),
 * and Hedge's fan-out (one destination feeding several children) with no
 * structural change — fan-out falls out for free as "several nodes sharing
 * a parentId". Multiple independent cascading groups likewise. Neither is
 * built in the UI for v1, but the data model doesn't have to be revisited
 * to add them.
 *
 * Execution is by dependency wave: every node whose parent is finished and
 * verified becomes ready, ready nodes are grouped by the root they read
 * from, and each group runs as one fan-out copy — so nodes sharing a source
 * still read that source exactly once, and independent groups run in
 * parallel. A node whose parent failed is marked `skipped` and never
 * copies: cascading from an unverified copy would propagate corruption
 * while reporting success, which is the one thing this tool must not do.
 *
 * **Cascaded legs copy this job's file list, not the parent's whole
 * contents.** If destination A already held unrelated footage, cascading
 * A → B must not sweep that up too — the user asked to pass *this offload*
 * onward, not to mirror the drive.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath
 * @param {Array<{id: string, path: string, parentId?: string|null}>} [opts.nodes]
 * @param {string[]} [opts.destPaths] - legacy flat form, treated as parentless nodes
 * @param {(p: object) => void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled]
 */
async function runCopyJob({
  sourcePath, sourceFiles, source, nodes, destPaths, algorithm = DEFAULT_ALGORITHM,
  onProgress = () => {}, isCancelled = () => false,
  // (rel) => destination-relative path. Null keeps the pre-existing
  // behaviour of mirroring the source tree exactly, so every existing
  // caller and test is untouched.
  mapRel = null,
  // Opt-in copy filtering (§23c). Null — the default, and what every
  // preset predating this produces — means no filtering whatsoever.
  filters = null,
  // Rename-fragility guard (§23d). `renamesFiles` says the job's naming
  // preset actually renames files (a folder-only template does not), and
  // `allowFragileRename` is the user's explicit per-job acknowledgement.
  renamesFiles = false,
  allowFragileRename = false,
  // §86 — the optional second pass. Null (the default, and what every
  // existing caller and test produces) means it does not run at all.
  finalizedAlgorithm = null,
}) {
  const startedAt = Date.now();

  // Three accepted forms: `source` (a provider — how a FreeFrame project
  // gets in), `sourceFiles` (individually-chosen files), and `sourcePath`
  // (a local directory, the original and still the default, so every
  // existing caller and test is untouched).
  let src = source || (Array.isArray(sourceFiles) && sourceFiles.length ? localFilesSource(sourceFiles) : null);
  if (!src) {
    if (typeof sourcePath !== "string" || !sourcePath) throw new Error("A source is required");
    // A path that turns out to be a file is treated as a one-file set
    // rather than rejected. Callers reach here from a native picker and
    // from an OS drag-and-drop, and neither knows which it handed over
    // until it's looked; failing on it would be a technicality.
    const st = await fsp.stat(sourcePath);
    src = st.isDirectory() ? localSource(sourcePath) : localFilesSource([sourcePath]);
  }
  // The summary and the progress events still report a single source
  // identity, whatever kind it is.
  sourcePath = src.root || src.label;

  // Resolved once, up front, so every leg of this job — copy and verify
  // alike — uses the same algorithm. Throws here rather than mid-copy if
  // the name is unknown.
  makeHasher = await getHasherFactory(algorithm);

  // Accept the old flat shape so existing callers/tests keep working; it's
  // exactly a tree where every node is parentless.
  const jobNodes =
    Array.isArray(nodes) && nodes.length
      ? nodes.map((n, i) => ({ id: n.id || `n${i}`, path: n.path, parentId: n.parentId ?? null }))
      : (destPaths || []).map((p, i) => ({ id: `n${i}`, path: p, parentId: null }));

  if (jobNodes.length === 0) throw new Error("At least one destination is required");

  const byId = new Map(jobNodes.map((n) => [n.id, n]));
  for (const n of jobNodes) {
    if (n.parentId !== null && !byId.has(n.parentId)) {
      throw new Error(`Destination ${n.path} references a parent that isn't in the job`);
    }
    if (n.parentId === n.id) throw new Error("A destination cannot cascade from itself");
  }
  // Cycles would deadlock the wave loop below rather than erroring.
  for (const n of jobNodes) {
    const seen = new Set([n.id]);
    let cur = n.parentId;
    while (cur) {
      if (seen.has(cur)) throw new Error("Cascade chain contains a cycle");
      seen.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
  }

  // A chosen file must not be written over by its own job — copying
  // /a/clip.mov into /a would do exactly that, and the read and the write
  // would be the same inode.
  if (src.files) {
    const sourceSet = new Set(src.files.map((f) => path.resolve(f)));
    for (const n of jobNodes) {
      for (const f of src.files) {
        if (sourceSet.has(path.resolve(n.path, path.basename(f)))) {
          throw new Error(`Destination ${n.path} already holds the selected file ${path.basename(f)}`);
        }
      }
    }
  }

  // Copying a destination into itself, or into a subdirectory of the
  // source, produces infinite recursion or silent self-overwrite. Cheap to
  // check, miserable to debug. Applied against each node's own effective
  // parent too, so a cascade can't nest into its own parent either.
  //
  // Only the *local* source can be nested with a local destination. A
  // remote source has no path to compare, so those three checks are skipped
  // for the root leg — but the cascade and duplicate checks below still
  // apply in full, because cascaded legs are local either way.
  const srcResolved = src.root ? path.resolve(src.root) : null;
  const seenPaths = new Set();
  for (const n of jobNodes) {
    const destResolved = path.resolve(n.path);
    const parentRoot = n.parentId ? path.resolve(byId.get(n.parentId).path) : srcResolved;
    if (parentRoot !== null) {
      if (destResolved === parentRoot) throw new Error(`Destination is the same as the source it copies from: ${n.path}`);
      if (destResolved.startsWith(parentRoot + path.sep)) throw new Error(`Destination is inside the source it copies from: ${n.path}`);
      if (parentRoot.startsWith(destResolved + path.sep)) throw new Error(`Source is inside the destination: ${n.path}`);
    }
    if (seenPaths.has(destResolved)) throw new Error(`Duplicate destination: ${n.path}`);
    seenPaths.add(destResolved);
  }

  onProgress({ phase: "scanning", sourcePath, nodes: jobNodes });

  // One listing call, whatever the source is. For FreeFrame this is the
  // single `GET /projects/{id}/assets?folder_id=…&recursive=…` that already
  // returns each asset's filename and byte size — no per-file round trip
  // just to build the manifest.
  const rawListing = await src.list();

  // ── Opt-in filtering (§23c) ──
  //
  // One choke point for every source kind, rather than inside
  // listFilesRecursive: that would cover a local directory and miss both a
  // hand-picked file set and a FreeFrame project. `filters` is null unless
  // a preset actually configured something, and applyFilters then returns
  // the listing untouched — the default is, and has to stay, copy
  // everything.
  const { kept: listing, skipped: filteredOut } = applyFilters(rawListing, filters);

  // ── Rename-fragility guard (§23d) ──
  //
  // Checked after listing and before any byte moves. These formats keep the
  // clip name inside the file or in a card-level index, so renaming them
  // breaks metadata linking in the manufacturer's own tools — Silverstack
  // refuses the same class of file for the same reason. Thrown rather than
  // silently skipping just those files: the user needs to know and decide,
  // and quietly copying some files renamed and others not would be worse
  // than either outcome they might have chosen.
  if (renamesFiles && !allowFragileRename) {
    const fragile = fragileRenameExtensions(listing.map((f) => f.rel));
    if (fragile.length) {
      const err = new Error(
        `This source contains ${fragile.map((f) => `${f.count} ${f.ext} file${f.count === 1 ? "" : "s"}`).join(" and ")}, ` +
        `whose clip names are referenced inside the files themselves or by a card-level index ` +
        `(${fragile.map((f) => f.reason).join("; ")}). Renaming them may break metadata linking in the camera ` +
        `manufacturer's own tools. Card-level index files such as MEDIAPRO.XML, INDEX.MIF and LASTCLIP.TXT ` +
        `describe several clips at once and cannot be kept in sync by renaming at all.`,
      );
      err.code = "RENAME_FRAGILE";
      err.fragile = fragile;
      throw err;
    }
  }

  const relFiles = listing.map((f) => f.rel);
  const sizes = new Map(listing.map((f) => [f.rel, f.size]));
  let totalBytes = 0;
  for (const f of listing) totalBytes += f.size;

  // Sidecar pairing and counter assignment need the whole list up front
  // (§23d). Optional on the mapper, so a caller that builds one without
  // this ever running keeps the original per-file behaviour.
  if (mapRel && typeof mapRel.prepare === "function") mapRel.prepare(relFiles);

  // Every leg moves the same payload, so total work scales with the number
  // of legs, not with destination count within a leg (a fan-out leg reads
  // once no matter how wide it is).
  const legCount = new Set(jobNodes.map((n) => n.parentId ?? "__root__")).size;

  const state = new Map(
    jobNodes.map((n) => [
      n.id,
      { ...n, status: "pending", filesVerified: 0, mismatches: [], errors: [], copiedBytes: 0, startedAt: null, finishedAt: null },
    ])
  );

  onProgress({
    phase: "start",
    totalFiles: relFiles.length,
    totalBytes,
    legCount,
    nodes: [...state.values()].map(publicNode),
  });

  let overallCopiedBytes = 0;
  const totalWork = totalBytes * legCount;
  let cancelled = false;

  // Dependency waves: keep running whatever is ready until nothing is.
  for (;;) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }

    const ready = [...state.values()].filter((n) => {
      if (n.status !== "pending") return false;
      if (n.parentId === null) return true;
      return state.get(n.parentId).status === "verified";
    });

    if (ready.length === 0) {
      // Anything still pending is downstream of a parent that didn't
      // verify. Mark it skipped rather than silently leaving it "pending"
      // in the summary.
      let changed = false;
      for (const n of state.values()) {
        if (n.status !== "pending") continue;
        const parent = state.get(n.parentId);
        if (parent && (parent.status === "failed" || parent.status === "skipped")) {
          n.status = "skipped";
          n.errors.push({ error: `Skipped — the destination it cascades from (${parent.path}) did not verify` });
          onProgress({ phase: "node-status", node: publicNode(n) });
          changed = true;
        }
      }
      if (!changed) break;
      continue;
    }

    // Group by the root each ready node reads from, so nodes sharing a
    // source still get a single fan-out read.
    const groups = new Map();
    for (const n of ready) {
      const from = n.parentId === null ? sourcePath : state.get(n.parentId).path;
      if (!groups.has(from)) groups.set(from, []);
      groups.get(from).push(n);
    }

    await Promise.all(
      [...groups.entries()].map(async ([fromKey, groupNodes]) => {
        // Root-leg nodes read from the job's source provider (which may be
        // remote); cascaded nodes always read from a local destination that
        // has already been verified on disk.
        const from = groupNodes[0].parentId === null ? src : localSource(fromKey);
        for (const n of groupNodes) {
          n.status = "copying";
          n.startedAt = Date.now();
          onProgress({ phase: "node-status", node: publicNode(n) });
        }

        const toRoots = groupNodes.map((n) => n.path);
        const fileResults = await runLeg({
          from,
          // Root leg only -- see the note in runLeg.
          mapRel: groupNodes[0].parentId === null ? mapRel : null,
          toRoots,
          relFiles,
          sizes,
          isCancelled,
          onFileEvent: (ev) => {
            if (ev.type === "bytes") {
              overallCopiedBytes += ev.delta;
              for (const n of groupNodes) n.copiedBytes += ev.delta;
              onProgress({
                phase: "bytes",
                file: ev.file,
                nodeIds: groupNodes.map((n) => n.id),
                copiedBytes: overallCopiedBytes,
                totalBytes: totalWork,
                percent: totalWork > 0 ? Math.min(100, (overallCopiedBytes / totalWork) * 100) : 100,
              });
            } else if (ev.type === "verifying") {
              for (const n of groupNodes) {
                if (n.status !== "verifying") {
                  n.status = "verifying";
                  onProgress({ phase: "node-status", node: publicNode(n) });
                }
              }
              onProgress({ phase: "verifying", file: ev.file, nodeIds: groupNodes.map((n) => n.id) });
            } else {
              onProgress({ phase: ev.type, file: ev.file, ok: ev.ok, nodeIds: groupNodes.map((n) => n.id) });
            }
          },
        });

        for (const n of groupNodes) {
          const rollup = summarizeRoot(n.path, fileResults, relFiles.length);
          n.filesVerified = rollup.filesVerified;
          n.mismatches = rollup.mismatches;
          n.errors.push(...rollup.errors);
          n.status = rollup.ok && !isCancelled() ? "verified" : "failed";
          n.finishedAt = Date.now();
          // §84 — the destination path survives the trim now. It already
          // existed one level up (runLeg computes it per destination), and
          // dropping it meant the log could say what was read and never
          // what was written — so a rename was invisible in the one file
          // someone opens to check exactly that.
          n.files = fileResults.map((f) => {
            const d = f.destinations.find((x) => x.destRoot === n.path);
            return {
              file: f.file,
              destPath: d?.path ?? null,
              bytes: f.bytes,
              sourceHash: f.sourceHash,
              ok: d?.ok ?? false,
            };
          });
          onProgress({ phase: "node-status", node: publicNode(n) });

          // The whole point of cascading (per Hedge's docs, and the reason
          // the user asked for it): once the primary leg verifies, the card
          // is free — the remaining hops read from the local copy, not the
          // card. Announce that explicitly rather than making the user
          // infer it from a progress bar.
          if (n.status === "verified" && n.parentId === null) {
            const anyRootStillRunning = [...state.values()].some(
              (o) => o.parentId === null && (o.status === "copying" || o.status === "verifying" || o.status === "pending")
            );
            if (!anyRootStillRunning) {
              onProgress({ phase: "source-released", sourcePath });
            }
          }
        }
      })
    );
  }

  // §86 — after every leg, before the summary is built.
  //
  // Gated on a real local sourcePath: a FreeFrame-upload-only job has no
  // local file left to re-read once the upload finished, and a job reading
  // FROM a project has no local source at all. Skipped rather than
  // errored — the live verification already happened and stands.
  let finalized = null;
  if (finalizedAlgorithm && sourcePath && !source && !cancelled) {
    finalized = await runFinalizedPass({
      sourcePath,
      nodes: [...state.values()],
      algorithm: finalizedAlgorithm,
      isCancelled,
      onProgress,
    });
  } else if (finalizedAlgorithm) {
    // Said out loud rather than left absent: "no finalized block" and "the
    // finalized pass could not run here" are different facts, and only one
    // of them means the user's setting did nothing.
    finalized = {
      algorithm: finalizedAlgorithm,
      algorithmLabel: ALGORITHMS[finalizedAlgorithm]?.label || finalizedAlgorithm,
      skipped: true,
      reason: cancelled
        ? "the job was cancelled"
        : "this job has no local source to re-read (FreeFrame upload or project source)",
      checked: 0, verified: 0, mismatches: [], errors: [], ok: false,
    };
  }

  const nodesOut = [...state.values()].map(publicNode);
  const allMismatches = nodesOut.flatMap((n) => n.mismatches);
  const allErrors = nodesOut.flatMap((n) => n.errors);

  const summary = {
    mode: "SECURE",
    algorithm: ALGORITHMS[algorithm]?.mhlName || algorithm,
    algorithmId: algorithm,
    algorithmLabel: ALGORITHMS[algorithm]?.label || algorithm,
    sourcePath,
    nodes: nodesOut,
    // Kept for callers that only care about "where did it all go".
    destPaths: jobNodes.map((n) => n.path),
    cancelled,
    totalFiles: relFiles.length,
    totalBytes,
    copiedBytes: overallCopiedBytes,
    legCount,
    // With a tree there is no single "files verified" number — one file
    // verified into three destinations is three verifications. Counted as
    // (file, destination) pairs, with the matching denominator, so the UI
    // can't accidentally show "4 of 4" for a job that only finished one of
    // three legs.
    fileCopiesVerified: nodesOut.reduce((sum, n) => sum + n.filesVerified, 0),
    totalFileCopies: relFiles.length * nodesOut.length,
    mismatches: allMismatches,
    errors: allErrors,
    // The only line that should decide whether a card is safe to wipe.
    allVerified:
      !cancelled &&
      nodesOut.length > 0 &&
      nodesOut.every((n) => n.status === "verified") &&
      allMismatches.length === 0 &&
      allErrors.length === 0,
    durationMs: Date.now() - startedAt,
    // What the filter chose not to take, and why (§23c). Reported rather
    // than omitted: a tool that silently drops files is indistinguishable
    // from one that loses them, and this is the record that says otherwise.
    filteredOut,
    // §86 — its own block, never folded into the live numbers above. A
    // reader has to be able to tell which tier verified what.
    finalized,
    // Flattened per-file view across every node, for callers that want it.
    files: nodesOut.flatMap((n) => (n.files || []).map((f) => ({ ...f, nodeId: n.id, destRoot: n.path }))),
  };

  onProgress({ phase: "done", summary });
  return summary;
}

/**
 * §86 — the optional finalized pass.
 *
 * The live check hashes the source as its bytes stream past during the
 * copy, then re-reads each destination and compares. That leaves one gap
 * it cannot close by construction: a transient read error during the copy
 * would hash the corrupted bytes and then match them against a destination
 * written from those same bytes — a clean result for a bad file. This pass
 * closes it by reading the source AGAIN, from disk, afterwards.
 *
 * BE CLEAR ABOUT THE COST: this is a full second read of the source and of
 * every destination, with no copying to overlap it. On a card offload,
 * where hashing is already frequently the bottleneck, it roughly doubles
 * the time spent hashing and doubles the reads against the drives. It is
 * off by default for exactly that reason.
 *
 * The source is hashed ONCE per file and every node — root and cascaded
 * alike — is compared against it. A cascaded leg's live check compares it
 * against the destination it copied from, so checking it against the
 * original card here is a stronger statement than repeating that: it says
 * the bytes at the end of the chain are the bytes that came off the card.
 */
async function runFinalizedPass({ sourcePath, nodes, algorithm, isCancelled, onProgress }) {
  const rels = [...new Set(nodes.flatMap((n) => (n.files || []).map((f) => f.file)))];
  const results = { algorithm, algorithmLabel: ALGORITHMS[algorithm]?.label || algorithm,
                    checked: 0, verified: 0, mismatches: [], errors: [], cancelled: false };

  let done = 0;
  for (const rel of rels) {
    if (isCancelled()) { results.cancelled = true; break; }
    let sourceHash = null;
    try {
      sourceHash = await hashFileOnDisk(path.join(sourcePath, rel), algorithm);
    } catch (err) {
      // The card being pulled between the copy and this pass is the
      // obvious cause, and it is not a corrupted destination — reported as
      // its own error rather than as N mismatches.
      results.errors.push({ file: rel, stage: "source", error: String(err.message || err) });
      continue;
    }

    for (const n of nodes) {
      if (isCancelled()) { results.cancelled = true; break; }
      const f = (n.files || []).find((x) => x.file === rel);
      if (!f || !f.destPath) continue;
      try {
        const hash = await hashFileOnDisk(f.destPath, algorithm);
        const bytes = (await fsp.stat(f.destPath)).size;
        const ok = hash === sourceHash && bytes === f.bytes;
        // A NEW field beside the live result, never merged into it: both
        // have to survive, or the log cannot say which tier found what.
        f.finalCheck = { algorithm, sourceHash, hash, bytes, ok };
        results.checked += 1;
        if (ok) results.verified += 1;
        else results.mismatches.push({ file: rel, destRoot: n.path, destPath: f.destPath, sourceHash, destHash: hash });
      } catch (err) {
        f.finalCheck = { algorithm, sourceHash, hash: null, bytes: null, ok: false, error: String(err.message || err) };
        results.checked += 1;
        results.errors.push({ file: rel, destRoot: n.path, stage: "destination", error: String(err.message || err) });
      }
    }
    done += 1;
    // Unknown phases are ignored by the renderer today, so this costs
    // nothing and means a long second pass is not silent when something
    // does listen.
    onProgress({ phase: "finalizing", file: rel, done, total: rels.length });
  }

  results.ok = !results.cancelled && results.errors.length === 0
    && results.mismatches.length === 0 && results.checked > 0;
  return results;
}

/** Strip internals before a node crosses the IPC boundary. */
function publicNode(n) {
  return {
    id: n.id,
    path: n.path,
    parentId: n.parentId,
    status: n.status,
    filesVerified: n.filesVerified,
    copiedBytes: n.copiedBytes,
    mismatches: n.mismatches,
    errors: n.errors,
    // §86 — n.files entries may carry a finalCheck by the time this runs
    // (the finalized pass writes onto them before the summary is built),
    // so they are passed through whole rather than re-picked field by
    // field, which is what would drop it.
    files: n.files || [],
    durationMs: n.startedAt && n.finishedAt ? n.finishedAt - n.startedAt : null,
  };
}

module.exports = {
  runCopyJob,
  runLeg,
  DEFAULT_ALGORITHM,
  // Exported for the standalone test script and for reuse by the future
  // VERIFIED/PRO tiers and the ASC MHL writer.
  listFilesRecursive,
  hashFileOnDisk,
  runFinalizedPass,
  copyOneFileFanOut,
  // The default provider, and the shape main.js's FreeFrame one implements.
  localSource,
  localFilesSource,
};
