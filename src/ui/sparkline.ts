import type { PlaceSeason } from '../core/layer';
import { dateOf } from './near';

/** The drawing's own units (it stretches to the room the card has: about 50-140 px wide, one line of text high). */
const W = 100;
const H = 16;
/** A second hump within a brood counts as a peak of its own when it is at least this share of the brood's top, and
 * the curve dips to at most DIP of the lower hump between them (a dent on one slope is no peak). */
const RISE = 0.3;
const DIP = 0.7;

/** Its peaks in one brood: the brood's top (the day "Coming out near you" names), and any other hump that stands
 * clear of it, so a species with two broods that never quite stop between them still shows both. Days of year. */
function peaksIn(s: PlaceSeason, start: number, top: number, end: number): number[] {
  const c = s.curve;
  const k0 = Math.max(0, Math.ceil((start - s.from) / s.step));
  const k1 = Math.min(c.length - 1, Math.floor((end - s.from) / s.step));
  const kt = Math.round((top - s.from) / s.step);
  const max = c[kt] ?? 0;
  const humps: number[] = [];
  for (let k = k0 + 1; k < k1; k++) if (k !== kt && c[k]! >= c[k - 1]! && c[k]! > c[k + 1]! && c[k]! >= max * RISE) humps.push(k);
  const kept = [kt];
  for (const k of humps.sort((a, b) => c[b]! - c[a]!)) {
    const clear = kept.every((j) => {
      let low = Infinity;
      for (let m = Math.min(j, k); m <= Math.max(j, k); m++) low = Math.min(low, c[m]!);
      return low <= c[k]! * DIP;
    });
    if (clear) kept.push(k);
  }
  return kept.map((k) => (k === kt ? top : s.from + k * s.step)).sort((a, b) => a - b);
}

/**
 * The card's one line on a place's season: "May 16 ⌒⌒ Oct 15 · best Jun 8, Aug 12". The first day, a sparkline of
 * the season from exactly its first to its last day (a dot on each best day, the map's day as the slider's amber
 * line, dashed at the end it lies beyond when it falls outside the season), the last day, then the best days: each
 * brood's top and any clear second hump, the two highest. A best day known only as a likely window reads "~May 28",
 * the window shaded faintly. The time bar's ink line and wash, but for this place.
 */
export function seasonLine(s: PlaceSeason): string {
  const first = s.broods[0]!.start;
  const end = s.broods[s.broods.length - 1]!.end;
  const height = (d: number) => {
    const k = (d - s.from) / s.step;
    const i = Math.max(0, Math.min(s.curve.length - 1, Math.floor(k)));
    const j = Math.min(s.curve.length - 1, i + 1);
    const f = Math.max(0, Math.min(1, k - i));
    return (s.curve[i] ?? 0) * (1 - f) + (s.curve[j] ?? 0) * f;
  };
  // Every brood's top first, then the other humps; the two highest of those, in date order.
  const tops = s.broods.map((r) => r.peak);
  const humps = s.broods.flatMap((r) => peaksIn(s, r.start, r.peak, r.end)).filter((d) => !tops.includes(d));
  const byHeight = (list: number[]) => [...list].sort((p, q) => height(q) - height(p));
  const peaks = [...byHeight(tops), ...byHeight(humps)].slice(0, 2).sort((p, q) => p - q);
  const span = Math.max(1, end - first);
  const x = (d: number) => ((d - first) / span) * W;
  const days = [first];
  for (let k = 0; k < s.curve.length; k++) {
    const d = s.from + k * s.step;
    if (d > first && d < end) days.push(d);
  }
  days.push(end);
  const top = Math.max(...days.map(height), ...peaks.map(height)) || 1;
  const base = H - 0.5;
  const y = (v: number) => base - (v / top) * (H - 3);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const pts = days.map((d) => `${r1(x(d))},${r1(y(height(d)))}`).join(' ');
  const clamp = (v: number) => Math.max(0, Math.min(W, v));
  const win = s.window
    ? `<rect class="ps-window" x="${r1(clamp(x(s.window[0])))}" width="${r1(Math.max(1, clamp(x(s.window[1])) - clamp(x(s.window[0]))))}" y="0" height="${H}"/>`
    : '';
  // Stretched to the card's room, so every stroke keeps its own width and the dots are round caps on a zero-length line.
  const off = s.today < first || s.today > end;
  const now = `<path class="ps-now${off ? ' off' : ''}" d="M${r1(clamp(x(s.today)))} 0V${H}"/>`;
  const dots = peaks.map((d) => `<path class="ps-peak" d="M${r1(x(d))} ${r1(y(height(d)))}h0"/>`).join('');
  const svg =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    `<polygon class="ps-area" points="0,${base} ${pts} ${W},${base}"/>${win}${now}` +
    `<polyline class="ps-line${s.rough ? ' rough' : ''}" points="${pts}"/>${dots}</svg>`;
  const f = (d: number) => dateOf(d, s.year);
  const best = `<span class="ps-best">best ${s.window ? '~' : ''}${peaks.map(f).join(', ')}</span>`;
  return `<div class="probe-season"><span class="sr">Here, out </span><span>${f(first)}</span>${svg}<span><span class="sr">to </span>${f(end)}</span>${best}</div>`;
}
