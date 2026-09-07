/**
 * §123 — WebGL contexts are a capped resource, so they must be counted.
 *
 * Opening the LUT list logged "there are too many active WebGL contexts on
 * this page, the oldest context will be lost" 32 times in one session.
 * Measured in a real browser: rendering a 12-LUT library created THIRTEEN
 * WebGL2 contexts and released none — one per thumbnail, because
 * renderLutThumbnail asks isWebGL2Available() per LUT and that function built
 * a fresh canvas and context every call. After the fix the same flow creates
 * two (the probe, released immediately, and the one shared renderer §35
 * deliberately keeps) and the browser logs nothing.
 *
 * The module caches its answer, so each case re-imports to get a clean one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

let created = 0
let lost = 0

function stubWebGL(available = true) {
  created = 0
  lost = 0
  HTMLCanvasElement.prototype.getContext = vi.fn(function (id: string) {
    if (id !== 'webgl2') return null
    if (!available) return null
    created += 1
    return {
      getExtension: (name: string) =>
        name === 'WEBGL_lose_context' ? { loseContext: () => { lost += 1 } } : null,
    }
  }) as never
}

beforeEach(() => {
  vi.resetModules()
  stubWebGL()
})

describe('isWebGL2Available', () => {
  it('creates at most one context however many times it is asked', async () => {
    const { isWebGL2Available } = await import('../webgl-lut')
    for (let i = 0; i < 12; i++) isWebGL2Available()
    // One per call was the bug: twelve LUT rows, twelve leaked contexts.
    expect(created).toBe(1)
  })

  it('hands the probe context straight back', async () => {
    const { isWebGL2Available } = await import('../webgl-lut')
    isWebGL2Available()
    // Dropping the reference is not enough — a context lives until its
    // canvas is collected, which is exactly how a page drifts past the cap.
    expect(lost).toBe(1)
  })

  it('still answers correctly, and still caches, when unsupported', async () => {
    stubWebGL(false)
    const { isWebGL2Available } = await import('../webgl-lut')
    expect(isWebGL2Available()).toBe(false)
    expect(isWebGL2Available()).toBe(false)
    expect(created).toBe(0)
  })

  it('answers true when webgl2 is there', async () => {
    const { isWebGL2Available } = await import('../webgl-lut')
    expect(isWebGL2Available()).toBe(true)
  })
})

describe('releaseContext', () => {
  it('loses the context through the extension', async () => {
    const { releaseContext } = await import('../webgl-lut')
    const gl = { getExtension: () => ({ loseContext: () => { lost += 1 } }) }
    releaseContext(gl as never)
    expect(lost).toBe(1)
  })

  it('tolerates an implementation without the extension', async () => {
    const { releaseContext } = await import('../webgl-lut')
    expect(() => releaseContext({ getExtension: () => null } as never)).not.toThrow()
    expect(() => releaseContext(null)).not.toThrow()
  })
})

/**
 * A context complete enough to construct a LutRenderer. Every unknown method
 * is a no-op, every create* hands back an object, and the two "did it
 * compile/link" queries answer yes — the constructor throws on a falsy
 * result from any of them.
 */
function fakeGl(onLose: () => void): WebGL2RenderingContext {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop === 'getExtension') {
        return (name: string) =>
          name === 'WEBGL_lose_context' ? { loseContext: onLose } : null
      }
      if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true
      if (prop.startsWith('create') || prop === 'getUniformLocation') return () => ({})
      if (prop === 'getAttribLocation') return () => 0
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1 // GL enum constant
      return () => undefined
    },
  }) as never
}

describe('LutRenderer.dispose', () => {
  it('gives the context back, not just its objects', async () => {
    // Deleting textures and programs leaves the CONTEXT alive, and the
    // context is the thing browsers cap.
    let losses = 0
    const gl = fakeGl(() => { losses += 1 })
    HTMLCanvasElement.prototype.getContext = vi.fn(() => gl) as never

    const { LutRenderer } = await import('../webgl-lut')
    const renderer = new LutRenderer(document.createElement('canvas'))
    renderer.dispose()

    expect(losses).toBe(1)
  })

  it('is safe to call twice', async () => {
    let losses = 0
    const gl = fakeGl(() => { losses += 1 })
    HTMLCanvasElement.prototype.getContext = vi.fn(() => gl) as never

    const { LutRenderer } = await import('../webgl-lut')
    const renderer = new LutRenderer(document.createElement('canvas'))
    renderer.dispose()
    renderer.dispose()

    expect(losses).toBe(1)
  })
})
