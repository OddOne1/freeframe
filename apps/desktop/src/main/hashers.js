// Checksum algorithms, behind one streaming interface.
//
// Every algorithm here exposes the same shape:
//
//     { update(chunk: Buffer): void, digest(): string }
//
// so copy-engine.js's copy-time hash and verify-time re-hash don't care
// which one is live. That matters because those two must always agree — a
// copy hashed with xxHash64 and verified with MD5 would report a mismatch
// on a perfectly good file.
//
// The algorithm set matches ASC MHL's own reference tool (`ascmhl -h`),
// which is the point: a manifest this app writes should be re-verifiable
// by tools the user's collaborators already have. xxh3/xxh128 are in that
// list but absent here — `xxhash-wasm` only exposes 32/64 (checked), and
// adding a second hashing dependency for them isn't worth it in this pass.

const crypto = require("node:crypto");
const xxhash = require("xxhash-wasm");

let xxhashFactoryPromise = null;
function getXxhashFactory() {
  if (!xxhashFactoryPromise) xxhashFactoryPromise = xxhash();
  return xxhashFactoryPromise;
}

/** Bitcoin-style base58. Deliberately not the Ripple or Flickr variant —
 *  C4 uses this one, and a different alphabet produces a plausible-looking
 *  but wrong identifier. */
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf) {
  let n = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

/**
 * C4 (SMPTE ST 2114:2017) — SHA-512, base58-encoded, left-padded to 88
 * characters with the base58 zero digit, prefixed "c4" for 90 total.
 *
 * Verified against the reference implementation's own published vector:
 *   "hello" → c447Fm3BJZQ62765jMZJH4m28hrDM7Szbj9CUmj4F4gnvyDYXYz4Wfn...
 * (full value asserted in scripts/test-copy.js — this is exactly the kind
 * of format where a subtly wrong encoding still looks right.)
 */
function c4Digest(sha512Buffer) {
  const encoded = base58Encode(sha512Buffer);
  return "c4" + "1".repeat(Math.max(0, 88 - encoded.length)) + encoded;
}

/** Wraps a node crypto Hash so it matches the shared interface. */
function nodeHasher(algorithm, encode) {
  const h = crypto.createHash(algorithm);
  return {
    update(chunk) { h.update(chunk); },
    digest() {
      const buf = h.digest();
      return encode ? encode(buf) : buf.toString("hex");
    },
  };
}

/**
 * Algorithm registry.
 *
 * `label` and `blurb` are user-facing. The blurbs are lifted from the
 * researched text in CLAUDE.md's roadmap rather than rewritten — those
 * tradeoffs are easy to get subtly wrong, and they were deliberately
 * worded once already.
 */
const ALGORITHMS = {
  xxhash64: {
    id: "xxhash64",
    label: "xxHash64",
    short: "xxHash64",
    mhlName: "xxh64",
    blurb:
      "Not cryptographic, and explicitly not designed to resist deliberate tampering. Dramatically faster than MD5/SHA-1/C4 (often 5–10×+), which matters a great deal on multi-hundred-GB card offloads where hash time is frequently the real bottleneck. The right default when the only threat model is “did the copy succeed correctly.”",
    recommended: true,
  },
  md5: {
    id: "md5",
    label: "MD5",
    short: "MD5",
    mhlName: "md5",
    blurb:
      "Fastest of the cryptographic options, 128-bit. Cryptographically broken: someone can deliberately engineer a collision, so it proves nothing against intentional tampering. Fine, and extremely common, for catching accidental corruption/bit-rot. Pick it mainly for compatibility with someone else's existing MD5-based workflow.",
  },
  sha1: {
    id: "sha1",
    label: "SHA-1",
    short: "SHA-1",
    mhlName: "sha1",
    blurb:
      "Slower than MD5, 160-bit. Also cryptographically broken for deliberate-collision resistance (real attacks demonstrated, not theoretical). Still common in production/broadcast pipelines as a legacy default. The reason to pick it is compatibility with an existing pipeline that already standardized on it, not a real technical edge over MD5 or xxHash for corruption detection.",
  },
  c4: {
    id: "c4",
    label: "C4",
    short: "C4",
    mhlName: "c4",
    blurb:
      "Built on SHA-512 (2^256 collision resistance), cryptographically strong against deliberate tampering, not just accidental corruption. Designed as a permanent, self-describing identifier (90-character encoded form) rather than a short hex string, so it's less convenient to eyeball or manually transcribe. Slower than xxHash. Best fit when the offload needs to hold up as evidence later — legal disputes, insurance claims, disputed authorship.",
  },
};

const DEFAULT_ALGORITHM = "xxhash64";

/** Plain data for the renderer's picker — no functions across IPC. */
function listAlgorithms() {
  return Object.values(ALGORITHMS).map(({ id, label, short, blurb, recommended }) => ({
    id, label, short, blurb, recommended: Boolean(recommended),
  }));
}

function isSupported(id) {
  return Object.prototype.hasOwnProperty.call(ALGORITHMS, id);
}

/**
 * Returns a factory that produces fresh streaming hashers for `algorithm`.
 *
 * Async because xxhash-wasm has to compile its WASM module first; resolved
 * once up front by the caller so the per-file hot path stays synchronous.
 */
async function getHasherFactory(algorithm = DEFAULT_ALGORITHM) {
  if (!isSupported(algorithm)) {
    throw new Error(`Unknown checksum algorithm: ${algorithm}`);
  }

  if (algorithm === "xxhash64") {
    const { create64 } = await getXxhashFactory();
    return () => {
      const h = create64();
      return {
        update(chunk) { h.update(chunk); },
        // BigInt -> canonical 16-char lowercase hex, matching how xxh64
        // values appear in ASC MHL manifests and `xxhsum` output.
        digest() { return h.digest().toString(16).padStart(16, "0"); },
      };
    };
  }

  if (algorithm === "c4") return () => nodeHasher("sha512", c4Digest);
  return () => nodeHasher(algorithm);
}

module.exports = {
  ALGORITHMS,
  DEFAULT_ALGORITHM,
  listAlgorithms,
  isSupported,
  getHasherFactory,
  // Exported for the test suite's known-answer checks.
  base58Encode,
  c4Digest,
};
