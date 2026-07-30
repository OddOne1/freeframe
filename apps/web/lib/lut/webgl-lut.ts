/**
 * WebGL2 LUT renderer — draws an image or video frame through a 3D LUT.
 *
 * WebGL2 specifically, for native `sampler3D`. WebGL1 would need the LUT
 * tiled into a 2D atlas with hand-rolled interpolation between slices, which
 * is both slower and much easier to get subtly wrong.
 *
 * **No gamma/linearization anywhere, on purpose.** A .cube for video is
 * authored against display-encoded code values, and ffmpeg's `lut3d` (used
 * for the graded export) applies it the same way. Linearizing here would
 * make the in-app preview disagree with the downloaded file — the one
 * discrepancy this feature genuinely cannot have. So: sample the source
 * texture as UNSIGNED_BYTE/RGBA8 (no SRGB8_ALPHA8 internal format, which
 * would make the GPU silently linearize on read), transform, write out.
 */

import type { ParsedCube } from './cube-parser'

const F32 = new Float32Array(1)
const I32 = new Int32Array(F32.buffer)

/**
 * IEEE binary32 → binary16 bit pattern.
 *
 * The LUT is uploaded as RGBA16F rather than RGB32F on purpose. 32-bit
 * float 3D textures are only LINEAR-filterable with the
 * `OES_texture_float_linear` extension; without it the texture is
 * incomplete and every sample silently returns black — which is what the
 * isolation harness caught. The extension happens to be present on this
 * dev machine, but half-float is texture-filterable in core WebGL2, so
 * RGBA16F works on every WebGL2 GPU with no capability check at all.
 * Half-float carries ~3 decimal digits over [0,1], far more than 8-bit
 * source video can express.
 */
function toHalf(value: number): number {
  F32[0] = value
  const x = I32[0]
  let bits = (x >> 16) & 0x8000
  let m = (x >> 12) & 0x07ff
  const e = (x >> 23) & 0xff
  if (e < 103) return bits
  if (e > 142) {
    bits |= 0x7c00
    bits |= (e === 255 ? 0 : 1) && x & 0x007fffff
    return bits
  }
  if (e < 113) {
    m |= 0x0800
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1)
    return bits
  }
  bits |= ((e - 112) << 10) | (m >> 1)
  bits += m & 1
  return bits
}

/** RGB float triples → RGBA half-float, alpha forced to 1. */
function toHalfRGBA(rgb: Float32Array): Uint16Array {
  const count = rgb.length / 3
  const out = new Uint16Array(count * 4)
  const ONE = toHalf(1)
  for (let i = 0; i < count; i++) {
    out[i * 4] = toHalf(rgb[i * 3])
    out[i * 4 + 1] = toHalf(rgb[i * 3 + 1])
    out[i * 4 + 2] = toHalf(rgb[i * 3 + 2])
    out[i * 4 + 3] = ONE
  }
  return out
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // a_pos is a full-screen quad in clip space. Texture coords are derived
  // with Y flipped: WebGL's texture origin is bottom-left, while images and
  // video frames arrive top-left.
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D u_source;
uniform sampler3D u_lut;
uniform float u_lutSize;
uniform float u_amount;
uniform bool u_hasLut;
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_source, v_uv);
  if (!u_hasLut) {
    fragColor = src;
    return;
  }

  vec3 n = clamp((src.rgb - u_domainMin) / (u_domainMax - u_domainMin), 0.0, 1.0);

  // Map [0,1] onto texel *centres*: (v*(N-1) + 0.5) / N.
  // Sampling with a naive v directly would read half a texel off at both
  // ends, which reads as a slight overall shift rather than an obvious
  // artifact -- the classic invisible LUT bug.
  float n1 = u_lutSize - 1.0;
  vec3 coord = (n * n1 + 0.5) / u_lutSize;

  vec3 graded = texture(u_lut, coord).rgb;
  fragColor = vec4(mix(src.rgb, graded, u_amount), src.a);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Could not create shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return shader
}

export function isWebGL2Available(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2'))
  } catch {
    return false
  }
}

export type LutSource = HTMLImageElement | HTMLVideoElement | ImageBitmap | HTMLCanvasElement

export class LutRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private sourceTex: WebGLTexture
  private lutTex: WebGLTexture | null = null
  /**
   * A 1×1×1 3D texture kept bound to unit 1 whenever no real LUT is loaded.
   *
   * Not optional: GLSL samplers default to texture unit 0, so leaving
   * `u_lut` unassigned points a sampler3D at the same unit as the sampler2D
   * `u_source`. Two sampler *types* on one texture unit is an incomplete
   * draw state — every drawArrays raises GL_INVALID_OPERATION and renders
   * nothing, even though the `u_hasLut` branch never samples the LUT.
   * Caught by the isolation harness, which failed with a black frame on the
   * no-LUT passthrough case before this existed.
   */
  private nullLutTex: WebGLTexture
  private lutSize = 0
  private domainMin: [number, number, number] = [0, 0, 0]
  private domainMax: [number, number, number] = [1, 1, 1]
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private disposed = false

  constructor(private canvas: HTMLCanvasElement) {
    // premultipliedAlpha:false keeps the fragment output exactly what the
    // shader wrote, rather than having the compositor scale RGB by alpha.
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      alpha: true,
    })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl

    const program = gl.createProgram()
    if (!program) throw new Error('Could not create program')
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    this.program = program

    for (const name of [
      'u_source', 'u_lut', 'u_lutSize', 'u_amount', 'u_hasLut', 'u_domainMin', 'u_domainMax',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('Could not create VAO')
    this.vao = vao
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    // Two triangles covering clip space.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const loc = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    const tex = gl.createTexture()
    if (!tex) throw new Error('Could not create texture')
    this.sourceTex = tex
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    // See the nullLutTex field comment: unit 1 must always hold a *valid*
    // 3D texture, even when nothing is graded.
    const nullLut = gl.createTexture()
    if (!nullLut) throw new Error('Could not create placeholder LUT texture')
    this.nullLutTex = nullLut
    gl.bindTexture(gl.TEXTURE_3D, nullLut)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT,
      new Uint16Array([0, 0, 0, toHalf(1)]),
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
  }

  /** Upload a parsed .cube as a 3D texture. Pass null to clear the grade. */
  setLut(cube: ParsedCube | null): void {
    if (this.disposed) return
    const gl = this.gl

    if (this.lutTex) {
      gl.deleteTexture(this.lutTex)
      this.lutTex = null
    }
    if (!cube) {
      this.lutSize = 0
      return
    }

    const tex = gl.createTexture()
    if (!tex) throw new Error('Could not create LUT texture')
    gl.bindTexture(gl.TEXTURE_3D, tex)
    // LINEAR on a 3D texture is trilinear interpolation between LUT nodes —
    // exactly the interpolation the format expects, done in hardware.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    // CLAMP on all three axes: out-of-range input holds the edge node
    // rather than wrapping around to the opposite corner of the cube.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)

    // RGBA16F (see toHalf above for why not 32F). The file's
    // row order is already x(R)-fastest, which is texImage3D's own order —
    // see the note in cube-parser.ts.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.RGBA16F,
      cube.size, cube.size, cube.size, 0,
      gl.RGBA, gl.HALF_FLOAT, toHalfRGBA(cube.data),
    )

    this.lutTex = tex
    this.lutSize = cube.size
    this.domainMin = cube.domainMin
    this.domainMax = cube.domainMax
  }

  get hasLut(): boolean {
    return this.lutTex !== null
  }

  /**
   * Draw one frame. `amount` blends between source (0) and graded (1) —
   * useful for a before/after slider, and cheap to leave in.
   */
  render(source: LutSource, width: number, height: number, amount = 1): void {
    if (this.disposed) return
    const gl = this.gl

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    gl.viewport(0, 0, width, height)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex)
    // RGBA8 + UNSIGNED_BYTE, never SRGB8_ALPHA8: see the file header on why
    // no implicit linearization is wanted here.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    gl.uniform1i(this.uniforms.u_source!, 0)
    gl.uniform1f(this.uniforms.u_amount!, amount)
    gl.uniform1i(this.uniforms.u_hasLut!, this.lutTex ? 1 : 0)

    // u_lut is bound on every draw, LUT or not — the placeholder keeps unit
    // 1 valid so the sampler3D never collides with u_source on unit 0.
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex ?? this.nullLutTex)
    gl.uniform1i(this.uniforms.u_lut!, 1)
    if (this.lutTex) {
      gl.uniform1f(this.uniforms.u_lutSize!, this.lutSize)
      gl.uniform3fv(this.uniforms.u_domainMin!, this.domainMin)
      gl.uniform3fv(this.uniforms.u_domainMax!, this.domainMax)
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    if (this.lutTex) gl.deleteTexture(this.lutTex)
    gl.deleteTexture(this.nullLutTex)
    gl.deleteTexture(this.sourceTex)
    gl.deleteProgram(this.program)
    gl.deleteVertexArray(this.vao)
  }
}
