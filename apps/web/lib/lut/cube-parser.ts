/**
 * Parser for Adobe `.cube` 3D LUT files.
 *
 * Format: an optional header (`TITLE`, `LUT_3D_SIZE N`, `DOMAIN_MIN`,
 * `DOMAIN_MAX`), `#` comments, then N³ lines of `R G B` floats.
 *
 * **The row ordering is the thing to get right.** In a .cube the RED index
 * varies fastest, then green, then blue — so line `i` is
 * `r = i % N`, `g = floor(i / N) % N`, `b = floor(i / N²)`.
 * A WebGL 3D texture reads its data buffer x-fastest, so mapping
 * x→R, y→G, z→B means the file's natural line order can be uploaded
 * verbatim with no reshuffling. Getting this backwards produces an image
 * that still looks like a plausible grade — which is exactly why it has a
 * known-answer test rather than a visual once-over.
 */

export interface ParsedCube {
  size: number
  /** N³ RGB triples, x(R)-fastest — upload order for texImage3D. */
  data: Float32Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title: string | null
}

export class CubeParseError extends Error {}

/** Matches MAX_LUT_SIZE in apps/api/routers/luts.py — a 64³ LUT is already
 *  ~786k entries; beyond that it's a malformed file, not a real LUT. */
const MAX_SIZE = 64

export function parseCube(text: string): ParsedCube {
  let size = 0
  let title: string | null = null
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]

  // Collected as a flat list first: the header can legally appear after
  // some data lines, so the buffer can't be sized until the whole file is
  // scanned. Real files put the header first, but the format doesn't
  // require it.
  const triples: number[] = []

  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const parts = line.split(/\s+/)
    const keyword = parts[0].toUpperCase()

    if (keyword === 'TITLE') {
      title = line.slice(line.indexOf(' ') + 1).replace(/^"|"$/g, '')
      continue
    }
    if (keyword === 'LUT_3D_SIZE') {
      size = Number.parseInt(parts[1], 10)
      if (!Number.isFinite(size) || size < 2 || size > MAX_SIZE) {
        throw new CubeParseError(`LUT_3D_SIZE must be 2–${MAX_SIZE} (got ${parts[1]})`)
      }
      continue
    }
    if (keyword === 'LUT_1D_SIZE') {
      throw new CubeParseError('1D LUTs are not supported — this needs a 3D .cube')
    }
    if (keyword === 'DOMAIN_MIN') {
      domainMin = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
      continue
    }
    if (keyword === 'DOMAIN_MAX') {
      domainMax = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
      continue
    }

    // Anything else must be a data row.
    if (parts.length < 3) continue
    const r = Number(parts[0])
    const g = Number(parts[1])
    const b = Number(parts[2])
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      continue // stray keyword line from a vendor extension — skip, don't fail
    }
    triples.push(r, g, b)
  }

  if (!size) throw new CubeParseError('No LUT_3D_SIZE found — is this a .cube file?')

  const expected = size * size * size
  if (triples.length / 3 !== expected) {
    throw new CubeParseError(
      `Expected ${expected} entries for LUT_3D_SIZE ${size}, found ${triples.length / 3}`,
    )
  }
  if (domainMax.some((v, i) => !(v > domainMin[i]))) {
    throw new CubeParseError('DOMAIN_MAX must be greater than DOMAIN_MIN on every channel')
  }

  return { size, data: new Float32Array(triples), domainMin, domainMax, title }
}

/**
 * Value an ideal (trilinearly interpolated) LUT should return for `rgb`.
 * Used by the known-answer tests to check the GPU path against the CPU one —
 * the shader and this share no code, so agreement is real evidence.
 */
export function sampleCubeCPU(
  cube: ParsedCube,
  rgb: [number, number, number],
): [number, number, number] {
  const { size, data, domainMin, domainMax } = cube
  const coord = rgb.map((v, i) => {
    const n = (v - domainMin[i]) / (domainMax[i] - domainMin[i])
    return Math.min(1, Math.max(0, n)) * (size - 1)
  }) as [number, number, number]

  const lo = coord.map(Math.floor) as [number, number, number]
  const hi = lo.map((v) => Math.min(v + 1, size - 1)) as [number, number, number]
  const frac = coord.map((v, i) => v - lo[i]) as [number, number, number]

  const at = (r: number, g: number, b: number, ch: number) =>
    data[((b * size + g) * size + r) * 3 + ch]

  const out: [number, number, number] = [0, 0, 0]
  for (let ch = 0; ch < 3; ch++) {
    // Standard trilinear: lerp along r, then g, then b.
    const c00 = at(lo[0], lo[1], lo[2], ch) * (1 - frac[0]) + at(hi[0], lo[1], lo[2], ch) * frac[0]
    const c10 = at(lo[0], hi[1], lo[2], ch) * (1 - frac[0]) + at(hi[0], hi[1], lo[2], ch) * frac[0]
    const c01 = at(lo[0], lo[1], hi[2], ch) * (1 - frac[0]) + at(hi[0], lo[1], hi[2], ch) * frac[0]
    const c11 = at(lo[0], hi[1], hi[2], ch) * (1 - frac[0]) + at(hi[0], hi[1], hi[2], ch) * frac[0]
    const c0 = c00 * (1 - frac[1]) + c10 * frac[1]
    const c1 = c01 * (1 - frac[1]) + c11 * frac[1]
    out[ch] = c0 * (1 - frac[2]) + c1 * frac[2]
  }
  return out
}
