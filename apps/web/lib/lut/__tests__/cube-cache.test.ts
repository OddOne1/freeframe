import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The cache is module state, so every test re-imports it fresh. Reusing one
 * import would let an earlier test's cached LUT satisfy a later test's "does
 * it fetch?" assertion — the same trap §27's upload gate hit.
 */
async function freshModule() {
  vi.resetModules()
  return import('../cube-cache')
}

/** A minimal but real 2³ .cube — parseCube is the real one here, not a stub. */
const CUBE = [
  'TITLE "test"',
  'LUT_3D_SIZE 2',
  '0 0 0',
  '1 0 0',
  '0 1 0',
  '1 1 0',
  '0 0 1',
  '1 0 1',
  '0 1 1',
  '1 1 1',
].join('\n')

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(CUBE) }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadCube', () => {
  it('parses the .cube behind a LUT', async () => {
    const { loadCube } = await freshModule()
    const cube = await loadCube('lut-1', '/luts/one.cube')
    expect(cube.size).toBe(2)
    expect(cube.title).toBe('test')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetches once for a LUT already parsed', async () => {
    const { loadCube } = await freshModule()
    await loadCube('lut-1', '/luts/one.cube')
    await loadCube('lut-1', '/luts/one.cube')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetches once when two callers ask concurrently', async () => {
    // This is the case the thumbnail grid and the picker actually hit: both
    // want the same LUT in the same tick.
    const { loadCube } = await freshModule()
    const [a, b] = await Promise.all([
      loadCube('lut-1', '/luts/one.cube'),
      loadCube('lut-1', '/luts/one.cube'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('fetches per LUT, not once overall', async () => {
    const { loadCube } = await freshModule()
    await Promise.all([
      loadCube('lut-1', '/luts/one.cube'),
      loadCube('lut-2', '/luts/two.cube'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('is retryable after a failure', async () => {
    const { loadCube } = await freshModule()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('') })

    await expect(loadCube('lut-1', '/luts/one.cube')).rejects.toThrow('Could not load LUT (500)')
    // A rejected in-flight promise must not be handed to the next caller.
    const cube = await loadCube('lut-1', '/luts/one.cube')
    expect(cube.size).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a LUT with no file rather than fetching', async () => {
    const { loadCube } = await freshModule()
    await expect(loadCube('lut-1', null)).rejects.toThrow('no file')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getCachedCube', () => {
  it('is empty before a load and populated after', async () => {
    const { loadCube, getCachedCube } = await freshModule()
    expect(getCachedCube('lut-1')).toBeUndefined()
    await loadCube('lut-1', '/luts/one.cube')
    expect(getCachedCube('lut-1')?.size).toBe(2)
  })
})
