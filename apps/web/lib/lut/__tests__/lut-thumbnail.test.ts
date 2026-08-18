import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * WebGL2 doesn't exist in jsdom, so LutRenderer is stubbed — what's under
 * test here is the assembly: caching per LUT id, one reference image and one
 * renderer for the whole library, the concurrency cap, and the fact that the
 * data URL is read in the same task as the draw.
 */

const calls: string[] = []
let webgl2Available = true
let renderersCreated = 0
let imageSrcs: string[] = []
/** Resolve an image load manually, so a test can hold the reference frame
 *  pending while it asserts on ordering. */
let releaseImage: (() => void) | null = null

const setLut = vi.fn(() => {
  calls.push('setLut')
})
const render = vi.fn(() => {
  calls.push('render')
})

vi.mock('../webgl-lut', () => ({
  isWebGL2Available: () => webgl2Available,
  LutRenderer: class {
    constructor() {
      renderersCreated += 1
    }
    setLut = setLut
    render = render
  },
}))

const loadCube = vi.fn((lutId: string, _url?: string | null) =>
  Promise.resolve({ id: lutId } as never),
)
vi.mock('../cube-cache', () => ({
  loadCube: (lutId: string, url: string | null) => loadCube(lutId, url),
  getCachedCube: () => undefined,
}))

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(value: string) {
    imageSrcs.push(value)
    releaseImage = () => this.onload?.()
    // Auto-resolve on the next tick unless a test grabs releaseImage first.
    queueMicrotask(() => releaseImage?.())
  }
}

let toDataURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  calls.length = 0
  webgl2Available = true
  imageSrcs = []
  renderersCreated = 0
  releaseImage = null
  setLut.mockClear()
  render.mockClear()
  loadCube.mockClear()
  loadCube.mockImplementation((lutId: string) => Promise.resolve({ id: lutId } as never))

  let n = 0
  toDataURL = vi.fn(() => {
    calls.push('toDataURL')
    n += 1
    return `data:image/png;base64,thumb-${n}`
  })
  // jsdom has no canvas backend; the read-back is what we assert on anyway.
  HTMLCanvasElement.prototype.toDataURL = toDataURL as unknown as HTMLCanvasElement['toDataURL']
  vi.stubGlobal('Image', FakeImage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function freshModule() {
  vi.resetModules()
  return import('../lut-thumbnail')
}

describe('renderLutThumbnail', () => {
  it('draws the reference frame through the LUT and returns a data URL', async () => {
    const { renderLutThumbnail, REFERENCE_IMAGE_SRC } = await freshModule()
    const url = await renderLutThumbnail('lut-1', '/luts/one.cube')

    expect(url).toBe('data:image/png;base64,thumb-1')
    expect(imageSrcs).toEqual([REFERENCE_IMAGE_SRC])
    expect(loadCube).toHaveBeenCalledWith('lut-1', '/luts/one.cube')
    // The read-back must immediately follow the draw, with no await between:
    // the context is preserveDrawingBuffer:false.
    expect(calls).toEqual(['setLut', 'render', 'toDataURL'])
  })

  it('renders each LUT once, however many callers ask', async () => {
    const { renderLutThumbnail } = await freshModule()
    const first = await renderLutThumbnail('lut-1', '/luts/one.cube')
    const second = await renderLutThumbnail('lut-1', '/luts/one.cube')
    const [third, fourth] = await Promise.all([
      renderLutThumbnail('lut-1', '/luts/one.cube'),
      renderLutThumbnail('lut-1', '/luts/one.cube'),
    ])

    expect([second, third, fourth]).toEqual([first, first, first])
    expect(render).toHaveBeenCalledTimes(1)
    expect(loadCube).toHaveBeenCalledTimes(1)
  })

  it('reuses one reference image and one GL context across the library', async () => {
    const { renderLutThumbnail } = await freshModule()
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) => renderLutThumbnail(id, `/luts/${id}.cube`)),
    )

    expect(render).toHaveBeenCalledTimes(5)
    // A context per thumbnail would blow past the browser's live-context cap.
    expect(renderersCreated).toBe(1)
    expect(imageSrcs).toHaveLength(1)

    // One shared context means the draw and the read-back have to be atomic:
    // if anything awaited between them, another LUT's setLut/render would
    // interleave here and each thumbnail would read back the wrong frame.
    expect(calls).toHaveLength(15)
    for (let i = 0; i < calls.length; i += 3) {
      expect(calls.slice(i, i + 3)).toEqual(['setLut', 'render', 'toDataURL'])
    }
  })

  it('caps how many LUTs are loaded at once', async () => {
    const { renderLutThumbnail } = await freshModule()
    let inFlight = 0
    let peak = 0
    const settle: (() => void)[] = []
    loadCube.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          settle.push(() => {
            inFlight -= 1
            resolve({} as never)
          })
        }),
    )

    const all = Promise.all(
      Array.from({ length: 12 }, (_, i) => renderLutThumbnail(`lut-${i}`, `/luts/${i}.cube`))
    )

    // Let the queue admit everything it's willing to admit.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)

    // Draining proves the waiters are released rather than stranded.
    while (settle.length) {
      settle.shift()!()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    await all
    expect(render).toHaveBeenCalledTimes(12)
  })

  it('is retryable after a failed .cube load, and frees its slot', async () => {
    const { renderLutThumbnail } = await freshModule()
    loadCube.mockRejectedValueOnce(new Error('nope'))

    await expect(renderLutThumbnail('lut-1', '/luts/one.cube')).rejects.toThrow('nope')
    await expect(renderLutThumbnail('lut-1', '/luts/one.cube')).resolves.toMatch(/^data:image/)
  })

  it('rejects without WebGL2 instead of returning an ungraded swatch', async () => {
    const { renderLutThumbnail } = await freshModule()
    webgl2Available = false
    await expect(renderLutThumbnail('lut-1', '/luts/one.cube')).rejects.toThrow('WebGL2')
    expect(render).not.toHaveBeenCalled()
  })
})

describe('getCachedLutThumbnail', () => {
  it('is null before a render and the data URL after', async () => {
    const { renderLutThumbnail, getCachedLutThumbnail } = await freshModule()
    expect(getCachedLutThumbnail('lut-1')).toBeNull()
    await renderLutThumbnail('lut-1', '/luts/one.cube')
    expect(getCachedLutThumbnail('lut-1')).toBe('data:image/png;base64,thumb-1')
  })
})
