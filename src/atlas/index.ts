/**
 * The Atlas's species list, on its own so the species picker can load it without the network (src/atlas/atlas.ts).
 */
import type { Due } from '../core/layer';

/** One output of the network: a species (or, last, every other insect). */
export interface AtlasSpecies {
  i: number;
  name: string;
  common: string | null;
  order: string | null;
  family: string | null;
  genus: string | null;
  /** Training records. */
  n: number;
  taxon: number | null;
  photo: string | null;
  credit: string | null;
  /** Its top share in any cell on any day of a typical year: the top of its colour scale. */
  peak: number;
  /** 2026's test against its own calendar: 1 the network won, 0 it lost, null too few records to test. */
  test: number | null;
}

/** The year whose real warmth ships (ahead-YEAR.bin), and whose photos are set against the network (seen-YEAR). */
export const ATLAS_YEAR = 2026;

/** First and last day of year the ribbon covers, and its step (export.py SEASON, STEP). */
export const SEASON = [60, 304] as const;
export const STEP = 4;
const STEPS = Math.floor((SEASON[1] - SEASON[0]) / STEP) + 1;

export const atlasUrl = (f: string) => `${import.meta.env.BASE_URL}atlas/${f}`;
export const json = <T>(f: string): Promise<T | null> =>
  fetch(atlasUrl(f)).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

let seasons: Promise<Uint8Array | null> | null = null;
/** season.bin, fetched once (null when missing). */
function loadSeasons(): Promise<Uint8Array | null> {
  seasons ??= fetch(atlasUrl('season.bin'))
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null)
    .then((b) => (b ? new Uint8Array(b) : ((seasons = null), null)));
  return seasons;
}
/**
 * Each species' typical season as days of year (first day at a quarter of its best, its peak, its last: the bar the
 * tree's glow uses), Midwest-wide, from season.bin. The function returns null for a species with no curve; the promise
 * resolves null when the file is missing.
 */
export async function seasonDues(): Promise<((i: number) => Due | null) | null> {
  const b = await loadSeasons();
  if (!b) return null;
  const n = b.length / (2 * STEPS);
  return (i) => {
    if (!(i >= 0 && i < n)) return null;
    const at = i * 2 * STEPS;
    let pk = 0;
    for (let k = 1; k < STEPS; k++) if (b[at + k]! > b[at + pk]!) pk = k;
    if (!b[at + pk]) return null;
    const lim = b[at + pk]! / 4;
    let s = pk, e = pk;
    while (s > 0 && b[at + s - 1]! >= lim) s--;
    while (e < STEPS - 1 && b[at + e + 1]! >= lim) e++;
    const day = (k: number) => SEASON[0] + k * STEP;
    return { start: day(s), peak: day(pk), end: day(e) };
  };
}
/**
 * How far into its season every species is on a day: its expected photos over the map that day, as a share of its
 * own best day (0-1; season.bin, the same curves as each species' time bar). `year`: ATLAS_YEAR's own season, else a
 * typical year's. Fetched once, for the tree of life's "out now" glow, without the network.
 */
export async function outOn(doy: number, year: boolean): Promise<Float32Array | null> {
  const b = await loadSeasons();
  if (!b) return null;
  const n = b.length / (2 * STEPS);
  if (doy < SEASON[0] || doy > SEASON[1]) return new Float32Array(n); // winter: the curves stop at the season's edges
  const x = Math.min(STEPS - 1, Math.max(0, (doy - SEASON[0]) / STEP));
  const j = Math.min(STEPS - 2, Math.floor(x));
  const f = x - j;
  return Float32Array.from({ length: n }, (_, i) => {
    const at = (i * 2 + (year ? 1 : 0)) * STEPS + j;
    return (b[at]! * (1 - f) + b[at + 1]! * f) / 255;
  });
}

/** Training records a species needs before its season curve is trusted as a "flies with" match. */
export const TWIN_MIN_RECORDS = 500;
/**
 * The species whose typical Midwest season (season.bin's typical curves, as seasonDues) best matches species `i`'s: overlap
 * of the two peak-scaled curves (sum of the smaller over sum of the larger, so timing, width and a second brood all count),
 * plus a small nudge (0.03 per tenfold records) toward species people actually photograph. Leaves out the species' own
 * genus and keeps one per genus, so near-twin congeners don't fill the row. Best first; empty for a species with no curve.
 */
export function pickTwins(b: Uint8Array, species: readonly Pick<AtlasSpecies, 'i' | 'name' | 'genus' | 'n'>[], i: number, n = 3): number[] {
  const rows = b.length / (2 * STEPS);
  if (!(i >= 0 && i < rows)) return [];
  const at = (j: number) => j * 2 * STEPS;
  const a = at(i);
  if (!b.subarray(a, a + STEPS).some((v) => v > 0)) return [];
  const genus = (s: Pick<AtlasSpecies, 'name' | 'genus'>) => s.genus ?? s.name.split(' ')[0]!;
  const self = species.find((s) => s.i === i);
  const scored: [number, number, string][] = [];
  for (const s of species) {
    if (s.i === i || s.n < TWIN_MIN_RECORDS || !(s.i >= 0 && s.i < rows)) continue;
    const c = at(s.i);
    let lo = 0, hi = 0;
    for (let k = 0; k < STEPS; k++) {
      const x = b[a + k]!, y = b[c + k]!;
      lo += Math.min(x, y);
      hi += Math.max(x, y);
    }
    if (lo) scored.push([s.i, lo / hi + 0.03 * Math.log10(s.n), genus(s)]);
  }
  scored.sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  const seen = new Set(self ? [genus(self)] : []);
  const out: number[] = [];
  for (const [j, , g] of scored) {
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(j);
    if (out.length >= n) break;
  }
  return out;
}
/** pickTwins over season.bin, fetched once; null when the file is missing. */
export async function loadTwins(species: readonly AtlasSpecies[], i: number, n = 3): Promise<number[] | null> {
  const b = await loadSeasons();
  return b ? pickTwins(b, species, i, n) : null;
}

/** The ?species= key for a species: its scientific name, lower case, hyphens ("papilio-glaucus"). */
export const atlasKey = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

/** A year's biggest surprises (pipeline/atlas/seen.py): species index and a few words, "2.0×", "3%", "11 d late". */
export interface Surprise {
  i: number;
  note: string;
}
let surprising: Promise<{ year: number; list: Surprise[] } | null> | null = null;
/** The year's surprises for the species picker, from seen-YEAR.json. Fetched once; null when missing. */
export function loadSurprises(year: number): Promise<{ year: number; list: Surprise[] } | null> {
  surprising ??= json<{ species: [number, number, number | null, number | null][]; surprises?: number[] }>(`seen-${year}.json`).then((f) =>
    f?.surprises
      ? {
          year,
          list: f.surprises.map((i) => {
            const [, , r, d] = f.species[i]!;
            const note = r !== null ? (r < 1 ? `${Math.max(1, Math.round(r * 100))}%` : `${r < 9.95 ? r.toFixed(1) : Math.round(r)}×`) : `${Math.abs(d ?? 0)} d ${(d ?? 0) > 0 ? 'early' : 'late'}`;
            return { i, note };
          }),
        }
      : ((surprising = null), null),
  );
  return surprising;
}

/** The species whose season ran furthest off its calendar: [species index, days early (negative: late)], biggest gap first. */
export type OffSchedule = [number, number][];
/** Photos a species needs expected before its timing is worth ranking. */
export const OFF_MIN_EXPECTED = 50;
/** The n species with the largest |days| among those with at least OFF_MIN_EXPECTED photos expected (seen-YEAR.json rows). */
export function pickOffSchedule(rows: readonly (readonly [number, number, number | null, number | null])[], n = 10): OffSchedule {
  const out: OffSchedule = [];
  rows.forEach((r, i) => {
    if (r[1] >= OFF_MIN_EXPECTED && r[3] !== null && r[3] !== 0) out.push([i, r[3]]);
  });
  return out.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0] - b[0]).slice(0, n);
}
type SeenRows = [number, number, number | null, number | null][];
let rowing: Promise<SeenRows | null> | null = null;
/** The year's rows of seen-YEAR.json ([seen, expected, ratio, days] per species), fetched once for the off-schedule and quiet strips; null when missing. */
const seenRows = (year: number): Promise<SeenRows | null> =>
  (rowing ??= json<{ species: SeenRows }>(`seen-${year}.json`).then((f) => f?.species ?? ((rowing = null), null)));
/** The year's most off-schedule species for the species picker, from seen-YEAR.json. Null when missing. */
export function loadOffSchedule(year: number, n = 10): Promise<OffSchedule | null> {
  return seenRows(year).then((r) => (r ? pickOffSchedule(r, n) : null));
}
/** Photos a species needs expected before a shortfall is worth ranking, and how far below expected counts as quiet. */
export const QUIET_MIN_EXPECTED = 100;
export const QUIET_BELOW = 0.6;
/** A quiet species: its index and the photos it had (of those expected). */
export type Quiet = { i: number; seen: number; expected: number };
/** The n species with the fewest photos against expected: at least QUIET_MIN_EXPECTED expected, ratio outside chance and under QUIET_BELOW. */
// Near zero (under 5% of expected) is almost always a periodical brood's off-year or a data gap, not a quiet year.
export function pickQuiet(rows: readonly (readonly [number, number, number | null, number | null])[], n = 10): Quiet[] {
  const out: Quiet[] = [];
  rows.forEach((r, i) => {
    if (r[1] >= QUIET_MIN_EXPECTED && r[2] !== null && r[2] < QUIET_BELOW && r[0] >= r[1] * 0.05) out.push({ i, seen: r[0], expected: Math.round(r[1]) });
  });
  return out.sort((a, b) => a.seen / a.expected - b.seen / b.expected || b.expected - a.expected || a.i - b.i).slice(0, n);
}
/** The year's quietest species for the species picker, from seen-YEAR.json. Null when missing. */
export function loadQuiet(year: number, n = 10): Promise<Quiet[] | null> {
  return seenRows(year).then((r) => (r ? pickQuiet(r, n) : null));
}
/** "9 d early" / "4 d late". */
export const offNote = (days: number) => `${Math.abs(days)} d ${days > 0 ? 'early' : 'late'}`;

let index: Promise<AtlasSpecies[] | null> | null = null;
/** The species list (the last row, "other", left out). Fetched once. */
export function loadIndex(): Promise<AtlasSpecies[] | null> {
  index ??= json<AtlasSpecies[]>('species.json').then((s) => (s ? s.slice(0, -1) : ((index = null), null)));
  return index;
}
