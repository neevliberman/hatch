import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { mothInk, palette } from '../theme';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension, FillStyleExtension, type FillStyleExtensionProps } from '@deck.gl/extensions';
import { cellToLatLng, latLngToCell } from 'h3-js';
import { GRID_RES } from '../core/grid';
import { dayOfYear, TimeAxis, type TimeSpec } from '../core/timeAxis';
import type { CaveatCard, Explainer, HatchLayer, LegendSpec, OffSeasonNote, ProbeCard, SeasonProfile, SpotStory } from '../core/layer';
import { restingSketch } from '../ui/sketch';
import mark from '../marks/moth.svg';
import {
  APPROXIMATE,
  bandOf,
  data,
  doyToMs,
  LIVE,
  SECOND_BROOD,
  sightingsFor,
  UNCONFIRMED,
  TYPICAL,
  type Mode,
  type Sighting,
} from './lunaData';
import { animating, hexFade, ripples } from './motion';
import { fineDays, fineLevel, fineManifest, forgetFine, KEEP_SEASONS, parentOf, RELEASE_MS, remember, RETRY_MS, type FineLevel } from './fineData';
import { isAsleep, isBusy, MIDWEST_MARGIN, onPaper, stageAt, stageCounts, STAGES, type Stage } from './stages';
import { isStale, type Live } from './liveData';
import { windowCheck } from './replayData';

/** Adults live about a week, so each sighting glows for this many days, fading as it ages. */
export const GLOW_DAYS = 10;
/**
 * Finer hexagons as you zoom in: res 4 (~45 km across) for the whole region, res 5 (~17 km) from FINE_ZOOM[5],
 * res 6 (~6 km) from FINE_ZOOM[6]. Each switch happens when the new hexes are ~10-15 px across, about as big as the
 * res-4 hexes look on the whole-Midwest view. Coming back out switches HYSTERESIS later, so a zoom that hovers on
 * a threshold doesn't flicker between levels.
 */
export const FINE_ZOOM: Record<number, number> = { 5: 6.4, 6: 7.9 };
const HYSTERESIS = 0.3;
/** A finer level only goes on screen once the zoom has asked for it this long (not mid fly-to or mid pinch). */
export const SETTLE_MS = 300;
/**
 * Phones draw res 5 with one instanced hexagon shape, as res 6 always is: true polygons for ~3,900 cells cost
 * memory that iOS can answer by dropping the whole WebGL context (a blank map).
 */
export const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
/** Spatial holdout (learn IL/IN/OH, test WI/MN): only claimed when the shipped model's own numbers show a pass. */
const hoHeat = data.model?.holdout_mae?.heat;
const hoCal = data.model?.holdout_mae?.cal;
const holdoutPass = Number.isFinite(hoHeat) && Number.isFinite(hoCal) && hoHeat! < hoCal!;
/** Year used to put dates on the "typical year" axis. Any non-leap year works. */
const TYPICAL_AXIS_YEAR = 2025;

export const STAGE_LABEL: Record<Stage, string> = {
  'not yet': 'not yet',
  starting: 'starting',
  peak: 'peak',
  'winding down': 'winding down',
  over: 'first wave over',
};

/** stageAt for a finer level's packed days (5 bytes per cell, day of year minus 60, 255 = never). */
function stageAtBytes(days: Uint8Array, i: number, doy: number): Stage {
  const d = doy - 60;
  const q = (k: number) => days[i * 5 + k]!;
  if (q(0) === 255 || d < q(0)) return 'not yet';
  if (q(1) === 255 || d < q(1)) return 'starting';
  if (q(3) === 255 || d < q(3)) return 'peak';
  if (q(4) === 255 || d < q(4)) return 'winding down';
  return 'over';
}
const bytesToQ = (days: Uint8Array, i: number) =>
  [0, 1, 2, 3, 4].map((k) => (days[i * 5 + k] === 255 ? null : days[i * 5 + k]! + 60));

type RGBA = [number, number, number, number];
// The stage colours and why they are what they are: palette.stages in theme.ts.
const STAGE_COLOR: Record<Stage, RGBA> = palette.stages;
// Hexes with no sightings nearby keep their stage colour (fading it made it look like another stage) under dark stripes.
const STRIPES: RGBA = palette.stripes;
// One object for every render, so deck.gl doesn't rebuild the pattern each playback frame. The 12px tile is drawn
// at 1:1: a shrunken tile blurs thin lines and loses their contrast.
export const STRIPE_MAPPING = { stripes: { x: 0, y: 0, width: 12, height: 12 } };
let stripeAtlas: HTMLCanvasElement | null = null;
export const stripes = () => {
  if (stripeAtlas) return stripeAtlas;
  const c = Object.assign(document.createElement('canvas'), { width: 12, height: 12 });
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5; // thin lines: the doubt is there, but it doesn't outshout the forecast
  // Three strokes so the diagonal tiles without seams.
  for (const o of [-12, 0, 12]) {
    g.beginPath();
    g.moveTo(o, 12);
    g.lineTo(o + 12, 0);
    g.stroke();
  }
  return (stripeAtlas = c);
};
const MOON: RGBA = palette.moth;
const SECOND: RGBA = palette.second;
const GREY: RGBA = palette.rough;
const css = (c: RGBA) => `rgb(${c[0]},${c[1]},${c[2]})`;

const dotColor = (s: Sighting): RGBA => {
  const c = s.flags & APPROXIMATE ? GREY : s.flags & SECOND_BROOD ? SECOND : MOON;
  return s.flags & UNCONFIRMED ? [c[0], c[1], c[2], 150] : c;
};

const fmtDoy = (year: number, doy: number) =>
  new Date(doyToMs(year, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** This season's nightly forecast, once public/live/latest.json has loaded (null: no live mode). */
let live: Live | null = null;
export const setLive = (l: Live | null) => void (live = l);

export const modeLabel = (mode: Mode) =>
  mode === TYPICAL
    ? `all years, ${data.years[0]}-${data.years[data.years.length - 1]}`
    : mode === LIVE
      ? // A season rebuilt after the fact is just that year ("2026"); a nightly one is "2026 live".
        `${live?.season ?? 'this year'}${live?.backfill ? '' : ' live'}${live?.stub ? ' (sample data)' : ''}`
      : mode;

/**
 * Scrub 1 Apr - 30 Sep, starting on `month` (0-based) / `day`, so switching years keeps the calendar date.
 * Live mode starts on the last day of observed weather unless a day is given, and marks it on the scrubber;
 * `now` decides whether the nightly file looks late.
 */
export function replayTimeSpec(mode: Mode, month?: number, day?: number, now = Date.now()): TimeSpec {
  if (mode === LIVE && live) {
    const y = live.season;
    return {
      // Same 1 Apr - 30 Sep as the replays: before April no hexagon has started, so a March start would open on an empty
      // map. A file from before 1 Apr makes the whole track forecast (src/ui/scrubber.ts).
      start: Date.UTC(y, 3, 1),
      end: Date.UTC(y, 8, 30),
      stepMs: TimeAxis.DAY,
      initial: month === undefined ? live.asOf : Date.UTC(y, month, day ?? 1),
      asOf: { at: live.asOf, stale: isStale(live, now) },
    };
  }
  month ??= 5;
  day ??= 10;
  const year = mode === TYPICAL ? TYPICAL_AXIS_YEAR : Number(mode);
  return {
    start: Date.UTC(year, 3, 1),
    end: Date.UTC(year, 8, 30),
    stepMs: TimeAxis.DAY,
    initial: Date.UTC(year, month, day),
    label:
      mode === TYPICAL
        ? (ms) => `${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} (all years)`
        : undefined,
  };
}

/** The live window's check on a fresh season (interval.checked.season, pipeline/fit/CALIBRATION.md), or null. */
function seasonCheck(): string | null {
  const ss = data.interval?.checked?.season;
  if (!ss) return null;
  const upTo = new Date(`${ss.as_of}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Tried on ${ss.year} with real weather only up to ${upTo}, the window caught the real peak in ${ss.peak[0]} of ${ss.peak[1]} east-west bands of the map. Some bands had already peaked by then.`;
}

/** The live-mode card at the top of the About panel: how this year's map is made, in plain words. */
function liveNotice(L: Live): { title: string; bullets: string[] } {
  const f = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const src = (s: string) => (s ? ` (${s})` : '');
  return {
    title: `${L.season}${L.backfill ? '' : ' live'}: how this forecast is made`,
    bullets: [
      ...(L.stub ? ['Sample data for testing the page, not a real forecast.'] : []),
      ...(L.backfill ? [`Rebuilt after the season${Number.isFinite(L.generated) ? `, on ${f(L.generated)},` : ''} the way the nightly forecast would have run. It is not being updated.`] : []),
      `Real weather up to ${f(L.asOf)}${src(L.sources.observed)}, then the 7-day forecast${src(L.sources.forecast)}, then each past year\u2019s weather run forward from there${src(L.sources.after)}. Each past year gives one way the rest of the season could go.`,
      'The colours use the middle of those runs. "Peak likely" on a hexagon\u2019s card is their spread plus the model\u2019s past misses: wide early in spring, narrower as real weather comes in.',
      `Days after ${f(L.asOf)} are forecast; the time bar is paler there.${L.backfill ? '' : ` The map updates every night, ${Number.isFinite(L.generated) ? `last on ${f(L.generated)}` : 'when new weather arrives'}.`}`,
      `The model (${L.model.id}) is frozen for the season: this year\u2019s sightings are shown to check it, never used to tune it.`,
    ],
  };
}

/**
 * The slider's season ribbon for a species, one value per day of the replay's range in `year`: the share of map hexagons
 * at each stage, sightings per day (smoothed over a week, so a quiet day doesn't read as a gap in the wave), and a note
 * on the busiest day of each named wave.
 */
export function seasonProfile(
  forecast: (number | null)[][],
  seen: Sighting[],
  day: (s: Sighting) => number,
  year: number,
  /** Each wave's note, which sightings belong to it, and a colour for a wave the forecast leaves out (washed in that
   * colour under the sightings line, so the ribbon shows it was seen, not forecast). */
  waves: [string, (s: Sighting) => boolean, string?][],
): SeasonProfile {
  // The same days the slider spans (replayTimeSpec), so day i of the ribbon sits under step i of the slider.
  const { start, end } = replayTimeSpec(String(year));
  const d0 = dayOfYear(start);
  const n = Math.round((end - start) / TimeAxis.DAY) + 1;
  // Solid colours, as the see-through map colours look on paper (the same as the key's swatches): the ribbon paints
  // each band over the next (no seams where they meet), which would mix see-through ones.
  const bands = STAGES.map((s) => ({ color: onPaper(STAGE_COLOR[s]), share: Array<number>(n).fill(0) }));
  // O(hexes + days): each hexagon adds +1 to a stage from the day it starts and -1 from the day the next stage starts
  // (the same chain as stageAt: a missing quantile ends it), then a running sum gives each day's count.
  const diff = STAGES.map(() => new Float64Array(n + 1));
  const at = (doy: number) => Math.min(n, Math.max(0, Math.ceil(doy - d0)));
  for (const q of forecast) {
    const [q05, q25, , q75, q95] = q;
    let from = 0;
    let k = 0;
    for (const edge of [q05, q25, q75, q95]) {
      if (edge == null) break;
      const to = Math.max(from, at(edge));
      diff[k]![from]! += 1;
      diff[k]![to]! -= 1;
      from = to;
      k++;
    }
    diff[k]![from]! += 1;
    diff[k]![n]! -= 1;
  }
  const w = 1 / Math.max(1, forecast.length);
  diff.forEach((d, k) => {
    let run = 0;
    for (let i = 0; i < n; i++) bands[k]!.share[i] = (run += d[i]!) * w;
  });
  const perDay = (keep: (s: Sighting) => boolean) => {
    const h = Array<number>(n + 6).fill(0);
    for (const s of seen) {
      const i = day(s) - d0;
      if (keep(s) && i >= 0 && i < n) for (let k = 0; k < 7; k++) h[i + k]! += 1 / 7;
    }
    return h.slice(3, n + 3);
  };
  const notes = waves.flatMap(([text, keep]) => {
    const h = perDay(keep);
    const at = h.indexOf(Math.max(...h));
    return h[at]! > 0 ? [{ at, text }] : [];
  });
  const seenOnly = waves.flatMap(([, keep, color]) => (color ? [{ color, seen: perDay(keep) }] : []));
  return { bands, seen: perDay(() => true), notes, ...(seenOnly.length ? { seenOnly } : {}) };
}

/** The map's first-frame wash for the hexagons `ids`: colour `c` of hexagon `i`, `wash` ms after the first frame
 * (map.ts), fading in over 600 ms, the northernmost starting 300 ms after the southernmost. */
export function washer(ids: string[]): (i: number, c: RGBA, wash: number) => RGBA {
  let north: number[] | null = null; // 0 at the south edge, 1 at the north; worked out when first needed
  return (i, c, wash) => {
    if (!north) {
      const lat = ids.map((id) => cellToLatLng(id)[0]);
      const lo = Math.min(...lat);
      const hi = Math.max(...lat);
      north = lat.map((y) => (y - lo) / (hi - lo || 1));
    }
    return [c[0], c[1], c[2], c[3] * Math.min(1, Math.max(0, (wash - north[i]! * 300) / 600))];
  };
}

/** Mean absolute error of the heat forecast and the calendar over the shipped band-year scores. */
export function scoreSummary(year?: number) {
  const rows = data.scores.filter((r) => year === undefined || r.year === year);
  const mae = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0) / Math.max(1, rows.length);
  return {
    n: rows.length,
    heat: mae((r) => (Math.abs(r.heat_onset - r.obs_onset) + Math.abs(r.heat_peak - r.obs_peak)) / 2),
    calendar: mae((r) => (Math.abs(r.cal_onset - r.obs_onset) + Math.abs(r.cal_peak - r.obs_peak)) / 2),
    rows,
  };
}

export interface LunaLayer extends HatchLayer {
  mode(): Mode;
  setMode(mode: Mode): void;
  /** The day's map in one sentence, for screen readers: how many hexagons are at each stage, and moths seen. */
  summary(t: number): string;
  /** Resolution of the hexagons on screen now (4, 5 or 6). */
  res(): number;
  /** True when the small hexagons on screen show this season's own days (false for big hexagons, or mid switch). */
  fineCurrent?(): boolean;
  /** The hexagon the card describes at lngLat, at the resolution on screen (null outside the map). */
  cellAt(lngLat: [number, number]): string | null;
}

interface FineCell {
  id: string;
  i: number;
  seen: boolean;
}
interface Shown {
  level: FineLevel;
  data: FineCell[];
  unseen: FineCell[];
}

/** onData: called when finer hexes finish loading or the level on screen changes (the map should redraw). */
export function createLunaLayer(initial: Mode = TYPICAL, onData: () => void = () => {}): LunaLayer {
  let mode = initial;
  let shown = sightingsFor(mode);
  const profiles = new Map<Mode, SeasonProfile>(); // the ribbon depends only on the mode
  const cellIndex = new Map(data.cells.map((c, i) => [c, i] as const));
  const cells = data.cells.map((id, i) => ({ id, i, seen: data.seen[i] === 1 }));
  const isLive = () => mode === LIVE && live !== null;
  const yearOf = () => (mode === TYPICAL ? TYPICAL_AXIS_YEAR : isLive() ? live!.season : Number(mode));
  const forecast = () => (isLive() ? live!.median : (data.forecast[mode] ?? data.forecast[TYPICAL]!)) as ((number | null)[] | null)[];
  const filterExt = [new DataFilterExtension({ filterSize: 1 })];

  const unseen = cells.filter((c) => !c.seen);
  // An ink ring spreads from each moth on the day it is seen, while playing.
  const rings = ripples<Sighting>('luna-ripples', (s) => [s.lng, s.lat], palette.dotRim);
  let sleepNote: OffSeasonNote | undefined;
  const cellColor = (i: number, doy: number): RGBA => STAGE_COLOR[stageAt(forecast()[i], doy)];
  // Today's sightings, which breathe while paused (map.ts). Cached per day and season.
  let fresh = { key: '', list: [] as Sighting[] };
  const newest = (doy: number) => {
    const key = `${doy}|${mode}`;
    if (fresh.key !== key) fresh = { key, list: shown.filter((s) => (mode === TYPICAL ? s.pdoy : s.doy) === doy) };
    return fresh.list;
  };
  const washed = washer(data.cells);

  // ---- finer levels: the level the zoom asks for, what has loaded, and what is on screen
  let wantRes = 4;
  let wantSince = 0;
  let shownRes = 4;
  /** The days drawn last at shownRes: kept on screen while a season switch loads its own, so the map doesn't flash coarse. */
  let shownDays: Uint8Array | null = null;
  const shown5or6 = new Map<number, Shown>();
  const fineDaysLoaded = new Map<string, Uint8Array>();
  /** Requests on their way or recently failed, by `${res}/${mode}` ('manifest' for the level list): no retry before RETRY_MS. */
  const loading = new Map<string, number>();
  let fineLevels: number[] = [];
  const loadManifest = () => {
    loading.set('manifest', Infinity);
    void fineManifest().then((m) => {
      fineLevels = m ? Object.keys(m.levels).map(Number) : [];
      loading.set('manifest', m ? Infinity : performance.now() + RETRY_MS); // got it: never ask again
      if (fineLevels.length && wantRes > 4) onData();
    });
  };
  loadManifest();
  const resForZoom = (zoom: number) => {
    let r = wantRes;
    while (r < 6 && zoom >= FINE_ZOOM[r + 1]!) r++;
    while (r > 4 && zoom < FINE_ZOOM[r]! - HYSTERESIS) r--;
    if (r !== wantRes) {
      wantSince = performance.now();
      if (r > shownRes) setTimeout(onData, SETTLE_MS + 20); // look again once the zoom has rested
    }
    return (wantRes = r);
  };
  const load = (res: number) => {
    const key = `${res}/${mode}`;
    if ((loading.get(key) ?? 0) > performance.now()) return;
    loading.set(key, Infinity);
    void Promise.all([fineLevel(res), fineDays(res, mode)]).then(([level, days]) => {
      if (!level || !days || days.length !== level.cells.length * 5) {
        loading.set(key, performance.now() + RETRY_MS); // missing, stale or offline: stay coarser, ask again later
        return;
      }
      loading.delete(key);
      if (!shown5or6.has(res)) {
        const fc = level.cells.map((id, i) => ({ id, i, seen: level.seen[i] === 1 }));
        shown5or6.set(res, { level, data: fc, unseen: fc.filter((c) => !c.seen) });
      }
      // A few seasons per level, never the season on screen.
      remember(fineDaysLoaded, key, days, KEEP_SEASONS * fineLevels.length, (k) => k.endsWith(`/${mode}`));
      if (wantRes >= res) onData();
    });
  };
  // Zoomed back out: after RELEASE_MS at res 4, let the finer levels go (see RELEASE_MS).
  let releaseTimer = 0;
  const releaseLater = () => {
    if (releaseTimer || !shown5or6.size) return;
    releaseTimer = window.setTimeout(() => {
      releaseTimer = 0;
      if (shownRes > 4 || wantRes > 4) return;
      shown5or6.clear();
      fineDaysLoaded.clear();
      forgetFine();
    }, RELEASE_MS);
  };
  /** Finest level at or below the wanted one that can be drawn now, and the days to draw it with. */
  const pickRes = (want: number): { res: number; days: Uint8Array | null } => {
    if (mode === LIVE) return { res: 4, days: null }; // live has no finer files: big hexagons at every zoom
    if (!fineLevels.length && want > 4 && (loading.get('manifest') ?? 0) <= performance.now()) loadManifest();
    // Going finer waits until the zoom has rested; going coarser (or staying) is immediate.
    if (want > shownRes && performance.now() - wantSince < SETTLE_MS) want = shownRes;
    for (let r = want; r > 4; r--) {
      if (!fineLevels.includes(r)) continue;
      const days = fineDaysLoaded.get(`${r}/${mode}`);
      if (!days) load(r);
      if (shown5or6.has(r) && days) return { res: r, days };
      // A season switch: keep this level's last colours for the moment its new days are on their way (only while
      // the request is out: once it fails, the old season's colours would sit under the new season's name).
      if (r === shownRes && shownDays && loading.get(`${r}/${mode}`) === Infinity) return { res: r, days: shownDays };
    }
    return { res: 4, days: null };
  };
  /** Forecast quantiles, "seen" and the cell id at lngLat on the level on screen. */
  const lookup = (lngLat: [number, number]) => {
    if (shownRes > 4) {
      const s = shown5or6.get(shownRes)!;
      const days = shownDays; // what is drawn (for a moment after a season switch, the last season's colours)
      const cell = latLngToCell(lngLat[1], lngLat[0], shownRes);
      const i = s.level.index.get(cell);
      if (days && i !== undefined) return { cell, q: bytesToQ(days, i), seen: s.level.seen[i] === 1, parent: parentOf(cell) };
      if (days) return null;
    }
    const cell = latLngToCell(lngLat[1], lngLat[0], GRID_RES);
    const i = cellIndex.get(cell);
    if (i === undefined) return null;
    return { cell, q: forecast()[i] ?? [], seen: cells[i]!.seen, parent: cell };
  };

  let lit: { key: string; pts: [number, number][] } = { key: '', pts: [] };

  // The default spot until a hex is tapped: Chicago's western suburbs (the city's own hex centre is in the lake).
  const HOME: [number, number] = [-88.0, 41.9];
  const spotStory = (lngLat: [number, number] | null, t: number, name?: string, example = false): SpotStory | null => {
    const at = lngLat ?? HOME;
    const hit = lookup(at);
    if (!hit) return null;
    const [q05, q25, , q75, q95] = hit.q;
    if (q05 == null || q25 == null || q75 == null) return null;
    const year = yearOf();
    const f = (d: number) => fmtDoy(year, d);
    const doy = dayOfYear(t);
    const stage = stageAt(hit.q, doy);
    const place = lngLat ? (name ?? 'this spot') : 'Chicago';
    const busy = `busiest ${f(q25)} to ${f(q75)}`;
    const sentence = {
      'not yet': `On ${f(doy)}, the forecast says it is too early near ${place}. First moths about ${f(q05)}, ${busy}.`,
      starting: `On ${f(doy)}, the forecast says moths are just starting near ${place}. Busiest days should be ${f(q25)} to ${f(q75)}.`,
      peak: `On ${f(doy)}, the forecast says it is peak time near ${place}. Busiest ${f(q25)} to ${f(q75)}.`,
      'winding down': `On ${f(doy)}, the forecast says the season is winding down near ${place}. Busiest days were ${f(q25)} to ${f(q75)}.`,
      over: `By ${f(doy)}, the forecast says the first wave is over near ${place}. It started about ${f(q05)}.`,
    }[stage];
    const end = q95 ?? 273;
    const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
    return {
      title: !lngLat || example ? `Example: the ${place} area` : name ? `Near ${name}` : 'The spot you picked',
      sentence,
      // The slider's range, 1 Apr - 30 Sep, with a label on the first of each month (real days of year, so leap years line up).
      span: [dayOfYear(Date.UTC(year, 3, 1)), dayOfYear(Date.UTC(year, 8, 30))],
      months: [3, 4, 5, 6, 7, 8].map((m) => {
        const ms = Date.UTC(year, m, 1);
        return { doy: dayOfYear(ms), label: new Date(ms).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) };
      }),
      segments: [
        { from: 0, to: q05, label: 'not yet', color: css(STAGE_COLOR['not yet']) },
        { from: q05, to: q25, label: 'starting', color: css(STAGE_COLOR.starting) },
        { from: q25, to: q75, label: 'peak', color: css(STAGE_COLOR.peak) },
        { from: q75, to: end, label: 'winding down', color: css(STAGE_COLOR['winding down']) },
        { from: end, to: 367, label: STAGE_LABEL.over, color: css(STAGE_COLOR.over) },
      ],
      ticks: sightingsFor(mode)
        // Sightings are counted on the res-4 hexagon, even when a finer one is on screen.
        .filter((s) => s.cell === hit.parent && !(s.flags & (SECOND_BROOD | APPROXIMATE)))
        .map(day),
      today: doy,
    };
  };

  /** Live hex card: kept short (the map comes first). Every number in the file may be missing for a cell. */
  const liveProbe = (cell: string, q: (number | null)[], seen: boolean, doy: number): ProbeCard => {
    const L = live!;
    const y = L.season;
    const i = cellIndex.get(cell);
    const f = (d: number) => fmtDoy(y, d);
    const asOf = f(dayOfYear(L.asOf));
    const stage = stageAt(q, doy);
    // Same shape as a replay card: the stage first, one answer line, the detail behind "More".
    const title = `Luna moth: ${STAGE_LABEL[stage]} on ${f(doy)}${L.asOf < doyToMs(y, doy) ? ' (forecast)' : ''}`;
    const lines: string[] = [];
    const more: string[] = [];
    const lo = i === undefined ? null : L.lo[i]?.[2];
    const hi = i === undefined ? null : L.hi[i]?.[2];
    if (lo != null && hi != null) lines.push(lo === hi ? `Peak likely ${f(lo)}.` : `Peak likely ${f(lo)} to ${f(hi)}.`);
    else if (q[2] != null) lines.push(`Peak likely about ${f(q[2])}.`);
    if (!seen) lines.push('No lunas ever seen near here to check this against.');
    const out = i === undefined ? null : L.outNow[i];
    // Zeros are the empty state (early spring, or nothing banked yet): say nothing rather than "0% out".
    if (out != null && out > 0) more.push(`${Math.round(out)}% of the first wave out by ${asOf}.`);
    const dd = i === undefined ? null : L.dd[i];
    if (dd != null && dd > 0 && L.asOf >= Date.UTC(y, 2, 1)) more.push(`${Math.round(dd).toLocaleString()} degree-days banked since Mar 1.`);
    const n = shown.filter((s) => s.cell === cell).length;
    if (n) more.push(`${n} sighting${n > 1 ? 's' : ''} here this season.`);
    more.push(`${modeLabel(LIVE)}: real weather to ${asOf}, then forecast.`);
    return { title, swatch: css(STAGE_COLOR[stage]), lines, more };
  };

  return {
    id: 'luna-replay',
    title: 'Luna moth',
    words: { tagline: 'when luna moths fly', plural: 'moths', sightingsOf: 'luna moth', countedAs: 'first-wave moths', shareName: 'luna moths', mark },
    mode: () => mode,
    setMode(m) {
      mode = m;
      shown = sightingsFor(m);
    },
    res: () => shownRes,
    fineCurrent: () => shownRes > 4 && shownDays !== null && shownDays === fineDaysLoaded.get(`${shownRes}/${mode}`),
    cellAt: (lngLat) => lookup(lngLat)?.cell ?? null,

    newest: (t) => newest(dayOfYear(t)),
    busy: (t) => isBusy(forecast(), dayOfYear(t)),
    endNote: ['That was the first wave.', 'Press replay to watch it again'],

    points(t) {
      // Cached per day and season: the same array back means the dots haven't moved (the place names check that).
      const key = `${dayOfYear(t)}|${mode}`;
      if (lit.key !== key) {
        const doy = dayOfYear(t);
        const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
        lit = { key, pts: shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).map((s) => [s.lng, s.lat]) };
      }
      return lit.pts;
    },

    offSeason: (t) => (isAsleep(forecast(), dayOfYear(t)) ? (sleepNote ??= { title: 'Sleeping till spring', line: 'cocoons in the leaf litter', sketch: restingSketch('moth'), at: MIDWEST_MARGIN }) : null),

    summary(t) {
      const doy = dayOfYear(t);
      const n = stageCounts(forecast(), doy);
      const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
      const lit = shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).length;
      const parts = STAGES.filter((s) => n[s]).map((s) => `${STAGE_LABEL[s]} in ${n[s]}`);
      const asOf = isLive() ? ` Weather observed up to ${fmtDoy(yearOf(), dayOfYear(live!.asOf))}, forecast after.` : '';
      return `${fmtDoy(yearOf(), doy)}, ${modeLabel(mode)}.${asOf} Forecast across ${forecast().length} map hexagons: ${parts.join(', ')}. ` +
        `${lit} moth${lit === 1 ? '' : 's'} seen in the last ${GLOW_DAYS} days.`;
    },

    profile() {
      let p = profiles.get(mode);
      if (!p) {
        // Live: this season's median forecast (a cell with none counts as "not yet") and this season's sightings.
        p = seasonProfile(forecast().map((q) => q ?? []), shown, (s) => (mode === TYPICAL ? s.pdoy : s.doy), yearOf(), [
          ['1st wave', (s) => !(s.flags & SECOND_BROOD)],
          // Not forecast (the model covers the first wave only): washed in the 2nd-wave dots' colour.
          ['2nd wave (seen)', (s) => !!(s.flags & SECOND_BROOD), css(SECOND)],
        ]);
        profiles.set(mode, p);
      }
      return p;
    },

    render({ t, zoom, theme, wash, playing, frac = 0 }) {
      const doy = dayOfYear(t);
      // While playing, the dots get the in-between day and the hexes blend into their next colour (see motion.ts).
      const anim = animating(playing);
      const fade = hexFade(anim);
      const d = anim ? doy + frac : doy;
      const { res, days } = pickRes(resForZoom(zoom));
      shownDays = days;
      if (res === 4) releaseLater();
      else if (releaseTimer) releaseTimer = (clearTimeout(releaseTimer), 0); // back in: the 60 s starts again next time
      if (res !== shownRes) {
        shownRes = res;
        queueMicrotask(onData); // the card and its outline follow the new level
      }
      // Time reaches the dots only through the filter range (a GPU uniform), so scrubbing never re-uploads them.
      const filter = {
        getFilterValue: (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy),
        // Whole-day values: a dot is lit from its own day through GLOW_DAYS - 1 days later.
        filterRange: [d - GLOW_DAYS + 0.5, d + 0.5] as [number, number],
        filterSoftRange: [d - 0.5, d + 0.5] as [number, number],
        filterTransformSize: true,
        filterTransformColor: true,
        extensions: filterExt,
      };
      const fine = res > 4 ? shown5or6.get(res)! : null;
      // Each level gets its own layer ids. Reusing one id across levels let deck.gl keep the bigger level's
      // triangles after a zoom out: the old small hexagons stayed drawn in the gaps along the shores.
      const hexLayers = fine && days
        ? [
            new H3HexagonLayer<FineCell>({
              id: `luna-forecast-r${res}${fade.id}`,
              data: fine.data,
              getHexagon: (c) => c.id,
              getFillColor: (c) => STAGE_COLOR[stageAtBytes(days, c.i, doy)],
              getLineColor: theme.hexEdge,
              stroked: true,
              filled: true,
              extruded: false,
              // Res 5 is drawn as true polygons on desktop (a zoomed-in view can still span a few states). Res 6
              // (~27,000 cells, only shown when zoomed in close), and res 5 on phones, use one instanced hexagon
              // shape: much lighter on memory (see COARSE).
              highPrecision: res === 5 && !COARSE ? true : 'auto',
              lineWidthMinPixels: 0.4,
              pickable: true,
              autoHighlight: true,
              highlightColor: palette.hoverTint,
              updateTriggers: { getFillColor: [doy, mode, res] },
              transitions: fade.transitions,
            }),
            new H3HexagonLayer<FineCell, FillStyleExtensionProps<FineCell>>({
              id: `luna-unseen-r${res}`,
              data: fine.unseen,
              getHexagon: (c) => c.id,
              getFillColor: STRIPES,
              stroked: false,
              filled: true,
              extruded: false,
              highPrecision: true,
              pickable: false,
              extensions: [new FillStyleExtension({ pattern: true })],
              fillPatternAtlas: stripes(),
              fillPatternMapping: STRIPE_MAPPING,
              fillPatternMask: true,
              getFillPattern: () => 'stripes',
              fillPatternSizeUnits: 'pixels',
            }),
          ]
        : null;
      return [
        ...(hexLayers ?? [
        new H3HexagonLayer<(typeof cells)[number]>({
          id: `luna-forecast-r4${fade.id}`,
          data: cells,
          getHexagon: (c) => c.id,
          getFillColor: wash === undefined ? (c) => cellColor(c.i, doy) : (c) => washed(c.i, cellColor(c.i, doy), wash),
          getLineColor: wash === undefined ? theme.hexEdge : (c) => washed(c.i, theme.hexEdge, wash),
          stroked: true,
          filled: true,
          extruded: false,
          highPrecision: true,
          lineWidthMinPixels: 0.6,
          pickable: true,
          autoHighlight: true,
          highlightColor: palette.hoverTint,
          updateTriggers: { getFillColor: [doy, mode, wash], getLineColor: [wash] },
          transitions: fade.transitions,
        }),
        new H3HexagonLayer<(typeof cells)[number], FillStyleExtensionProps<(typeof cells)[number]>>({
          id: 'luna-unseen-r4',
          opacity: wash === undefined ? 1 : Math.min(1, wash / 900),
          data: unseen,
          getHexagon: (c) => c.id,
          getFillColor: STRIPES,
          stroked: false,
          filled: true,
          extruded: false,
          highPrecision: true,
          pickable: false,
          extensions: [new FillStyleExtension({ pattern: true })],
          fillPatternAtlas: stripes(),
          fillPatternMapping: STRIPE_MAPPING,
          fillPatternMask: true,
          getFillPattern: () => 'stripes',
          fillPatternSizeUnits: 'pixels',
        }),
        ]),
        new ScatterplotLayer<Sighting>({
          id: 'luna-glow',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: palette.dotShadow,
          radiusUnits: 'pixels',
          getRadius: 9,
          pickable: true, // the soft shadow is the touch target: 18 px beats an 8 px dot on a phone
          updateTriggers: { getFilterValue: [mode] },
          ...filter,
        }),
        // A paper ring under each dot, so it stands off the dark peak hexes as clearly as the ink rim does on pale ones.
        new ScatterplotLayer<Sighting>({
          id: 'luna-halo',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: palette.dotHalo,
          radiusUnits: 'pixels',
          getRadius: 6.5,
          pickable: false,
          updateTriggers: { getFilterValue: [mode] },
          ...filter,
        }),
        new ScatterplotLayer<Sighting>({
          id: 'luna-dots',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: dotColor,
          // An ink rim keeps the pale dots readable on the pale hexes and the paper.
          stroked: true,
          getLineColor: palette.dotRim,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          radiusUnits: 'pixels',
          getRadius: (s) => (s.flags & APPROXIMATE ? 3 : 4),
          pickable: false,
          updateTriggers: { getFillColor: [mode], getFilterValue: [mode] },
          ...filter,
        }),
        ...rings(anim, doy, (from, to) => shown.filter((s) => {
          const day = mode === TYPICAL ? s.pdoy : s.doy;
          return day >= from && day <= to;
        })),
      ];
    },

    probe(lngLat, t, picked): ProbeCard | null {
      const year = yearOf();
      const doy = dayOfYear(t);
      if (picked && (picked.layerId === 'luna-glow' || picked.layerId === 'luna-dots')) {
        const s = picked.object as Sighting;
        const lines = [
          s.flags & SECOND_BROOD
            ? 'Seen after late June or early July here, so counted as the second wave. The map does not forecast this wave.'
            : 'First wave of the year (the one the map forecasts).',
        ];
        if (s.flags & APPROXIMATE) lines.push('Location is approximate, so the dot is small and dark.');
        if (s.flags & UNCONFIRMED) lines.push('Not yet confirmed by other iNaturalist users, so drawn a little fainter.');
        return {
          title: `Luna moth seen ${fmtDoy(s.year, s.doy)}, ${s.year}`,
          lines,
          link: { href: `https://www.inaturalist.org/observations/${s.id}`, label: 'See the photo on iNaturalist' },
        };
      }
      const at = lookup(lngLat);
      if (!at) return null;
      if (isLive()) return liveProbe(at.cell, at.q, at.seen, doy);
      const fine = shownRes > 4;
      const q = at.q;
      const [q05, q25, q50, q75] = q;
      const stage = stageAt(q, doy);
      // One answer up front; the detail waits behind "More" (pinned cards only) so the card stays small over the map.
      const label = STAGE_LABEL[stage];
      const title = `Luna moth: ${label} on ${fmtDoy(year, doy)}`; // the species, as both layers can be on at once
      const lines: string[] = [];
      const more: string[] = [];
      // The window comes from past misses for whole strips of the map, each forecast from that year's real weather.
      // So it only applies to a replayed year: "all years" has no one year's weather, and its spread is much wider.
      const pk = data.interval?.peak;
      const likely = !!(pk && q50 != null && mode !== TYPICAL);
      if (likely) lines.push(`Busiest day likely ${fmtDoy(year, q50 + pk[0])} to ${fmtDoy(year, q50 + pk[1])}.`);
      // In date order: the first moths, then the busiest stretch.
      else if (q25 != null && q75 != null)
        lines.push(`${q05 != null ? `First moths about ${fmtDoy(year, q05)}. ` : ''}Busiest stretch ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}.`);
      if (!at.seen) lines.push('No lunas ever seen near here to check this against.');
      if (likely && q05 != null && q25 != null && q75 != null)
        more.push(`First moths about ${fmtDoy(year, q05)}. Busiest stretch ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}.`);
      const band = bandOf(lngLat[1]);
      const sc = mode === TYPICAL ? null : data.scores.find((r) => r.band === band.label && r.year === year);
      if (sc) {
        const off = sc.heat_peak - sc.obs_peak;
        more.push(
          `How the forecast did in this strip of the map (${band.label}°N): moths peaked ${fmtDoy(year, sc.obs_peak)}. Forecast ${fmtDoy(year, sc.heat_peak)}` +
            (off ? `, ${Math.abs(off)} day${Math.abs(off) > 1 ? 's' : ''} ${off < 0 ? 'early' : 'late'}` : ', right on') +
            `. Usual date ${fmtDoy(year, sc.cal_peak)}.`,
        );
      }
      // Sightings are counted on the res-4 hexagon: a small one would almost always have none.
      const here = sightingsFor(mode).filter((s) => s.cell === at.parent);
      const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
      const firstDays = here.filter((s) => !(s.flags & SECOND_BROOD)).map(day).sort((a, b) => a - b);
      const median = firstDays.length % 2 ? firstDays[(firstDays.length - 1) / 2]! : (firstDays[firstDays.length / 2 - 1]! + firstDays[firstDays.length / 2]!) / 2;
      const where = fine ? 'the wider area (one zoomed-out hexagon)' : 'this hexagon';
      more.push(
        here.length
          ? `${here.length} sighting${here.length > 1 ? 's' : ''} in ${where}${mode === TYPICAL ? ' (all years)' : ''}` +
              // A middle date of two or three sightings says little, so it waits for five.
              (firstDays.length >= 5 ? `. Middle date of the first wave: ${fmtDoy(year, median)}.` : '.')
          : `No sightings in ${where}${mode === TYPICAL ? '' : ' this year'}.`,
      );
      if (fine) more.push('Small hexagon: forecast from its own local temperatures. Accuracy is only checked for whole strips of the map.');
      return { title, swatch: css(STAGE_COLOR[stage]), lines, more };
    },

    caveats(): CaveatCard {
      const yr = mode === TYPICAL || mode === LIVE ? null : scoreSummary(Number(mode));
      const c = data.counts;
      const bullets = [
        isLive()
          ? 'This year\u2019s map is a real forecast: it has to guess the weather ahead, so it is less sure than a replayed year, which knows every day\u2019s temperature.'
          : 'This is a look back. It uses the temperatures that actually happened. A forecast made during spring would have to guess the weather ahead, so it would be less accurate.',
        isLive()
          ? `The dots are this season\u2019s photos of adult luna moths posted to iNaturalist (${shown.length ? `${shown.length.toLocaleString()} so far` : 'none yet'}). Each stays lit for ${GLOW_DAYS} days, about how long an adult lives.`
          : `The dots are ${c.sightings?.toLocaleString() ?? '?'} photos of adult luna moths that people posted to iNaturalist, ${data.years[0]}-${data.years[data.years.length - 1]}. Each dot stays lit for ${GLOW_DAYS} days, about how long an adult lives.`,
        'Amber dots are late moths counted as the second wave. Some may be late first wave moths from a cold year.',
        'Gray dots mean the photo\u2019s location was blurred or rough, so the dot may sit off its true spot.',
        'Striped hexagons have no luna sightings nearby, ever. There is nothing to check the forecast against there.',
        ...(fineLevels.length && !isLive()
          ? [
              `Zoom in and the hexagons get smaller, down to about ${fineLevels.includes(6) ? 6 : 17} km across. Each small one uses the temperatures at its own centre, so cool lake shores, warm cities and river valleys show up.`,
              'Small hexagons use the same model, but nobody has checked it at that scale. Its accuracy was only measured for whole strips of the map. So a small hexagon\u2019s date is no surer than a big one\u2019s.',
              'A small hexagon is striped when the big hexagon it sits in is. Its card counts the sightings in that big hexagon.',
            ]
          : []),
        'Sightings show where people look as much as where moths are. Towns and porch lights get counted too often. An empty spot does not mean no moths.',
        'The last version ran about 6 days early in the far south and 4 days late in the north. This one counts the week each moth flies and when people go looking, which fixes most of that. Its peak dates now run 0 to 3 days late in every strip of the map.',
        isLive()
          ? `This year, a hexagon\u2019s "peak likely" window spans the middle 8 in 10 of the weather runs, widened by how far the model missed on past years.` +
            (seasonCheck() ? ` ${seasonCheck()}` : '') +
            ' One spot can miss by more.'
          : `For a single year, a hexagon\u2019s card gives a "peak here likely" window around its forecast. The margin comes from past misses for whole strips of the map: 8 in 10 strip peaks were within ${-(data.interval?.peak[0] ?? 6)} days early to ${data.interval?.peak[1] ?? 4} days late of the forecast.` +
            (data.interval?.checked
              ? ` Sized without the year being checked, it caught ${data.interval.checked.peak[0]} of ${data.interval.checked.peak[1]}.`
              : '') +
            ' One spot can miss by more. With all years combined there is no one year\u2019s weather, so no window is shown.',
        ...(holdoutPass
          ? [
              `When it learned only from Illinois, Indiana and Ohio, it guessed Wisconsin and Minnesota about ${Math.round(hoHeat!)} days off. Their own usual dates were about ${Math.round(hoCal!)} days off. That gap is small enough that it could be chance. We also chose this version after seeing that test, so it is a second look, not proof. The version we picked first failed it.`,
            ]
          : Number.isFinite(hoHeat) && Number.isFinite(hoCal)
            ? [
                `When it learned only from Illinois, Indiana and Ohio, it guessed Wisconsin and Minnesota worse than their own usual dates (${hoHeat!.toFixed(1)} days off on average, against ${hoCal!.toFixed(1)} for their own usual dates, over just 8 strip-years). So it is not ready for places it has never seen.`,
              ]
            : []),
        'Only openly licensed photos are drawn, about 2 in 3. The forecast learned from all records that other iNaturalist users had confirmed. Moths raised in captivity were left out.',
        'This version is about as accurate as the last one, with much less south/north lean. Both beat each area\u2019s usual date.',
      ];
      if (yr && yr.n)
        bullets.push(
          `Peak dates in ${mode}, south to north (seen, forecast, usual date): ` +
            yr.rows
              .map((r) => `${r.band}°N ${fmtDoy(r.year, r.obs_peak)}, ${fmtDoy(r.year, r.heat_peak)}, ${fmtDoy(r.year, r.cal_peak)}`)
              .join('. ') +
            '.',
        );
      else if (yr) bullets.push(`${mode} had too few sightings to check. Each strip of the map needs at least 20.`);
      return { title: 'Luna moth replay: what you are looking at', severity: 'normal', bullets };
    },

    explainer(): Explainer {
      const sc = mode === TYPICAL || mode === LIVE ? scoreSummary() : scoreSummary(Number(mode));
      const all = sc.n ? sc : scoreSummary();
      return {
        name: 'Luna moth',
        sci: data.species.sci,
        creature: 'moth',
        accent: mothInk,
        hook: 'Luna moths come out in two waves each summer. This map predicts when the first wave comes out across seven Midwest states, based on how warm the spring has been. Photos people posted of real moths show how well it matches.',
        steps: [
          { title: 'Winter', text: 'All winter the moth sleeps as a cocoon in fallen leaves.' },
          { title: 'Warmth wakes it', text: 'From March 1, every day warmer than 50\u00a0°F (10\u00a0°C) adds a little warmth. Hotter days add more.' },
          { title: 'Warm spring, early moths', text: 'Once it has had enough warmth, out it comes. A warm spring gets there sooner.' },
        ],
        spotIntro: `${matchMedia('(hover: hover) and (pointer: fine)').matches ? 'Click' : 'Tap'} a hexagon on the map to see its season here.`,
        spot: (lngLat, t, name, example) => spotStory(lngLat, t, name, example),
        score: {
          title: 'How sure is it?',
          // Plain sentences, each standing on its own.
          points: [
            !sc.n
              ? `${mode} had too few sightings to check, so these numbers are for all years together.`
              : `It was checked against real sightings: the dates of the first moths and the peak, on ${mode === TYPICAL || mode === LIVE ? 'years' : mode} it never learned from.` +
                (mode !== TYPICAL && sc.n < 3 ? ` Only ${sc.n} part${sc.n > 1 ? 's' : ''} of the map had enough sightings.` : ''),
            ...(isLive()
              ? ['Those checks knew the real weather. This year\u2019s forecast has to guess the weeks ahead, so expect bigger misses early in spring.']
              : []),
            ...(isLive() ? (seasonCheck() ? [`${seasonCheck()} One season is a rough check.`] : []) : [windowCheck(data)].filter((w): w is string => !!w)),
            holdoutPass
              ? 'It did well on two states it never learned from, Wisconsin and Minnesota. But this version was picked after seeing that test.'
              : 'Its weak spot: taught without Wisconsin and Minnesota, it did worse there than a guess from past years.',
            'The real test is the 2026 season, once its weather data is out in mid-2027.',
          ],
          bars: [
            { label: 'This forecast', days: all.heat, best: all.heat < all.calendar },
            { label: 'Usual date', days: all.calendar, best: all.calendar < all.heat },
          ],
        },
        finePrintLabel: 'Limits and fine print',
        notice: isLive() ? liveNotice(live!) : undefined,
      };
    },

    legend(): LegendSpec {
      return {
        title: 'Forecast: when moths come out',
        items: [
          ...STAGES.map((s) => ({
            color: onPaper(STAGE_COLOR[s]),
            label: STAGE_LABEL[s],
            shape: 'hex' as const,
          })),
          { color: css(STAGE_COLOR.peak), label: 'no sightings nearby', shape: 'striped' },
          { color: css(MOON), label: 'seen, last 10 days', shape: 'dot' },
          { color: css(SECOND), label: 'seen, 2nd wave', shape: 'dot' },
          { color: css(GREY), label: 'rough location', shape: 'dot' },
        ],
      };
    },

    credits() {
      const weather = isLive()
        ? [
            { text: 'Observed weather this season: PRISM Climate Group, Oregon State University, via RCC-ACIS.', href: 'https://www.rcc-acis.org/' },
            { text: 'Weather forecast: Open-Meteo.com (CC BY 4.0).', href: 'https://open-meteo.com/' },
          ]
        : [];
      return [
        ...weather,
        { text: 'Sightings: iNaturalist observers (CC0, CC BY and CC BY-NC records only). Photos are linked, never copied.', href: `https://www.inaturalist.org/taxa/${data.species.inat_taxon}` },
        { text: 'Temperatures: Daymet v4 daily 1 km, Thornton et al., ORNL DAAC.', href: 'https://daymet.ornl.gov/' },
        { text: 'State outlines, town names and populations: US Census Bureau (outlines via us-atlas). Public domain.', href: 'https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html' },
        { text: 'Lakes, rivers, highways and national parks: Natural Earth. Public domain.', href: 'https://www.naturalearthdata.com/' },
        { text: 'National forests: US Forest Service. Public domain.', href: 'https://data.fs.usda.gov/geodata/edw/datasets.php' },
        { text: 'Woods: USGS National Land Cover Database 2021. Public domain.', href: 'https://www.mrlc.gov/' },
      ];
    },
  };
}

