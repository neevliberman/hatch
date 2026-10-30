import { palette } from '../theme';

// The five forecast stages every species layer shares, and the helpers built on them. Nothing here knows which
// species it is drawing: a layer hands in its own forecast (q = days the share out reaches 5/25/50/75/95%).

export const STAGES = ['not yet', 'starting', 'peak', 'winding down', 'over'] as const;
export type Stage = (typeof STAGES)[number];
type Q = readonly (number | null)[] | null;
type RGBA = [number, number, number, number];

/** Where a cell's forecast season stands on day `doy`. */
export function stageAt(q: Q | undefined, doy: number): Stage {
  const [q05, q25, , q75, q95] = q ?? [];
  if (q05 == null || doy < q05) return 'not yet';
  if (q25 == null || doy < q25) return 'starting';
  if (q75 == null || doy < q75) return 'peak';
  if (q95 == null || doy < q95) return 'winding down';
  return 'over';
}

/** "Coming out near you" from a cell's forecast: first ones (5%), peak (50%) and last (95%; the 75% day plus a fortnight
 * when the file has none). `year`: a live forecast's season. */
export function dueOf(q: Q | undefined, year?: number) {
  const [q05, q25, q50, q75, q95] = q ?? [];
  if (q05 == null || q75 == null) return null;
  return { start: q05, peak: q50 ?? (q25 != null ? (q25 + q75) / 2 : q75), end: q95 ?? q75 + 14, year };
}

/** How many hexagons are at each stage on day `doy`. */
export function stageCounts(qs: readonly Q[], doy: number) {
  const n: Record<Stage, number> = { 'not yet': 0, starting: 0, peak: 0, 'winding down': 0, over: 0 };
  for (const q of qs) n[stageAt(q, doy)]++;
  return n;
}

/** One answer per forecast and day: these run on every playback frame and every pan, over every hexagon. */
function perDay(test: (qs: readonly Q[], doy: number) => boolean) {
  const memo = new WeakMap<readonly Q[], Map<number, boolean>>();
  return (qs: readonly Q[], doy: number) => {
    let days = memo.get(qs);
    if (!days) memo.set(qs, (days = new Map()));
    let v = days.get(doy);
    if (v === undefined) days.set(doy, (v = test(qs, doy)));
    return v;
  };
}

/** After the season: every hexagon "over" or "not yet", and some "over" (so not early spring, before it starts). */
export const isAsleep = perDay((qs, doy) => {
  const n = stageCounts(qs, doy);
  return n.over > 0 && n.over + n['not yet'] === qs.length;
});

/** The season in full swing: any hexagon starting or at its peak. Playback slows down for those days. */
export const isBusy = perDay((qs, doy) =>
  qs.some((q) => {
    const s = stageAt(q, doy);
    return s === 'starting' || s === 'peak';
  }),
);

const css = (c: RGBA) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** A see-through stage colour as it lands on the paper, so a legend swatch looks like the hexes it names. */
export const onPaper = (c: RGBA) => css(c.map((v, i) => v + ((palette.land[i]! - v) * (255 - c[3])) / 255 | 0) as RGBA);

/** Empty paper beside the seven forecast states, for an off-season margin note: east of Ohio on a wide screen,
 * under Kentucky on a phone. Layers over the same map can share it; one drawn elsewhere passes its own. */
export const MIDWEST_MARGIN = { wide: [-79.6, 39.4], phone: [-86.6, 36.3] } as { wide: [number, number]; phone: [number, number] };
