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
const xxhash = require("xxhash-wasm");

// 4 MiB. Large enough that per-chunk overhead is irrelevant on big media
// files, small enough that N destinations * this stays modest in memory.
const CHUNK_SIZE = 4 * 1024 * 1024;

let hasherFactoryPromise = null;
/** xxhash-wasm compiles a WASM module on first use; do it once per process. */
function getHasherFactory() {
  if (!hasherFactoryPromise) hasherFactoryPromise = xxhash();
  return hasherFactoryPromise;
}

/** BigInt digest -> canonical 16-char lowercase hex, matching how xxh64
 *  values are written in ASC MHL manifests and by `xxhsum`. */
function toHex(digest) {
  return digest.toString(16).padStart(16, "0");
}

/** Recursively list every file under `root`, as paths relative to it.
 *  Directories are not returned as entries — they're recreated implicitly
 *  from each file's relative path, so an empty directory tree is not
 *  preserved. Symlinks are skipped rather than followed: following them
 *  can escape the source tree entirely and silently copy unrelated data. */
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
async function copyOneFileFanOut(sourcePath, destPaths, onBytes) {
  // Awaited outside the Promise constructor deliberately: an `async`
  // executor swallows its own rejections (the constructor ignores the
  // returned promise), so a WASM-init failure in here would hang the copy
  // forever instead of surfacing.
  const { create64 } = await getHasherFactory();

  return new Promise((resolve, reject) => {
    const hasher = create64();

    const readStream = fs.createReadStream(sourcePath, { highWaterMark: CHUNK_SIZE });
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
            resolve({ sourceHash: toHex(hasher.digest()), bytes });
          }
        });
      }
    });
  });
}

/** Read a file back off disk and hash it. Separate pass on purpose — see
 *  the module header. */
async function hashFileOnDisk(filePath) {
  const { create64 } = await getHasherFactory();
  const hasher = create64();
  const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
  for await (const chunk of stream) hasher.update(chunk);
  return toHex(hasher.digest());
}

/**
 * Copy every file under `sourcePath` into each of `destPaths`, verifying
 * every written file by re-reading it and comparing xxHash64 against the
 * source.
 *
 * Destinations are written **in parallel from one source read**, not one
 * after another — this is the "1 source → many destinations" shape the
 * roadmap's copy-job DAG is built around, so it must not be bolted on
 * later.
 *
 * Per-file failures do not abort the run: a card with one unreadable file
 * should still yield everything else, with the failure recorded. That's
 * the difference between a bad file and a lost offload.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath
 * @param {string[]} opts.destPaths
 * @param {(p: object) => void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled]
 */
async function runCopyJob({ sourcePath, destPaths, onProgress = () => {}, isCancelled = () => false }) {
  const startedAt = Date.now();

  if (!destPaths || destPaths.length === 0) {
    throw new Error("At least one destination is required");
  }

  const sourceStat = await fsp.stat(sourcePath);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source is not a directory: ${sourcePath}`);
  }

  // Copying a destination into itself, or into a subdirectory of the
  // source, produces infinite recursion or silent self-overwrite. Cheap to
  // check, miserable to debug.
  const srcResolved = path.resolve(sourcePath);
  for (const dest of destPaths) {
    const destResolved = path.resolve(dest);
    if (destResolved === srcResolved) {
      throw new Error(`Destination is the same as the source: ${dest}`);
    }
    if (destResolved.startsWith(srcResolved + path.sep)) {
      throw new Error(`Destination is inside the source: ${dest}`);
    }
    if (srcResolved.startsWith(destResolved + path.sep)) {
      throw new Error(`Source is inside the destination: ${dest}`);
    }
  }

  onProgress({ phase: "scanning", sourcePath, destPaths });

  const relFiles = await listFilesRecursive(sourcePath);
  let totalBytes = 0;
  const sizes = new Map();
  for (const rel of relFiles) {
    const st = await fsp.stat(path.join(sourcePath, rel));
    sizes.set(rel, st.size);
    totalBytes += st.size;
  }

  onProgress({
    phase: "start",
    totalFiles: relFiles.length,
    totalBytes,
    destinationCount: destPaths.length,
  });

  /** @type {Array<object>} */
  const fileResults = [];
  let copiedBytes = 0;
  let filesDone = 0;
  let cancelled = false;

  for (const rel of relFiles) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }

    const srcFile = path.join(sourcePath, rel);
    const destFiles = destPaths.map((d) => path.join(d, rel));
    const size = sizes.get(rel) ?? 0;

    onProgress({
      phase: "file-start",
      file: rel,
      fileIndex: filesDone,
      totalFiles: relFiles.length,
      bytes: size,
    });

    const entry = {
      file: rel,
      bytes: size,
      sourceHash: null,
      destinations: [],
      ok: false,
      error: null,
    };

    try {
      // Relative structure is preserved by recreating each file's parent
      // chain under every destination.
      await Promise.all(
        destFiles.map((f) => fsp.mkdir(path.dirname(f), { recursive: true }))
      );

      const { sourceHash } = await copyOneFileFanOut(srcFile, destFiles, (n) => {
        copiedBytes += n;
        onProgress({
          phase: "bytes",
          file: rel,
          copiedBytes,
          totalBytes,
          // Bytes are counted once per source read, not once per
          // destination — otherwise "copied" would exceed the source size
          // by a factor of N and the progress bar would be nonsense.
          percent: totalBytes > 0 ? Math.min(100, (copiedBytes / totalBytes) * 100) : 100,
        });
      });
      entry.sourceHash = sourceHash;

      onProgress({ phase: "verifying", file: rel });

      // Verify every destination in parallel too — they're independent
      // devices, so serializing here would waste exactly the time the
      // parallel write just saved.
      const verifications = await Promise.all(
        destFiles.map(async (destFile, i) => {
          try {
            const destHash = await hashFileOnDisk(destFile);
            const destSize = (await fsp.stat(destFile)).size;
            return {
              destRoot: destPaths[i],
              path: destFile,
              hash: destHash,
              bytes: destSize,
              // Size is checked alongside the hash because a zero-byte
              // file has a valid, stable hash of its own — matching hashes
              // alone wouldn't catch source and destination both being
              // empty for different reasons.
              ok: destHash === sourceHash && destSize === size,
              error: null,
            };
          } catch (err) {
            return {
              destRoot: destPaths[i],
              path: destFile,
              hash: null,
              bytes: null,
              ok: false,
              error: String(err.message || err),
            };
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
    filesDone += 1;

    onProgress({
      phase: "file-done",
      file: rel,
      ok: entry.ok,
      fileIndex: filesDone,
      totalFiles: relFiles.length,
      copiedBytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, (copiedBytes / totalBytes) * 100) : 100,
    });
  }

  const verifiedFiles = fileResults.filter((f) => f.ok).length;
  const mismatches = [];
  const errors = [];
  for (const f of fileResults) {
    if (f.error) {
      errors.push({ file: f.file, error: f.error });
      continue;
    }
    for (const d of f.destinations) {
      if (d.error) {
        errors.push({ file: f.file, destRoot: d.destRoot, error: d.error });
      } else if (!d.ok) {
        mismatches.push({
          file: f.file,
          destRoot: d.destRoot,
          sourceHash: f.sourceHash,
          destHash: d.hash,
        });
      }
    }
  }

  const summary = {
    mode: "SECURE",
    algorithm: "xxh64",
    sourcePath,
    destPaths,
    cancelled,
    totalFiles: relFiles.length,
    filesCopied: fileResults.length,
    filesVerified: verifiedFiles,
    totalBytes,
    copiedBytes,
    mismatches,
    errors,
    // The only line that should decide whether a card is safe to wipe.
    allVerified:
      !cancelled &&
      fileResults.length === relFiles.length &&
      verifiedFiles === relFiles.length &&
      mismatches.length === 0 &&
      errors.length === 0,
    durationMs: Date.now() - startedAt,
    files: fileResults,
  };

  onProgress({ phase: "done", summary });
  return summary;
}

module.exports = {
  runCopyJob,
  // Exported for the standalone test script and for reuse by the future
  // VERIFIED/PRO tiers and the ASC MHL writer.
  listFilesRecursive,
  hashFileOnDisk,
  copyOneFileFanOut,
  toHex,
};
