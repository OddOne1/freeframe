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
/**
 * §79 — `blurb` is one short sentence each. It is read in a dropdown while
 * someone is trying to start a copy, not studied, and four paragraphs there
 * meant nobody read any of them.
 *
 * The longer tradeoffs, kept here rather than lost with the old text:
 *
 *   xxhash64  Often 5-10x faster than the rest, which on a multi-hundred-GB
 *             offload is frequently the real bottleneck. Explicitly not
 *             designed to resist deliberate tampering.
 *   md5       128-bit, fastest of the cryptographic options, and
 *             cryptographically broken — collisions can be engineered on
 *             purpose, so it proves nothing against intent. Still fine for
 *             accidental corruption and bit-rot.
 *   sha1      160-bit, slower than MD5, also broken (demonstrated attacks,
 *             not theoretical). Common as a legacy default in broadcast
 *             pipelines; no real edge over MD5 or xxHash for corruption.
 *   c4        SHA-512 underneath (2^256 collision resistance), strong
 *             against deliberate tampering. A permanent self-describing
 *             90-character identifier rather than a short hex string, so it
 *             is harder to eyeball or transcribe. Slower than xxHash.
 */
const ALGORITHMS = {
  xxhash64: {
    id: "xxhash64",
    label: "xxHash64",
    short: "xxHash64",
    mhlName: "xxh64",
    blurb:
      "Much faster than the rest and not cryptographic — the right default when the question is just “did the copy succeed.”",
    recommended: true,
  },
  md5: {
    id: "md5",
    label: "MD5",
    short: "MD5",
    mhlName: "md5",
    blurb:
      "Fast and cryptographically broken, but fine for accidental corruption — pick it to match an existing MD5 workflow.",
  },
  sha1: {
    id: "sha1",
    label: "SHA-1",
    short: "SHA-1",
    mhlName: "sha1",
    blurb:
      "Slower than MD5 and also broken — a legacy compatibility pick, with no technical edge over the others.",
  },
  c4: {
    id: "c4",
    label: "C4",
    short: "C4",
    mhlName: "c4",
    blurb:
      "Cryptographically strong, with a long self-describing ID — for when the offload may need to hold up as evidence.",
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
