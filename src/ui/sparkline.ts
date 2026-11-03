import type { PlaceSeason } from '../core/layer';

/** The drawing's own units (it stretches to the room the card has: about 50-140 px wide, one line of text high). */
const W = 100;
const H = 16;
/** A second hump within a brood counts as a peak of its own when it is at least this share of the brood's top, and
 * the curve dips to at most DIP of the lower hump between them (a dent on one slope is no peak). */
const RISE = 0.3;
const DIP = 0.7;

// A no-break space keeps "May 3" together, as on the "Coming out near you" line (ui/near.ts).
const fmt = (year: number, doy: number) =>
  new Date(Date.UTC(year, 0, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(' ', '\u00A0');

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
 * the season from its first to its last day (a tick at each, a dot on each best day, the map's day as the time bar's
 * amber line), the last day, then the best days. The time bar's ink line and wash, but for this place.
 */
export function seasonLine(s: PlaceSeason): string {
  const first = s.broods[0]!.start;
  const end = s.broods[s.broods.length - 1]!.end;
  const peaks = s.broods.flatMap((r) => peaksIn(s, r.start, r.peak, r.end)).slice(0, 3);
  // A little either side, so the line rises from the baseline and the ticks sit inside it.
  const pad = Math.max(4, (end - first) * 0.06);
  const a = first - pad;
  const b = end + pad;
  const x = (d: number) => ((d - a) / (b - a)) * W;
  const at = (d: number) => {
    const k = (d - s.from) / s.step;
    const i = Math.max(0, Math.min(s.curve.length - 1, Math.floor(k)));
    const j = Math.min(s.curve.length - 1, i + 1);
    const f = Math.max(0, Math.min(1, k - i));
    return (s.curve[i] ?? 0) * (1 - f) + (s.curve[j] ?? 0) * f;
  };
  // Samples inside the window, plus its two ends.
  const days = [a];
  for (let k = 0; k < s.curve.length; k++) {
    const d = s.from + k * s.step;
    if (d > a && d < b) days.push(d);
  }
  days.push(b);
  const top = Math.max(...days.map(at), ...peaks.map(at)) || 1;
  const base = H - 0.5;
  const y = (v: number) => base - (v / top) * (H - 3);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const pts = days.map((d) => `${r1(x(d))},${r1(y(at(d)))}`).join(' ');
  // Stretched to the card's room, so every stroke keeps its own width and the dots are round caps on a zero-length line.
  const v = (cls: string, d: number, y1: number, y2: number) => `<path class="${cls}" d="M${r1(x(d))} ${y1}V${y2}"/>`;
  const win = s.window
    ? `<rect class="ps-window" x="${r1(x(s.window[0]))}" width="${r1(Math.max(1, x(s.window[1]) - x(s.window[0])))}" y="0" height="${H}"/>`
    : '';
  const now = s.today >= a && s.today <= b ? v('ps-now', s.today, 0, H) : '';
  const dots = peaks.map((d) => `<path class="ps-peak" d="M${r1(x(d))} ${r1(y(at(d)))}h0"/>`).join('');
  const svg =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    `<polygon class="ps-area" points="0,${base} ${pts} ${W},${base}"/>${win}${now}` +
    `<polyline class="ps-line${s.rough ? ' rough' : ''}" points="${pts}"/>${v('ps-tick', first, base - 4, base + 1)}${v('ps-tick', end, base - 4, base + 1)}${dots}</svg>`;
  const f = (d: number) => fmt(s.year, d);
  const best = s.noBest ? '' : `<span class="ps-best">best ${peaks.map(f).join(', ')}</span>`;
  return `<div class="probe-season"><span class="sr">Here, out </span><span>${f(first)}</span>${svg}<span><span class="sr">to </span>${f(end)}</span>${best}</div>`;
}
