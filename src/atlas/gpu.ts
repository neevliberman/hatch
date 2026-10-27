import type { AtlasNet } from './net';

/**
 * The Atlas network on the graphics card (WebGL2), for the map: every cell at once in a few milliseconds, where the
 * plain version (net.ts) takes seconds. Same numbers: net.ts is the reference, and scripts/atlas-gpu-check.mjs
 * compares the two in a browser.
 *
 * Analogy: a spreadsheet where each layer of the network is one sheet. A "texture" is a sheet of numbers (4 per
 * cell, RGBA); drawing a rectangle fills the next sheet, with a tiny program working out each cell from the sheet
 * before. Rows are the inputs (a place at one clock time), columns are a layer's numbers, 4 per texel.
 *
 * Needs float render targets (EXT_color_buffer_float), which nearly every WebGL2 device has. create() returns null
 * when they're missing and the caller falls back to net.ts.
 */

/** Where row r's texel c lives in a texture that packs `perLine` rows of `width` texels side by side. */
interface Layout {
  rows: number;
  width: number;
  perLine: number;
  w: number;
  h: number;
}

const VERT = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
uniform int uPer; uniform int uWidth;
ivec2 at(int r, int c, int per, int width) { return ivec2((r % per) * width + c, r / per); }
void here(out int r, out int c) { ivec2 p = ivec2(gl_FragCoord.xy); r = p.y * uPer + p.x / uWidth; c = p.x % uWidth; }
`;

// y = W x + b, then SiLU (uAct) and a residual add (uRes). W: one texture line per output, its inputs 4 per texel.
const LINEAR = `${HEAD}
uniform sampler2D uX; uniform int uXPer; uniform int uXWidth;
uniform sampler2D uW; uniform sampler2D uB; uniform sampler2D uR; uniform int uAct; uniform int uRes;
void main() {
  int r, c; here(r, c);
  vec4 acc = texelFetch(uB, ivec2(c, 0), 0);
  for (int i = 0; i < uXWidth; i++) {
    vec4 x = texelFetch(uX, at(r, i, uXPer, uXWidth), 0);
    acc += vec4(dot(x, texelFetch(uW, ivec2(i, 4 * c), 0)), dot(x, texelFetch(uW, ivec2(i, 4 * c + 1), 0)),
                dot(x, texelFetch(uW, ivec2(i, 4 * c + 2), 0)), dot(x, texelFetch(uW, ivec2(i, 4 * c + 3), 0)));
  }
  if (uAct == 1) acc = acc / (1.0 + exp(-acc));
  if (uRes == 1) acc += texelFetch(uR, at(r, c, uPer, uWidth), 0);
  o = acc;
}`;

const NORM = `${HEAD}
uniform sampler2D uX; uniform sampler2D uG; uniform sampler2D uB;
void main() {
  int r, c; here(r, c);
  float s = 0.0;
  for (int i = 0; i < uWidth; i++) s += dot(texelFetch(uX, at(r, i, uPer, uWidth), 0), vec4(1));
  float mean = s / float(4 * uWidth);
  float v = 0.0;
  for (int i = 0; i < uWidth; i++) { vec4 d = texelFetch(uX, at(r, i, uPer, uWidth), 0) - mean; v += dot(d, d); }
  float inv = inversesqrt(v / float(4 * uWidth) + 1e-5);
  o = (texelFetch(uX, at(r, c, uPer, uWidth), 0) - mean) * inv * texelFetch(uG, ivec2(c, 0), 0) + texelFetch(uB, ivec2(c, 0), 0);
}`;

// Each species' score: its row of the last layer read against each clock's trunk features, blended by its clock mix.
const SCORE = `${HEAD}
uniform sampler2D uH; uniform int uHPer; uniform int uHWidth; uniform int uM;
uniform sampler2D uW; uniform sampler2D uB; uniform sampler2D uMix;
void main() {
  int r, c; here(r, c);
  vec4 z = vec4(0);
  for (int m = 0; m < uM; m++) {
    vec4 acc = vec4(0);
    for (int i = 0; i < uHWidth; i++) {
      vec4 h = texelFetch(uH, at(r * uM + m, i, uHPer, uHWidth), 0);
      acc += vec4(dot(h, texelFetch(uW, ivec2(i, 4 * c), 0)), dot(h, texelFetch(uW, ivec2(i, 4 * c + 1), 0)),
                  dot(h, texelFetch(uW, ivec2(i, 4 * c + 2), 0)), dot(h, texelFetch(uW, ivec2(i, 4 * c + 3), 0)));
    }
    z += texelFetch(uMix, ivec2(m, c), 0) * acc;
  }
  o = z + texelFetch(uB, ivec2(c, 0), 0);
}`;

// log of the softmax's denominator per row, over the first uN scores; then the asked species' log-shares.
const PICK = `${HEAD}
uniform sampler2D uZ; uniform int uZPer; uniform int uZWidth; uniform int uN; uniform ivec4 uSp;
float z(int r, int s) { vec4 v = texelFetch(uZ, at(r, s / 4, uZPer, uZWidth), 0); int k = s % 4; return k == 0 ? v.x : k == 1 ? v.y : k == 2 ? v.z : v.w; }
void main() {
  int r, c; here(r, c);
  float mx = -1e30;
  for (int i = 0; i < uZWidth; i++) {
    vec4 v = texelFetch(uZ, at(r, i, uZPer, uZWidth), 0);
    for (int k = 0; k < 4; k++) if (4 * i + k < uN) mx = max(mx, v[k]);
  }
  float s = 0.0;
  for (int i = 0; i < uZWidth; i++) {
    vec4 v = texelFetch(uZ, at(r, i, uZPer, uZWidth), 0);
    for (int k = 0; k < 4; k++) if (4 * i + k < uN) s += exp(v[k] - mx);
  }
  float lse = mx + log(s);
  o = vec4(z(r, uSp.x), z(r, uSp.y), z(r, uSp.z), z(r, uSp.w)) - lse;
}`;

export class AtlasGpu {
  private readonly gl: WebGL2RenderingContext;
  private readonly maxW: number;
  private readonly prog: Record<'linear' | 'norm' | 'score' | 'pick', WebGLProgram>;
  private readonly w = new Map<string, WebGLTexture>();
  private readonly fb: WebGLFramebuffer;
  private bufs: { rows: number; m: number; tex: Map<string, { t: WebGLTexture; l: Layout }> } | null = null;

  /** null: no WebGL2 or no float render targets here (use net.ts). */
  static create(net: AtlasNet): AtlasGpu | null {
    try {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      return new AtlasGpu(gl, net);
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, private readonly net: AtlasNet) {
    this.gl = gl;
    this.maxW = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    const compile = (src: string) => {
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, VERT);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, src);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(fs) ?? 'shader');
      const p = gl.createProgram()!;
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
      return p;
    };
    this.prog = { linear: compile(LINEAR), norm: compile(NORM), score: compile(SCORE), pick: compile(PICK) };
    this.fb = gl.createFramebuffer()!;
    gl.bindVertexArray(gl.createVertexArray());

    // Weights: a matrix [out, in] is `out` texture lines of in/4 texels (inputs padded to a multiple of 4).
    const H = net.hidden;
    const mat = (name: string, nIn: number, nOut: number, padOut = nOut) => {
      const src = net.get(name);
      const wIn = Math.ceil(nIn / 4);
      const data = new Float32Array(wIn * 4 * padOut);
      for (let o = 0; o < nOut; o++) data.set(src.subarray(o * nIn, (o + 1) * nIn), o * wIn * 4);
      this.w.set(name, this.texture(wIn, padOut, data));
    };
    const vec = (name: string, n: number, fill = 0) => {
      const data = new Float32Array(Math.ceil(n / 4) * 4).fill(fill);
      data.set(net.get(name));
      this.w.set(name, this.texture(data.length / 4, 1, data));
    };
    mat('inp.0.weight', net.inDim, H);
    vec('inp.0.bias', H);
    for (let d = 0; d < net.meta.depth; d++) {
      for (const k of ['net.0', 'net.3']) mat(`blocks.${d}.${k}.weight`, H, H), vec(`blocks.${d}.${k}.bias`, H);
      vec(`blocks.${d}.norm.weight`, H);
      vec(`blocks.${d}.norm.bias`, H);
    }
    const S = net.nOut;
    const sW = Math.ceil(S / 4);
    mat('head.weight', H, S, sW * 4);
    vec('head.bias', S);
    // Clock mix: texel (m, c) holds species 4c..4c+3's weight on clock m. One clock (a typical year): all ones.
    const M = net.meta.lambdas.length;
    const mix = new Float32Array(M * sW * 4);
    for (let s = 0; s < S; s++) for (let m = 0; m < M; m++) mix[(Math.floor(s / 4) * M + m) * 4 + (s % 4)] = net.clockMix[s * M + m]!;
    this.w.set('mix', this.texture(M, sW, mix));
    this.w.set('ones', this.texture(1, sW, new Float32Array(sW * 4).fill(1)));
  }

  private texture(w: number, h: number, data: Float32Array | null): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    return t;
  }

  private layout(rows: number, width: number): Layout {
    const perLine = Math.max(1, Math.floor(this.maxW / width));
    return { rows, width, perLine, w: Math.min(rows, perLine) * width, h: Math.ceil(rows / perLine) };
  }

  /** Scratch sheets for `rows` places at `m` clocks each, kept until the size changes. */
  private buffers(rows: number, m: number) {
    if (this.bufs?.rows === rows && this.bufs.m === m) return this.bufs.tex;
    this.bufs?.tex.forEach(({ t }) => this.gl.deleteTexture(t));
    const tex = new Map<string, { t: WebGLTexture; l: Layout }>();
    const add = (name: string, l: Layout) => tex.set(name, { t: this.texture(l.w, l.h, null), l });
    const hW = this.net.hidden / 4;
    add('x', this.layout(rows * m, Math.ceil(this.net.inDim / 4)));
    for (const k of ['a', 'b', 'c']) add(k, this.layout(rows * m, hW));
    add('z', this.layout(rows, Math.ceil(this.net.nOut / 4)));
    add('p', this.layout(rows, 1));
    this.bufs = { rows, m, tex };
    return tex;
  }

  private pass(name: keyof AtlasGpu['prog'], out: { t: WebGLTexture; l: Layout }, ints: Record<string, number>, tex: Record<string, WebGLTexture>) {
    const gl = this.gl;
    const p = this.prog[name];
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.t, 0);
    gl.viewport(0, 0, out.l.w, out.l.h);
    gl.uniform1i(gl.getUniformLocation(p, 'uPer'), out.l.perLine);
    gl.uniform1i(gl.getUniformLocation(p, 'uWidth'), out.l.width);
    for (const [k, v] of Object.entries(ints)) gl.uniform1i(gl.getUniformLocation(p, k), v);
    Object.entries(tex).forEach(([k, t], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(gl.getUniformLocation(p, k), unit);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Log-shares of up to four species at each row: a place (`places`, placeFeatures for each, back to back) on a day
   * (one for all rows, or one per row), with each row's "days ahead" (null: a typical year, which needs one clock,
   * so it runs three times faster). Returns one array per species, a value per row.
   */
  run(places: Float32Array, day: number | Float32Array, ahead: Float32Array | null, species: number[]): Float32Array[] {
    const gl = this.gl;
    const net = this.net;
    const P = net.placeDim;
    const rows = places.length / P;
    const lambdas = ahead ? net.meta.lambdas : [0];
    const M = lambdas.length;
    const tex = this.buffers(rows, M);
    const x = tex.get('x')!;
    const data = new Float32Array(x.l.w * x.l.h * 4);
    const row = new Float32Array(net.inDim);
    for (let r = 0; r < rows; r++) {
      row.set(places.subarray(r * P, (r + 1) * P));
      const d = typeof day === 'number' ? day : day[r]!;
      for (let m = 0; m < M; m++) {
        net.timeFeatures(d + lambdas[m]! * (ahead ? ahead[r]! : 0), row, P);
        const rr = r * M + m;
        const at = (Math.floor(rr / x.l.perLine) * x.l.w + (rr % x.l.perLine) * x.l.width) * 4;
        data.set(row, at);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, x.t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x.l.w, x.l.h, gl.RGBA, gl.FLOAT, data);

    const W = (n: string) => this.w.get(n)!;
    const [a, b, c] = ['a', 'b', 'c'].map((k) => tex.get(k)!) as [typeof x, typeof x, typeof x];
    const lin = (out: typeof x, src: typeof x, name: string, act: number, res?: typeof x) =>
      this.pass('linear', out, { uXPer: src.l.perLine, uXWidth: src.l.width, uAct: act, uRes: res ? 1 : 0 },
        { uX: src.t, uW: W(`${name}.weight`), uB: W(`${name}.bias`), uR: (res ?? src).t });
    lin(a, x, 'inp.0', 1);
    for (let d = 0; d < net.meta.depth; d++) {
      lin(b, a, `blocks.${d}.net.0`, 1);
      lin(c, b, `blocks.${d}.net.3`, 0, a);
      this.pass('norm', a, {}, { uX: c.t, uG: W(`blocks.${d}.norm.weight`), uB: W(`blocks.${d}.norm.bias`) });
    }
    const z = tex.get('z')!;
    this.pass('score', z, { uHPer: a.l.perLine, uHWidth: a.l.width, uM: M },
      { uH: a.t, uW: W('head.weight'), uB: W('head.bias'), uMix: W(ahead ? 'mix' : 'ones') });
    const p = tex.get('p')!;
    const sp = [0, 1, 2, 3].map((k) => species[k] ?? species[0] ?? 0);
    gl.useProgram(this.prog.pick);
    gl.uniform4i(gl.getUniformLocation(this.prog.pick, 'uSp'), sp[0]!, sp[1]!, sp[2]!, sp[3]!);
    this.pass('pick', p, { uZPer: z.l.perLine, uZWidth: z.l.width, uN: net.nOut }, { uZ: z.t });
    const outPx = new Float32Array(p.l.w * p.l.h * 4);
    gl.readPixels(0, 0, p.l.w, p.l.h, gl.RGBA, gl.FLOAT, outPx);
    return species.slice(0, 4).map((_, k) => {
      const v = new Float32Array(rows);
      for (let r = 0; r < rows; r++) v[r] = outPx[r * 4 + k]!;
      return v;
    });
  }
}
