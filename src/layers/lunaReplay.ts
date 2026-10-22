import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension, FillStyleExtension, type FillStyleExtensionProps } from '@deck.gl/extensions';
import { latLngToCell } from 'h3-js';
import { GRID_RES } from '../core/grid';
import { dayOfYear, TimeAxis, type TimeSpec } from '../core/timeAxis';
import type { CaveatCard, Explainer, HatchLayer, LegendSpec, ProbeCard, SpotStory } from '../core/layer';
import {
  APPROXIMATE,
  bandOf,
  data,
  doyToMs,
  SECOND_BROOD,
  sightingsFor,
  TYPICAL,
  type Mode,
  type Sighting,
} from './lunaData';
import { fineDays, fineLevel, fineManifest, parentOf, type FineLevel } from './fineData';

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
/** Year used to put dates on the "typical year" axis. Any non-leap year works. */
const TYPICAL_AXIS_YEAR = 2025;

export const STAGES = ['not yet', 'starting', 'peak', 'winding down', 'over'] as const;
export type Stage = (typeof STAGES)[number];

/** Where a cell's forecast season stands on day `doy`. q = days the share of moths out reaches 5/25/50/75/95%. */
export function stageAt(q: readonly (number | null)[] | undefined, doy: number): Stage {
  const [q05, q25, , q75, q95] = q ?? [];
  if (q05 == null || doy < q05) return 'not yet';
  if (q25 == null || doy < q25) return 'starting';
  if (q75 == null || doy < q75) return 'peak';
  if (q95 == null || doy < q95) return 'winding down';
  return 'over';
}

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
// Forecast hexes live in blue (season coming) -> bright teal (peak) -> dusky violet (season gone), so the
// north/south ends of the wave never share a colour. The moths themselves are the only moonlight green on the map.
// Lightness climbs to the peak and falls after it (starting is brighter than winding down, over is darkest), and
// "not yet" is near-empty, so the stages read in order even for colour-blind eyes.
const STAGE_COLOR: Record<Stage, RGBA> = {
  'not yet': [26, 34, 56, 90],
  starting: [70, 150, 215, 215],
  peak: [72, 190, 202, 230],
  'winding down': [118, 92, 170, 210],
  over: [80, 68, 110, 170],
};
// Hexes with no sightings nearby keep their stage colour (fading it made it look like another stage) under dark stripes.
const STRIPES: RGBA = [11, 15, 23, 150];
// One object for every render, so deck.gl doesn't rebuild the pattern each playback frame.
const STRIPE_MAPPING = { stripes: { x: 0, y: 0, width: 16, height: 16 } };
let stripeAtlas: HTMLCanvasElement | null = null;
const stripes = () => {
  if (stripeAtlas) return stripeAtlas;
  const c = Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  g.lineWidth = 3;
  // Three strokes so the diagonal tiles without seams.
  for (const o of [-16, 0, 16]) {
    g.beginPath();
    g.moveTo(o, 16);
    g.lineTo(o + 16, 0);
    g.stroke();
  }
  return (stripeAtlas = c);
};
const MOON: RGBA = [196, 255, 206, 255];
const SECOND: RGBA = [255, 196, 120, 255];
const GREY: RGBA = [168, 176, 190, 255];
const css = (c: RGBA) => `rgb(${c[0]},${c[1]},${c[2]})`;

const dotColor = (s: Sighting): RGBA => (s.flags & APPROXIMATE ? GREY : s.flags & SECOND_BROOD ? SECOND : MOON);

const fmtDoy = (year: number, doy: number) =>
  new Date(doyToMs(year, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const modeLabel = (mode: Mode) =>
  mode === TYPICAL ? `all years, ${data.years[0]}-${data.years[data.years.length - 1]}` : mode;

/** Scrub 1 Apr - 30 Sep, starting on `month` (0-based) / `day`, so switching years keeps the calendar date. */
export function replayTimeSpec(mode: Mode, month = 5, day = 10): TimeSpec {
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
  const cellIndex = new Map(data.cells.map((c, i) => [c, i] as const));
  const cells = data.cells.map((id, i) => ({ id, i, seen: data.seen[i] === 1 }));
  const yearOf = () => (mode === TYPICAL ? TYPICAL_AXIS_YEAR : Number(mode));
  const forecast = () => data.forecast[mode] ?? data.forecast[TYPICAL]!;
  const filterExt = [new DataFilterExtension({ filterSize: 1 })];

  const unseen = cells.filter((c) => !c.seen);
  const cellColor = (i: number, doy: number): RGBA => STAGE_COLOR[stageAt(forecast()[i], doy)];

  // ---- finer levels: the level the zoom asks for, what has loaded, and what is on screen
  let wantRes = 4;
  let shownRes = 4;
  const shown5or6 = new Map<number, Shown>();
  const fineDaysLoaded = new Map<string, Uint8Array>();
  const loading = new Set<string>();
  let fineLevels: number[] = [];
  void fineManifest().then((m) => {
    fineLevels = m ? Object.keys(m.levels).map(Number) : [];
    if (fineLevels.length && wantRes > 4) onData();
  });
  const resForZoom = (zoom: number) => {
    let r = wantRes;
    while (r < 6 && zoom >= FINE_ZOOM[r + 1]!) r++;
    while (r > 4 && zoom < FINE_ZOOM[r]! - HYSTERESIS) r--;
    return (wantRes = r);
  };
  const load = (res: number) => {
    const key = `${res}/${mode}`;
    if (loading.has(key)) return;
    loading.add(key);
    void Promise.all([fineLevel(res), fineDays(res, mode)]).then(([level, days]) => {
      if (!level || !days || days.length !== level.cells.length * 5) return; // missing or stale file: stay coarser
      if (!shown5or6.has(res)) {
        const fc = level.cells.map((id, i) => ({ id, i, seen: level.seen[i] === 1 }));
        shown5or6.set(res, { level, data: fc, unseen: fc.filter((c) => !c.seen) });
      }
      fineDaysLoaded.set(key, days);
      if (wantRes >= res) onData();
    });
  };
  /** Finest level at or below the wanted one whose cells and current-season days are in memory. */
  const pickRes = (want: number) => {
    for (let r = want; r > 4; r--) {
      if (!fineLevels.includes(r)) continue;
      if (shown5or6.has(r) && fineDaysLoaded.has(`${r}/${mode}`)) return r;
      load(r);
    }
    return 4;
  };
  /** Forecast quantiles, "seen" and the cell id at lngLat on the level on screen. */
  const lookup = (lngLat: [number, number]) => {
    if (shownRes > 4) {
      const s = shown5or6.get(shownRes)!;
      const days = fineDaysLoaded.get(`${shownRes}/${mode}`);
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

  // The default spot until a hex is tapped: Chicago's western suburbs (the city's own hex centre is in the lake).
  const HOME: [number, number] = [-88.0, 41.9];
  const spotStory = (lngLat: [number, number] | null, t: number): SpotStory | null => {
    const at = lngLat ?? HOME;
    const hit = lookup(at);
    if (!hit) return null;
    const [q05, q25, , q75, q95] = hit.q;
    if (q05 == null || q25 == null || q75 == null) return null;
    const year = yearOf();
    const f = (d: number) => fmtDoy(year, d);
    const doy = dayOfYear(t);
    const stage = stageAt(hit.q, doy);
    const place = lngLat ? 'this spot' : 'Chicago';
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
      title: lngLat ? 'The spot you picked' : 'Example: the Chicago area',
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
        { from: end, to: 367, label: 'over', color: css(STAGE_COLOR.over) },
      ],
      ticks: sightingsFor(mode)
        // Sightings are counted on the res-4 hexagon, even when a finer one is on screen.
        .filter((s) => s.cell === hit.parent && !(s.flags & (SECOND_BROOD | APPROXIMATE)))
        .map(day),
      today: doy,
    };
  };

  return {
    id: 'luna-replay',
    title: 'Luna moth',
    mode: () => mode,
    setMode(m) {
      mode = m;
      shown = sightingsFor(m);
    },
    res: () => shownRes,
    cellAt: (lngLat) => lookup(lngLat)?.cell ?? null,

    summary(t) {
      const doy = dayOfYear(t);
      const n: Record<Stage, number> = { 'not yet': 0, starting: 0, peak: 0, 'winding down': 0, over: 0 };
      for (const q of forecast()) n[stageAt(q, doy)]++;
      const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
      const lit = shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).length;
      const parts = STAGES.filter((s) => n[s]).map((s) => `${s} in ${n[s]}`);
      return `${fmtDoy(yearOf(), doy)}, ${modeLabel(mode)}. Forecast across ${forecast().length} map hexagons: ${parts.join(', ')}. ` +
        `${lit} moth${lit === 1 ? '' : 's'} seen in the last ${GLOW_DAYS} days.`;
    },

    render({ t, zoom, theme }) {
      const doy = dayOfYear(t);
      const res = pickRes(resForZoom(zoom));
      if (res !== shownRes) {
        shownRes = res;
        queueMicrotask(onData); // the card and its outline follow the new level
      }
      // Time reaches the dots only through the filter range (a GPU uniform), so scrubbing never re-uploads them.
      const filter = {
        getFilterValue: (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy),
        // Whole-day values: a dot is lit from its own day through GLOW_DAYS - 1 days later.
        filterRange: [doy - GLOW_DAYS + 0.5, doy + 0.5] as [number, number],
        filterSoftRange: [doy - 0.5, doy + 0.5] as [number, number],
        filterTransformSize: true,
        filterTransformColor: true,
        extensions: filterExt,
      };
      const fine = res > 4 ? shown5or6.get(res)! : null;
      const days = fine ? fineDaysLoaded.get(`${res}/${mode}`)! : null;
      const hexLayers = fine && days
        ? [
            new H3HexagonLayer<FineCell>({
              id: 'luna-forecast',
              data: fine.data,
              getHexagon: (c) => c.id,
              getFillColor: (c) => STAGE_COLOR[stageAtBytes(days, c.i, doy)],
              getLineColor: theme.hexEdge,
              stroked: true,
              filled: true,
              extruded: false,
              // Res 5 is drawn as true polygons (a zoomed-in view can still span a few states). Res 6 (~27,000
              // cells, only shown when zoomed in close) uses one instanced hexagon shape: much lighter on phones.
              highPrecision: res === 5 ? true : 'auto',
              lineWidthMinPixels: 0.4,
              pickable: true,
              autoHighlight: true,
              highlightColor: [255, 255, 255, 50],
              updateTriggers: { getFillColor: [doy, mode, res] },
            }),
            new H3HexagonLayer<FineCell, FillStyleExtensionProps<FineCell>>({
              id: 'luna-unseen',
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
              getFillPatternScale: 0.75,
            }),
          ]
        : null;
      return [
        ...(hexLayers ?? [
        new H3HexagonLayer<(typeof cells)[number]>({
          id: 'luna-forecast',
          data: cells,
          getHexagon: (c) => c.id,
          getFillColor: (c) => cellColor(c.i, doy),
          getLineColor: theme.hexEdge,
          stroked: true,
          filled: true,
          extruded: false,
          highPrecision: true,
          lineWidthMinPixels: 0.6,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 50],
          updateTriggers: { getFillColor: [doy, mode] },
        }),
        new H3HexagonLayer<(typeof cells)[number], FillStyleExtensionProps<(typeof cells)[number]>>({
          id: 'luna-unseen',
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
          getFillPatternScale: 0.75,
        }),
        ]),
        new ScatterplotLayer<Sighting>({
          id: 'luna-glow',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: (s) => {
            const c = dotColor(s);
            return [c[0], c[1], c[2], 60];
          },
          radiusUnits: 'pixels',
          getRadius: 9,
          pickable: true, // the halo is the touch target: 18 px beats a 5 px dot on a phone
          updateTriggers: { getFillColor: [mode], getFilterValue: [mode] },
          ...filter,
        }),
        new ScatterplotLayer<Sighting>({
          id: 'luna-dots',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: dotColor,
          // A dark rim keeps the pale dots readable on the bright peak hexes.
          stroked: true,
          getLineColor: [11, 15, 23, 230],
          lineWidthUnits: 'pixels',
          getLineWidth: 1,
          radiusUnits: 'pixels',
          getRadius: 3,
          pickable: false,
          updateTriggers: { getFillColor: [mode], getFilterValue: [mode] },
          ...filter,
        }),
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
        if (s.flags & APPROXIMATE) lines.push('Location is approximate, so the dot is gray.');
        return {
          title: `Luna moth seen ${fmtDoy(s.year, s.doy)}, ${s.year}`,
          lines,
          link: { href: `https://www.inaturalist.org/observations/${s.id}`, label: 'See the photo on iNaturalist' },
        };
      }
      const at = lookup(lngLat);
      if (!at) return null;
      const fine = shownRes > 4;
      const q = at.q;
      const [q05, q25, q50, q75] = q;
      const stage = stageAt(q, doy);
      const lines = [`Forecast for ${fmtDoy(year, doy)}: ${stage}.`];
      if (q05 != null && q50 != null && q25 != null && q75 != null)
        lines.push(`First moths about ${fmtDoy(year, q05)}. Busiest ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}.`);
      const band = bandOf(lngLat[1]);
      const sc =
        mode === TYPICAL
          ? null
          : data.scores.find((r) => r.band === band.label && r.year === year);
      if (sc)
        lines.push(
          `Peak this year in this strip of the map (${band.label}°N): seen ${fmtDoy(year, sc.obs_peak)}, forecast ${fmtDoy(year, sc.heat_peak)}, usual date ${fmtDoy(year, sc.cal_peak)}.`,
        );
      // Sightings are counted on the res-4 hexagon: a small one would almost always have none.
      const here = sightingsFor(mode).filter((s) => s.cell === at.parent);
      const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
      const firstDays = here.filter((s) => !(s.flags & SECOND_BROOD)).map(day).sort((a, b) => a - b);
      const median = firstDays.length % 2 ? firstDays[(firstDays.length - 1) / 2]! : (firstDays[firstDays.length / 2 - 1]! + firstDays[firstDays.length / 2]!) / 2;
      const where = fine ? 'the wider area (one zoomed-out hexagon)' : 'this hexagon';
      lines.push(
        here.length
          ? `${here.length} sighting${here.length > 1 ? 's' : ''} in ${where}${mode === TYPICAL ? ' (all years)' : ''}` +
              (firstDays.length ? `. Middle date of the first wave: ${fmtDoy(year, median)}.` : '.')
          : `No sightings in ${where}${mode === TYPICAL ? '' : ' this year'}.`,
      );
      // The window comes from past misses for whole strips of the map, each forecast from that year's real weather.
      // So it only applies to a replayed year: "all years" has no one year's weather, and its spread is much wider.
      // Last, so the short hover card (first lines only) and phone layouts keep their size; the pinned card shows it.
      const pk = data.interval?.peak;
      if (pk && q50 != null && mode !== TYPICAL)
        lines.push(`Peak here likely ${fmtDoy(year, q50 + pk[0])} to ${fmtDoy(year, q50 + pk[1])}.`);
      if (!at.seen) lines.push('No lunas ever seen near here, so there is nothing to check this forecast against. Shown striped.');
      if (fine) lines.push('Small hexagon: forecast from its own local temperatures. Accuracy is only checked for whole strips of the map.');
      return { title: `Luna moth, ${modeLabel(mode)}`, lines };
    },

    caveats(): CaveatCard {
      const yr = mode === TYPICAL ? null : scoreSummary(Number(mode));
      const c = data.counts;
      const bullets = [
        'This is a look back. It uses the temperatures that actually happened. A forecast made during spring would have to guess the weather ahead, so it would be less accurate.',
        `The dots are ${c.sightings?.toLocaleString() ?? '?'} photos of adult luna moths that people posted to iNaturalist, ${data.years[0]}-${data.years[data.years.length - 1]}. Each dot stays lit for ${GLOW_DAYS} days, about how long an adult lives.`,
        'Amber dots are late moths counted as the second wave. Some may be late first wave moths from a cold year.',
        'Gray dots mean the photo\u2019s location was blurred or rough, so the dot may sit off its true spot.',
        'Striped hexagons have no luna sightings nearby, ever. There is nothing to check the forecast against there.',
        ...(fineLevels.length
          ? [
              `Zoom in and the hexagons get smaller, down to about ${fineLevels.includes(6) ? 6 : 17} km across. Each small one uses the temperatures at its own centre, so cool lake shores, warm cities and river valleys show up.`,
              'Small hexagons use the same model, but nobody has checked it at that scale. Its accuracy was only measured for whole strips of the map. So a small hexagon\u2019s date is no surer than a big one\u2019s.',
              'A small hexagon is striped when the big hexagon it sits in is. Its card counts the sightings in that big hexagon.',
            ]
          : []),
        'Sightings show where people look as much as where moths are. Towns and porch lights get counted too often. An empty spot does not mean no moths.',
        'The first version ran about 6 days early in the far south and 4 days late in the north. This one counts the week each moth flies and when people go looking, which fixes most of that. Its peak dates now run from about 1 day early in the far south to 3 or 4 days late further north.',
        `For a single year, a hexagon\u2019s card gives a "peak here likely" window around its forecast. The margin comes from past misses for whole strips of the map: 8 in 10 strip peaks were within ${-(data.interval?.peak[0] ?? 6)} days early to ${data.interval?.peak[1] ?? 4} days late of the forecast. One spot can miss by more. With all years combined there is no one year\u2019s weather, so no window is shown.`,
        `When it learned only from Illinois, Indiana and Ohio, it guessed Wisconsin and Minnesota about ${Math.round(data.model?.holdout_mae.heat ?? 5)} days off. Their own usual dates were about ${Math.round(data.model?.holdout_mae.cal ?? 7)} days off. But we chose this version after seeing that test, so it is a second look, not proof. The version we picked first failed it.`,
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
      const sc = mode === TYPICAL ? scoreSummary() : scoreSummary(Number(mode));
      const all = sc.n ? sc : scoreSummary();
      const days = (d: number) => `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
      return {
        name: 'Luna moth',
        sci: data.species.sci,
        creature: 'moth',
        accent: css(MOON),
        hook: 'Luna moths come out in two waves each summer. This map predicts when the first wave comes out across seven Midwest states, based on how warm the spring has been. Photos people posted of real moths show how well it matches.',
        steps: [
          { title: 'Warm days count', text: 'Starting March 1, every day warmer than 50 °F (10 °C) adds to a running total. Hotter days add more, up to 86 °F.' },
          { title: 'The jar fills', text: 'In past years, moths came out once the total reached about this line.' },
          { title: 'Moths come out', text: 'So a warm spring means early moths, and a cold spring means late ones.' },
        ],
        spotIntro: `${matchMedia('(hover: hover) and (pointer: fine)').matches ? 'Click' : 'Tap'} a hexagon on the map to see its season here.`,
        spot: (lngLat, t) => spotStory(lngLat, t),
        score: {
          title: 'How sure is it?',
          text:
            (sc.n
              ? `We checked the forecast against ${mode === TYPICAL ? 'past years' : mode}, which it hadn\u2019t learned from. ` +
                `It missed the real start and peak by about ${days(sc.heat)} on average. ` +
                `Guessing each area\u2019s usual date missed by about ${days(sc.calendar)}. ` +
                (sc.heat < sc.calendar ? '' : 'This time the usual date did as well or better. ') +
                (mode !== TYPICAL && sc.n < 3 ? `That year had enough sightings to check only ${sc.n} part${sc.n > 1 ? 's' : ''} of the map. ` : '')
              : `${mode} had too few sightings to check. The bars show all years combined. `) +
            'Not proven yet. It passes on years it never saw. It also did well on states it never saw (Wisconsin and Minnesota), but we chose it after seeing that test. The real test is the 2026 season, once its weather data is out in mid-2027.',
          bars: [
            { label: 'Heat forecast', days: all.heat, best: all.heat < all.calendar },
            { label: 'Usual date', days: all.calendar, best: all.calendar < all.heat },
          ],
        },
        finePrintLabel: 'Limits and fine print',
      };
    },

    legend(): LegendSpec {
      return {
        title: 'Forecast: when moths come out',
        items: [
          ...STAGES.map((s) => ({
            color: css(STAGE_COLOR[s]),
            label: s,
            shape: 'hex' as const,
          })),
          { color: css(STAGE_COLOR.peak), label: 'no sightings nearby', shape: 'striped' },
          { color: css(MOON), label: 'moth seen', shape: 'dot' },
          { color: css(SECOND), label: 'seen, 2nd wave', shape: 'dot' },
          { color: css(GREY), label: 'rough location', shape: 'dot' },
        ],
      };
    },

    credits() {
      return [
        'Sightings: iNaturalist observers (CC0, CC BY and CC BY-NC records only). Photos are linked, never copied.',
        'Temperatures: Daymet v4 daily 1 km, Thornton et al., ORNL DAAC.',
        'State outlines: US Census Bureau, via us-atlas.',
      ];
    },
  };
}

