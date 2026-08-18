/**
 * Generates apps/web/public/lut-reference.jpg — the fixed reference frame the
 * LUT browser renders through each LUT to build its thumbnails and its
 * click-to-zoom preview.
 *
 * Run (macOS; needs `sips`, which ships with the OS):
 *
 *   node scripts/generate-lut-reference.mjs --photo ~/Downloads/pexels-shvets-production-9775652.jpg
 *
 * ── What the frame is ───────────────────────────────────────────────────────
 *
 * A photograph of two people with strongly contrasting skin tones on a plain
 * studio backdrop, with a colour-bar strip composited along the bottom. Skin
 * is the single most grading-sensitive thing in a reference image and a real
 * photographed face reads far better under a LUT than the four flat shaded
 * patches this file used to draw; the strip keeps a hard, unambiguous colour
 * and neutral reference that still reads at 24px wide, where a photograph
 * alone is mush.
 *
 * ── Provenance of the photograph (legal traceability, not a nicety) ─────────
 *
 *   Source:       Pexels, photo ID 9775652, by SHVETS production
 *   Direct URL:   https://images.pexels.com/photos/9775652/pexels-photo-9775652.jpeg?cs=srgb&dl=pexels-shvets-production-9775652.jpg&fm=jpg
 *   Page:         https://www.pexels.com/photo/9775652/
 *   Description:  "Close-up portrait of a black man and caucasian man in a
 *                 studio setting with a neutral background."
 *   Licence:      Pexels licence (https://www.pexels.com/license/) — free to
 *                 use, no attribution required, explicitly permitted "on your
 *                 website, blog or app". Its only relevant restriction is
 *                 against redistribution on other stock-photo platforms,
 *                 which bundling it as this app's own static asset is not.
 *
 * Swapping it: run this script against a different photo. Everything below
 * derives from the source's own dimensions, so any reasonably framed portrait
 * works; only the crop bias may want adjusting. Nothing else in the app reads
 * this script — it exists so the shipped asset is reproducible and tweakable.
 *
 * ── Why this shape of script ───────────────────────────────────────────────
 *
 * No image dependency is added to apps/web: a dependency change here is what
 * left the production image unbuildable for eleven days (CLAUDE.md §13c). So
 * decoding and JPEG encoding are handed to `sips` (an OS binary, not a
 * package), BMP is used as the intermediate because it is trivially and
 * verifiably parseable, and the compositing plus the PNG writer are plain
 * node + zlib.
 *
 * JPEG rather than PNG for the shipped asset because the frame is now
 * photographic: the same 960x640 image is ~96KB as JPEG and ~800KB as PNG,
 * and this is fetched by every page that lists a LUT.
 */
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ─── geometry ────────────────────────────────────────────────────────────────

/** 3:2, unchanged from the generated chart this replaces, so every existing
 *  call site's h-8 w-12 / h-4 w-6 sizing still frames it correctly. 960x640 is
 *  2x the largest place it is displayed (the 480x320 zoom preview), so that
 *  view stays crisp on a retina panel. */
const W = 960
const H = 640

/** The strip is 15% of the frame: enough to read as colour at thumbnail size,
 *  little enough that the faces still dominate, which is the point of the
 *  photo. */
const BARS_H = 56
const RAMP_H = 40
const PHOTO_H = H - BARS_H - RAMP_H

/** Fraction of the discarded height taken off the top when cropping the source
 *  to PHOTO_H's aspect. Below 0.5 because a portrait's headroom is more
 *  expendable than its chins. */
const CROP_TOP_BIAS = 0.4

/** The saturated primaries/secondaries row, carried over unchanged from the
 *  chart this replaces — the same six values, so a LUT that was being judged
 *  by them before is still being judged by them now. */
const SATURATED = [
  [203, 32, 38],   // red
  [235, 192, 42],  // yellow
  [38, 152, 62],   // green
  [40, 176, 201],  // cyan
  [38, 72, 182],   // blue
  [172, 52, 142],  // magenta
]

/** And the neutral ramp, likewise unchanged. The photograph carries highlights
 *  and mid neutrals (white shirts, grey backdrop) but no true black, so the
 *  ramp is what still exposes contrast, lift and any colour cast on greys. */
const GRAY_STEPS = 12

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
const lerp = (a, b, t) => a + (b - a) * t

// ─── source photo, via sips ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const photoArg = args.indexOf('--photo')
if (photoArg === -1 || !args[photoArg + 1]) {
  console.error(
    'usage: node scripts/generate-lut-reference.mjs --photo <path to source photo>\n' +
      '\nThe photo this repo ships is documented at the top of this file, with\n' +
      'its source URL and licence. Download it, then pass its path here.',
  )
  process.exit(1)
}
const photoPath = args[photoArg + 1]

function sips(...argv) {
  return execFileSync('sips', argv, { encoding: 'utf8' })
}

function dimensions(file) {
  const out = sips('-g', 'pixelWidth', '-g', 'pixelHeight', file)
  const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1])
  if (!width || !height) throw new Error(`Could not read the size of ${file}`)
  return { width, height }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'lut-reference-'))

/** Crop the source to PHOTO_H's aspect, resample to W x PHOTO_H, and hand it
 *  back as raw pixels. BMP is the intermediate purely because it is 54 bytes
 *  of header and then rows of BGR. */
function loadPhoto() {
  const { width, height } = dimensions(photoPath)
  const targetAspect = W / PHOTO_H

  let cropW = width
  let cropH = Math.round(width / targetAspect)
  if (cropH > height) {
    cropH = height
    cropW = Math.round(height * targetAspect)
  }
  const top = Math.round((height - cropH) * CROP_TOP_BIAS)
  const left = Math.round((width - cropW) / 2)

  const cropped = path.join(tmp, 'cropped.png')
  sips('-c', String(cropH), String(cropW), '--cropOffset', String(top), String(left),
       '-s', 'format', 'png', photoPath, '--out', cropped)

  const bmp = path.join(tmp, 'photo.bmp')
  sips('-z', String(PHOTO_H), String(W), '-s', 'format', 'bmp', cropped, '--out', bmp)

  return readBmp(bmp)
}

/** 24-bit uncompressed BMP → { width, height, rgb: Uint8Array }. Only the
 *  shape sips writes is handled, and anything else is rejected loudly rather
 *  than silently mis-read. */
function readBmp(file) {
  const buf = readFileSync(file)
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('Not a BMP')
  const offset = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  const signedHeight = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  if (bpp !== 24 || compression !== 0) {
    throw new Error(`Unsupported BMP: ${bpp}bpp, compression ${compression}`)
  }
  // A negative height means the rows are stored top-down, which is what sips
  // writes; a positive one is the classic bottom-up order.
  const topDown = signedHeight < 0
  const height = Math.abs(signedHeight)
  const stride = (width * 3 + 3) & ~3

  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const src = offset + (topDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const s = src + x * 3
      const d = (y * width + x) * 3
      rgb[d] = buf[s + 2] // BMP stores BGR
      rgb[d + 1] = buf[s + 1]
      rgb[d + 2] = buf[s]
    }
  }
  return { width, height, rgb }
}

// ─── composite ───────────────────────────────────────────────────────────────

const photo = loadPhoto()
if (photo.width !== W || photo.height !== PHOTO_H) {
  throw new Error(`Expected a ${W}x${PHOTO_H} photo, got ${photo.width}x${photo.height}`)
}

/** Row of RGB triples for one output scanline. */
function pixel(x, y) {
  if (y < PHOTO_H) {
    const o = (y * W + x) * 3
    return [photo.rgb[o], photo.rgb[o + 1], photo.rgb[o + 2]]
  }
  if (y < PHOTO_H + BARS_H) {
    const i = Math.min(SATURATED.length - 1, Math.floor((x / W) * SATURATED.length))
    return SATURATED[i]
  }
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

// Filter type 0 (None) on every scanline — the intermediate is thrown away
// after sips re-encodes it, so this keeps the writer trivially verifiable.
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

const composite = path.join(tmp, 'composite.png')
writeFileSync(composite, png)

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'lut-reference.jpg')
// 88 rather than sips' default: the frame is judged by colour, and the strip's
// hard edges are exactly where a lower quality shows ringing.
sips('-s', 'format', 'jpeg', '-s', 'formatOptions', '88', composite, '--out', out)
rmSync(tmp, { recursive: true, force: true })

const bytes = readFileSync(out).length
console.log(`wrote ${out} (${W}x${H}, ${bytes} bytes)`)
