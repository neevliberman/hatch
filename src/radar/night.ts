// Hatch Night: the radar replay's night view. The glow is the radar's own echo; the dots are SIMULATED. Each dot is born
// where the radar saw an echo (the stronger the echo, the likelier the place), then drifts with the hour's wind. How
// many dots are out follows the radar's total echo for the scan. A dot is not an animal and nothing here is a count.
// Loaded with the replay (radarReplay.ts); nothing here ships in the page.
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';

type RGBA = [number, number, number, number];

export interface NightMeta {
  lat: number;
  lon: number;
  times: string[];
  polar: { rays: number; gates: number; gate_m: number; first_m: number; step_deg: number };
  kept: { range_km: [number, number] };
}

/** Hourly wind at the radar, as the way it blows TOWARD, in metres a second east (u) and north (v). */
export interface Wind {
  t: number[];
  u: number[];
  v: number[];
}

export async function loadWind(base: string): Promise<Wind | null> {
  try {
    const res = await fetch(`${base}wind.json`);
    if (!res.ok) return null;
    const w = (await res.json()) as { times: string[]; speed: number[]; from: number[] };
    if (w.times.length < 2) return null;
    const a = w.from.map((d) => (d * Math.PI) / 180);
    return { t: w.times.map((s) => Date.parse(s) / 1000), u: w.speed.map((s, i) => -s * Math.sin(a[i]!)), v: w.speed.map((s, i) => -s * Math.cos(a[i]!)) };
  } catch {
    return null;
  }
}

/** Echo strength, weak to strong, as glow on a dark sky: deep blue, teal, moss, amber, pale gold. */
export function glowRamp(n: number): RGBA[] {
  const A: RGBA[] = [[34, 70, 118, 70], [44, 128, 150, 150], [96, 168, 140, 190], [214, 140, 56, 215], [246, 176, 84, 240]];
  return Array.from({ length: n }, (_, i) => {
    const p = (i / (n - 1)) * (A.length - 1);
    const k = Math.min(Math.floor(p), A.length - 2);
    const f = p - k;
    return A[k]!.map((v, j) => Math.round(v * (1 - f) + A[k + 1]![j]! * f)) as RGBA;
  });
}

export const NIGHT_SKY: RGBA = [11, 21, 30, 250];

const N = 18000;
const RAD = Math.PI / 180;
// Simulated flight: a dot lives 12 to 36 minutes, flies with the wind plus its own small push (up to 1.5 m/s).
const LIFE = [720, 2160];
const OWN = 1.5;
const FADE_IN = 90;
const FADE_OUT = 240;

export interface Night {
  /** The echo's total for each scan, 0 to 1 (the busiest scan is 1): drawn as the line under the card. */
  spark: number[];
  /** The dots at `t` (seconds), as one layer. Advances the simulation by the time since the last call. */
  at(t: number): ScatterplotLayer;
}

export function createNight(m: NightMeta, frames: Uint8Array[], wind: Wind | null, levels: number): Night {
  const { gates, gate_m: gm, first_m: first, step_deg: step } = m.polar;
  const times = m.times.map((s) => Date.parse(s) / 1000);
  const reach = m.kept.range_km[1] * 1000;
  // Weight of one bin by its level: 0 for none, then rising a little faster than linearly (a strong echo is more insects,
  // but not a hundred times more).
  const W = new Float64Array(levels + 2);
  for (let l = 1; l < W.length; l++) W[l] = l ** 1.4;
  const total = frames.map((f) => {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += W[f[i]!]!;
    return s;
  });
  const top = Math.max(...total, 1);
  const spark = total.map((v) => v / top);

  // Per scan, running totals over its bins (built when first needed): a random number picks a bin in proportion to its weight.
  const cums = new Map<number, Float64Array>();
  const cumOf = (fi: number) => {
    let c = cums.get(fi);
    if (!c) {
      const f = frames[fi]!;
      c = new Float64Array(f.length);
      let s = 0;
      for (let i = 0; i < f.length; i++) c[i] = s += W[f[i]!]!;
      cums.set(fi, c);
      if (cums.size > 4) cums.delete(cums.keys().next().value!);
    }
    return c;
  };
  const near = (t: number) => {
    let b = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i]! - t) < Math.abs(times[b]! - t)) b = i;
    return b;
  };

  const X = new Float32Array(N);
  const Y = new Float32Array(N);
  const VX = new Float32Array(N);
  const VY = new Float32Array(N);
  const AGE = new Float32Array(N);
  const LIVES = new Float32Array(N);
  const spawn = (i: number, fi: number, age: number) => {
    const c = cumOf(fi);
    const all = c[c.length - 1]!;
    if (all <= 0) {
      LIVES[i] = 0; // nothing in this scan: stays unborn
      return;
    }
    const r = Math.random() * all;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    const az = (Math.floor(lo / gates) + Math.random() - 0.5) * step * RAD;
    const d = first + ((lo % gates) + Math.random()) * gm - gm / 2;
    X[i] = d * Math.sin(az);
    Y[i] = d * Math.cos(az);
    const heading = Math.random() * 2 * Math.PI;
    const push = Math.random() * OWN;
    VX[i] = push * Math.sin(heading);
    VY[i] = push * Math.cos(heading);
    LIVES[i] = LIFE[0]! + Math.random() * (LIFE[1]! - LIFE[0]!);
    AGE[i] = age;
  };

  /** The wind at `t`, linearly between the hours either side. */
  const blow = (t: number): [number, number] => {
    if (!wind) return [0, 0];
    const { t: wt, u, v } = wind;
    let k = 0;
    while (k < wt.length - 2 && wt[k + 1]! <= t) k++;
    const f = Math.min(1, Math.max(0, (t - wt[k]!) / (wt[k + 1]! - wt[k]!)));
    return [u[k]! * (1 - f) + u[k + 1]! * f, v[k]! * (1 - f) + v[k + 1]! * f];
  };

  let last = -1;
  let pos = new Float32Array(0);
  return {
    spark,
    at(t) {
      const fi = near(t);
      const fresh = last < 0 || t < last - 1500 || t - last > 1800;
      if (fresh) {
        // First look, a loop back to the start or a jump: begin again, with ages spread so they don't all fade at once.
        for (let i = 0; i < N; i++) spawn(i, fi, Math.random() * LIFE[1]!);
      } else {
        const dt = Math.max(0, t - last); // a small step back (a pause settling on its scan) leaves the dots where they are
        for (let i = 0; i < N; i++) {
          AGE[i] = AGE[i]! + dt;
          if (AGE[i]! > LIVES[i]! || Math.hypot(X[i]!, Y[i]!) > reach + 3000) spawn(i, fi, 0);
        }
        const [wu, wv] = blow(t);
        for (let i = 0; i < N; i++) {
          X[i] = X[i]! + (wu + VX[i]!) * dt;
          Y[i] = Y[i]! + (wv + VY[i]!) * dt;
        }
      }
      if (fresh || t > last) last = t;
      // How many are out: the radar's echo now (between the two nearest scans) against its busiest scan.
      let k = 0;
      while (k < times.length - 2 && times[k + 1]! <= t) k++;
      const f = Math.min(1, Math.max(0, (t - times[k]!) / Math.max(1, times[k + 1]! - times[k]!)));
      const share = Math.min(1, Math.sqrt((spark[k] ?? 0) * (1 - f) + (spark[k + 1] ?? spark[k] ?? 0) * f));
      const out = Math.round(N * share);
      if (pos.length < out * 2) pos = new Float32Array(N * 2);
      const colors = new Uint8Array(out * 4);
      for (let i = 0; i < out; i++) {
        pos[2 * i] = X[i]!;
        pos[2 * i + 1] = Y[i]!;
        const a = LIVES[i]! > 0 ? Math.min(1, AGE[i]! / FADE_IN, (LIVES[i]! - AGE[i]!) / FADE_OUT) : 0;
        colors[4 * i] = 255;
        colors[4 * i + 1] = 248;
        colors[4 * i + 2] = 226;
        colors[4 * i + 3] = Math.round(130 * Math.max(0, a));
      }
      return new ScatterplotLayer({
        id: 'night-dots',
        data: { length: out, attributes: { getPosition: { value: pos.slice(0, out * 2), size: 2 }, getFillColor: { value: colors, size: 4, normalized: true } } },
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: [m.lon, m.lat, 0],
        radiusUnits: 'meters',
        getRadius: 24,
        radiusMinPixels: 1,
        radiusMaxPixels: 6,
        pickable: false,
      });
    },
  };
}
