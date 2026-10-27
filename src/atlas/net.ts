/**
 * The Atlas network, run in the browser (pipeline/atlas/model.py, exported by pipeline/atlas/export.py).
 *
 * Analogy: a shared "eye" (the trunk) looks at a place and a moment in the season and writes 256 numbers about it.
 * Each species reads those numbers with its own row of the last layer to score how likely a photo here, now, is of
 * it; a softmax turns the scores into shares. Warmth never enters the eye: each species blends three clocks
 * (calendar day, day + half of "days ahead", day + all of it), so an early spring slides the season in time.
 *
 * Plain typed arrays, no DOM and no libraries, so the same file runs in a worker, the page and Node tests.
 */

export interface ModelMeta {
  version: string;
  n_out: number;
  hidden: number;
  depth: number;
  lambdas: number[];
  place_freqs: number[];
  time_harmonics: number;
  box: { s: number; n: number; w: number; e: number };
  norm_dd: { center: number; scale: number };
  tensors: { name: string; shape: number[]; offset: number }[];
}

/** One place: latitude, longitude and its typical warmth by 30 June (degree-days). */
export interface Place {
  lat: number;
  lng: number;
  dd: number;
}

/** IEEE half-precision bits -> number. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export class AtlasNet {
  readonly meta: ModelMeta;
  readonly nOut: number;
  readonly hidden: number;
  /** Each species' blend of the clocks, [nOut * clocks], rows sum to 1. */
  readonly clockMix: Float32Array;
  private readonly t: Map<string, Float32Array>;
  /** Inputs to the trunk: the place features, then sines and cosines of the clock time. */
  readonly inDim: number;

  constructor(meta: ModelMeta, raw: ArrayBuffer) {
    this.meta = meta;
    this.nOut = meta.n_out;
    this.hidden = meta.hidden;
    const bits = new Uint16Array(raw);
    this.t = new Map();
    for (const { name, shape, offset } of meta.tensors) {
      const n = shape.reduce((a, b) => a * b, 1);
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = halfToFloat(bits[offset + i]!);
      this.t.set(name, a);
    }
    this.inDim = this.placeDim + 2 * meta.time_harmonics;
    const logits = this.get('clock_logits');
    const m = meta.lambdas.length;
    this.clockMix = new Float32Array(this.nOut * m);
    for (let s = 0; s < this.nOut; s++) {
      let mx = -Infinity;
      for (let k = 0; k < m; k++) mx = Math.max(mx, logits[s * m + k]!);
      let z = 0;
      for (let k = 0; k < m; k++) z += Math.exp(logits[s * m + k]! - mx);
      for (let k = 0; k < m; k++) this.clockMix[s * m + k] = Math.exp(logits[s * m + k]! - mx) / z;
    }
  }

  /** One weight tensor, row-major as PyTorch keeps it. */
  get(name: string): Float32Array {
    const a = this.t.get(name);
    if (!a) throw new Error(`model.bin has no ${name}`);
    return a;
  }

  /** The 19 place inputs, exactly as model.place_features. */
  placeFeatures(p: Place, out: Float32Array = new Float32Array(this.inDim), at = 0): Float32Array {
    const b = this.meta.box;
    const y = (p.lat - (b.s + b.n) / 2) / ((b.n - b.s) / 2);
    const x = (p.lng - (b.w + b.e) / 2) / ((b.e - b.w) / 2);
    let i = at;
    out[i++] = y;
    out[i++] = x;
    out[i++] = (p.dd - this.meta.norm_dd.center) / this.meta.norm_dd.scale;
    for (const f of this.meta.place_freqs) {
      out[i++] = Math.sin((Math.PI * f * y) / 2);
      out[i++] = Math.cos((Math.PI * f * y) / 2);
      out[i++] = Math.sin((Math.PI * f * x) / 2);
      out[i++] = Math.cos((Math.PI * f * x) / 2);
    }
    return out;
  }

  get placeDim(): number {
    return 3 + 4 * this.meta.place_freqs.length;
  }

  /** The clock inputs, exactly as model.time_features: sin then cos of the day of year at each harmonic. */
  timeFeatures(tau: number, out: Float32Array, at = 0): Float32Array {
    const K = this.meta.time_harmonics;
    const a = (2 * Math.PI * tau) / 365;
    for (let k = 1; k <= K; k++) {
      out[at + k - 1] = Math.sin(a * k);
      out[at + K + k - 1] = Math.cos(a * k);
    }
    return out;
  }

  /** Trunk features [hidden] for one place and one clock time (day of a 365-day year, may be fractional). */
  trunk(place: Float32Array, tau: number, out: Float32Array = new Float32Array(this.hidden)): Float32Array {
    const H = this.hidden;
    const x = new Float32Array(this.inDim);
    x.set(place.subarray(0, this.placeDim));
    this.timeFeatures(tau, x, this.placeDim);
    const h = linear(this.get('inp.0.weight'), this.get('inp.0.bias'), x, this.inDim, H);
    for (let i = 0; i < H; i++) h[i] = silu(h[i]!);
    for (let d = 0; d < this.meta.depth; d++) {
      const p = `blocks.${d}.`;
      const u = linear(this.get(p + 'net.0.weight'), this.get(p + 'net.0.bias'), h, H, H);
      for (let i = 0; i < H; i++) u[i] = silu(u[i]!);
      const v = linear(this.get(p + 'net.3.weight'), this.get(p + 'net.3.bias'), u, H, H);
      for (let i = 0; i < H; i++) v[i] = v[i]! + h[i]!;
      layerNorm(v, this.get(p + 'norm.weight'), this.get(p + 'norm.bias'), h);
    }
    out.set(h);
    return out;
  }

  /** Every species' log-share at one place and day, given that day's "days ahead". [nOut], logsumexp = 0. */
  logShares(p: Place, day: number, ahead: number): Float32Array {
    const place = this.placeFeatures(p);
    const W = this.get('head.weight');
    const B = this.get('head.bias');
    const H = this.hidden;
    const M = this.meta.lambdas.length;
    const z = new Float32Array(this.nOut);
    for (let m = 0; m < M; m++) {
      const h = this.trunk(place, day + this.meta.lambdas[m]! * ahead);
      for (let s = 0; s < this.nOut; s++) {
        let acc = B[s]!;
        const row = s * H;
        for (let j = 0; j < H; j++) acc += W[row + j]! * h[j]!;
        z[s] = z[s]! + this.clockMix[s * M + m]! * acc;
      }
    }
    return logSoftmax(z);
  }
}

function silu(v: number): number {
  return v / (1 + Math.exp(-v));
}

/** y = W x + b, W row-major [out, in] (PyTorch's layout). */
function linear(W: Float32Array, b: Float32Array, x: Float32Array, nIn: number, nOut: number): Float32Array {
  const y = new Float32Array(nOut);
  for (let o = 0; o < nOut; o++) {
    let acc = b[o]!;
    const row = o * nIn;
    for (let i = 0; i < nIn; i++) acc += W[row + i]! * x[i]!;
    y[o] = acc;
  }
  return y;
}

function layerNorm(x: Float32Array, g: Float32Array, b: Float32Array, out: Float32Array): void {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i]!;
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i]! - mean) ** 2;
  const inv = 1 / Math.sqrt(v / n + 1e-5);
  for (let i = 0; i < n; i++) out[i] = (x[i]! - mean) * inv * g[i]! + b[i]!;
}

export function logSoftmax(z: Float32Array): Float32Array {
  let mx = -Infinity;
  for (const v of z) mx = Math.max(mx, v);
  let s = 0;
  for (const v of z) s += Math.exp(v - mx);
  const lse = mx + Math.log(s);
  const out = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) out[i] = z[i]! - lse;
  return out;
}
