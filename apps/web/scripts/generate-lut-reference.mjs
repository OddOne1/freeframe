/**
 * Generates apps/web/public/lut-reference.png — the fixed reference frame the
 * LUT browser renders through each LUT to build its thumbnails.
 *
 * Run: node scripts/generate-lut-reference.mjs
 *
 * Why generated rather than a photograph: the image ships inside this repo, so
 * it has to be something we own outright — no stock/scraped photo. A synthetic
 * tone-and-colour chart is also more diagnostic than a photo at 24-48px wide,
 * where a real image is mush. The bands are chosen to expose the things a
 * .cube actually changes: neutral contrast/lift, saturation, hue rotation, and
 * skin-tone handling.
 *
 * Swapping it: replace public/lut-reference.png with anything 3:2. Nothing
 * else in the app depends on this script; it exists so the current asset is
 * reproducible and easy to tweak.
 *
 * Hand-rolled PNG writer (zlib is in node stdlib) to avoid adding an image
 * dependency to apps/web for a one-off build asset.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const W = 192
const H = 128

// ─── image content ───────────────────────────────────────────────────────────

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
const lerp = (a, b, t) => a + (b - a) * t
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

// Band boundaries, top to bottom.
const SKY_END = 44
const FOLIAGE_END = 58
const SKIN_END = 90
const SATURATED_END = 110

const SKIN = [
  [243, 208, 186], // pale
  [223, 171, 138], // light
  [176, 120, 86],  // medium
  [108, 70, 50],   // deep
]

const SATURATED = [
  [203, 32, 38],   // red
  [235, 192, 42],  // yellow
  [38, 152, 62],   // green
  [40, 176, 201],  // cyan
  [38, 72, 182],   // blue
  [172, 52, 142],  // magenta
]

const GRAY_STEPS = 12

function pixel(x, y) {
  if (y < SKY_END) {
    // Vertical sky gradient plus a warm sun glow — gives a smooth ramp
    // through the blues and a highlight region that clips differently
    // under different LUTs.
    const c = mix([26, 64, 132], [188, 214, 232], y / (SKY_END - 1))
    const d = Math.hypot(x - 148, y - 36)
    const glow = Math.max(0, 1 - d / 58) ** 2
    return [c[0] + 70 * glow, c[1] + 50 * glow, c[2] + 15 * glow]
  }

  if (y < FOLIAGE_END) {
    // Deep saturated green, the hue most LUTs move most visibly. Deterministic
    // two-frequency wobble instead of random noise so the file is stable
    // across runs.
    const t = (y - SKY_END) / (FOLIAGE_END - SKY_END - 1)
    const c = mix([72, 110, 48], [32, 58, 28], t)
    const n = Math.sin(x * 0.21) * Math.sin(x * 0.047) * 16
    return [c[0] + n, c[1] + n * 1.2, c[2] + n * 0.6]
  }

  if (y < SKIN_END) {
    // Four skin tones, each shaded top-to-bottom so the band carries a
    // highlight-to-shadow roll-off rather than four flat patches.
    const block = Math.min(SKIN.length - 1, Math.floor((x / W) * SKIN.length))
    const t = (y - FOLIAGE_END) / (SKIN_END - FOLIAGE_END - 1)
    const f = lerp(1.1, 0.78, t)
    const c = SKIN[block]
    return [c[0] * f, c[1] * f, c[2] * f]
  }

  if (y < SATURATED_END) {
    const i = Math.min(SATURATED.length - 1, Math.floor((x / W) * SATURATED.length))
    return SATURATED[i]
  }

  // Neutral ramp last: the band that shows contrast, lift and any colour
  // cast a LUT puts on greys.
  const step = Math.min(GRAY_STEPS - 1, Math.floor((x / W) * GRAY_STEPS))
  const v = lerp(6, 250, step / (GRAY_STEPS - 1))
  return [v, v, v]
}

// ─── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

// Filter type 0 (None) on every scanline — the image is tiny and this keeps
// the writer trivially verifiable.
const raw = Buffer.alloc(H * (1 + W * 3))
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 3)
  raw[row] = 0
  for (let x = 0; x < W; x++) {
    const [r, g, b] = pixel(x, y)
    const o = row + 1 + x * 3
    raw[o] = clamp(r)
    raw[o + 1] = clamp(g)
    raw[o + 2] = clamp(b)
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // colour type: truecolour RGB
ihdr[10] = 0 // deflate
ihdr[11] = 0 // adaptive filtering
ihdr[12] = 0 // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'lut-reference.png')
writeFileSync(out, png)
console.log(`wrote ${out} (${W}x${H}, ${png.length} bytes)`)
