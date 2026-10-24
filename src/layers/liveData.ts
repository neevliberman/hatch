import { data, toSighting, type ReplayFile, type Sighting } from './lunaData';

/**
 * This season's forecast, rebuilt every night by pipeline/live into public/live/latest.json. Fetched after the first
 * paint; anything wrong with it (missing, bad JSON, another version) just means no live option. Only over http(s):
 * the one-file build opened from disk has no files beside it, so it never offers live mode.
 *
 * One file for every species: luna's forecast at the top level, every other species' under `species` (same layout,
 * the cells shared from the top level). A species missing from it, or broken in it, just has no live option.
 */

type Q = (number | null)[] | null;

/** Shape of public/live/latest.json (version 1). */
interface LiveFile {
  version: number;
  kind: string;
  /** A placeholder written before the real pipeline ran: only shown when a link asks for live mode. */
  stub?: boolean;
  /** Rebuilt after the fact (not a nightly run): labelled as a rerun, never stale. */
  backfill?: boolean;
  season: number;
  generated: string;
  as_of: string;
  forecast_through: string;
  stale_after_hours: number;
  model: { id: string; spec: string; ensemble: string };
  sources: { observed: string; forecast: string; after: string };
  quantiles: number[];
  cells: string[];
  median: Q[];
  lo?: Q[];
  hi?: Q[];
  out_now?: (number | null)[];
  dd?: (number | null)[];
  sightings?: ReplayFile['sightings'];
  /** Every other species' forecast, by species key (src/species.ts), same layout; `cells` may be left to the top level. */
  species?: Record<string, Partial<LiveFile>>;
}

export interface Live {
  season: number;
  stub: boolean;
  backfill: boolean;
  /** UTC ms. */
  generated: number;
  asOf: number;
  forecastThrough: number | null;
  staleAfterHours: number;
  model: LiveFile['model'];
  sources: LiveFile['sources'];
  /** Per replay cell (same order as luna-replay.json's cells): quantile days, or null where the file has none. */
  median: Q[];
  /** 10th / 90th percentile of each quantile day across the weather ensemble. */
  lo: Q[];
  hi: Q[];
  /** % of this spot's expected first-wave sightings already happened by as_of. */
  outNow: (number | null)[];
  /** Degree-days banked since 1 March, by as_of. */
  dd: (number | null)[];
  /** This season's sightings so far (openly licensed iNaturalist records, flag bit 2 = not yet confirmed). */
  sightings: Sighting[];
}

const DAY = 86_400_000;
const day = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + 'T00:00:00Z') : NaN);

export const liveAvailable = () => typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

/** 1 March to 30 September of the season: when a nightly file is expected (outside it a frozen file is normal). */
export const inSeason = (live: Pick<Live, 'season'>, now: number) =>
  now >= Date.UTC(live.season, 2, 1) && now < Date.UTC(live.season, 8, 30) + DAY;

/** The nightly run looks late: older than stale_after_hours, during the season. */
/** The nightly run looks late (older than stale_after_hours), or runs but its observed weather stopped advancing
 * (as_of more than 3 days back), during the season. A file rebuilt after the fact is never stale. */
export const isStale = (live: Live, now: number) =>
  !live.backfill &&
  inSeason(live, now) &&
  ((Number.isFinite(live.generated) && now - live.generated > live.staleAfterHours * 3_600_000) ||
    Math.floor((now - live.asOf) / DAY) > 3);

/** Turn one species' part of the file into per-replay-cell arrays, lined up with `cells` (that species' replay
 * cells; luna's by default). Null when anything needed is missing or the wrong shape. */
export function parseLive(f: LiveFile, cells: string[] = data.cells): Live | null {
  if (!f || f.version !== 1 || f.kind !== 'live' || !Number.isInteger(f.season)) return null;
  const asOf = day(f.as_of);
  const n = f.cells?.length;
  if (!Number.isFinite(asOf) || !n || !Array.isArray(f.median) || f.median.length !== n) return null;
  const okLen = (a: unknown[] | undefined) => Array.isArray(a) && a.length === n;
  // Same cell order as the replay file is the deal; if the pipeline ever drifts, line the cells up by id instead.
  const same = n === cells.length && f.cells.every((c, i) => c === cells[i]);
  const at = same ? null : new Map(f.cells.map((c, i) => [c, i] as const));
  const align = <T>(a: T[] | undefined, empty: T): T[] => {
    if (!okLen(a)) return cells.map(() => empty);
    if (same) return a!;
    return cells.map((c) => {
      const i = at!.get(c);
      return i === undefined ? empty : (a![i] ?? empty);
    });
  };
  const median = align<Q>(f.median, null);
  if (!median.some((q) => q && q[0] != null)) return null; // nothing to colour
  return {
    season: f.season,
    stub: f.stub === true,
    backfill: f.backfill === true,
    generated: Date.parse(f.generated),
    asOf,
    forecastThrough: Number.isFinite(day(f.forecast_through)) ? day(f.forecast_through) : null,
    staleAfterHours: Number.isFinite(f.stale_after_hours) ? f.stale_after_hours : 36,
    model: { id: String(f.model?.id ?? '?'), spec: String(f.model?.spec ?? ''), ensemble: String(f.model?.ensemble ?? '') },
    sources: { observed: String(f.sources?.observed ?? ''), forecast: String(f.sources?.forecast ?? ''), after: String(f.sources?.after ?? '') },
    median,
    lo: align<Q>(f.lo, null),
    hi: align<Q>(f.hi, null),
    outNow: align<number | null>(f.out_now, null),
    dd: align<number | null>(f.dd, null),
    sightings: (Array.isArray(f.sightings) ? f.sightings : []).filter((r) => Array.isArray(r) && r.length >= 6).map(toSighting),
  };
}

let loaded: Promise<LiveFile | null> | null = null;

/** The live file as sent, fetched once for every species (never cached stale by the browser: a new one lands every night). */
function liveFile(): Promise<LiveFile | null> {
  if (!liveAvailable()) return Promise.resolve(null);
  loaded ??= fetch(new URL(`${import.meta.env.BASE_URL}live/latest.json`, document.baseURI), { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<LiveFile>) : null))
    .catch(() => null);
  return loaded;
}

/** One species' part of the file, whole: its own fields over the shared cells. */
export const entryFor = (f: LiveFile | null, key: string): LiveFile | null => {
  if (!f || key === 'luna') return f;
  const e = f.species?.[key];
  return e && typeof e === 'object' ? ({ cells: f.cells, ...e } as LiveFile) : null;
};

/** This season's forecast for one species (`key` from src/species.ts), lined up with its replay's `cells`; null when
 * the file or its part for that species is missing or broken. */
export const loadLive = (key = 'luna', cells: string[] = data.cells): Promise<Live | null> =>
  liveFile().then((f) => {
    const e = entryFor(f, key);
    try {
      return e ? parseLive(e, cells) : null;
    } catch {
      return null; // a broken part for one species costs only that species its live option
    }
  });
