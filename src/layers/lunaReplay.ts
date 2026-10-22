import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
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

/** Adults live about a week, so each sighting glows for this many days, fading as it ages. */
export const GLOW_DAYS = 10;
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

type RGBA = [number, number, number, number];
// Forecast hexes live in blue (season coming) -> bright teal (peak) -> dusky violet (season gone), so the
// north/south ends of the wave never share a colour. The moths themselves are the only moonlight green on the map.
// Lightness climbs to the peak and falls after it, and "not yet" is near-empty, so the two ends never look alike.
const STAGE_COLOR: Record<Stage, RGBA> = {
  'not yet': [26, 34, 56, 90],
  starting: [40, 110, 170, 210],
  peak: [72, 190, 202, 230],
  'winding down': [140, 112, 192, 210],
  over: [80, 68, 110, 170],
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
}

export function createLunaLayer(initial: Mode = TYPICAL): LunaLayer {
  let mode = initial;
  let shown = sightingsFor(mode);
  const cellIndex = new Map(data.cells.map((c, i) => [c, i] as const));
  const cells = data.cells.map((id, i) => ({ id, i, seen: data.seen[i] === 1 }));
  const yearOf = () => (mode === TYPICAL ? TYPICAL_AXIS_YEAR : Number(mode));
  const forecast = () => data.forecast[mode] ?? data.forecast[TYPICAL]!;
  const filterExt = [new DataFilterExtension({ filterSize: 1 })];

  const cellColor = (i: number, seen: boolean, doy: number): RGBA => {
    const c = STAGE_COLOR[stageAt(forecast()[i], doy)];
    return seen ? c : [c[0], c[1], c[2], Math.round(c[3] * 0.35)];
  };

  // The default spot until a hex is tapped: Chicago's western suburbs (the city's own hex centre is in the lake).
  const HOME: [number, number] = [-88.0, 41.9];
  const spotStory = (lngLat: [number, number] | null, t: number): SpotStory | null => {
    const at = lngLat ?? HOME;
    const cell = latLngToCell(at[1], at[0], GRID_RES);
    const i = cellIndex.get(cell);
    if (i === undefined) return null;
    const [q05, q25, , q75, q95] = forecast()[i] ?? [];
    if (q05 == null || q25 == null || q75 == null) return null;
    const year = yearOf();
    const f = (d: number) => fmtDoy(year, d);
    const doy = dayOfYear(t);
    const stage = stageAt(forecast()[i], doy);
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
        .filter((s) => s.cell === cell && !(s.flags & (SECOND_BROOD | APPROXIMATE)))
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

    render({ t, theme }) {
      const doy = dayOfYear(t);
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
      return [
        new H3HexagonLayer<(typeof cells)[number]>({
          id: 'luna-forecast',
          data: cells,
          getHexagon: (c) => c.id,
          getFillColor: (c) => cellColor(c.i, c.seen, doy),
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
            : 'First wave of the year (the one the map forecasts)',
        ];
        if (s.flags & APPROXIMATE) lines.push('Location is approximate, so the dot is gray');
        return {
          title: `Luna moth seen ${fmtDoy(s.year, s.doy)}, ${s.year}`,
          lines,
          link: { href: `https://www.inaturalist.org/observations/${s.id}`, label: 'See the photo on iNaturalist' },
        };
      }
      const cell = latLngToCell(lngLat[1], lngLat[0], GRID_RES);
      const i = cellIndex.get(cell);
      if (i === undefined) return null;
      const q = forecast()[i] ?? [];
      const [q05, q25, q50, q75] = q;
      const stage = stageAt(q, doy);
      const lines = [`Forecast for ${fmtDoy(year, doy)}: ${stage}`];
      if (q05 != null && q50 != null && q25 != null && q75 != null)
        lines.push(`First moths about ${fmtDoy(year, q05)}. Busiest ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}.`);
      const band = bandOf(lngLat[1]);
      const sc =
        mode === TYPICAL
          ? null
          : data.scores.find((r) => r.band === band.label && r.year === year);
      if (sc)
        lines.push(
          `Peak this year in this strip of the map (${band.label}°N): seen ${fmtDoy(year, sc.obs_peak)}, forecast ${fmtDoy(year, sc.heat_peak)}, usual date ${fmtDoy(year, sc.cal_peak)}`,
        );
      const here = sightingsFor(mode).filter((s) => s.cell === cell);
      const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
      const firstDays = here.filter((s) => !(s.flags & SECOND_BROOD)).map(day).sort((a, b) => a - b);
      const median = firstDays.length % 2 ? firstDays[(firstDays.length - 1) / 2]! : (firstDays[firstDays.length / 2 - 1]! + firstDays[firstDays.length / 2]!) / 2;
      lines.push(
        here.length
          ? `${here.length} sighting${here.length > 1 ? 's' : ''} in this hexagon${mode === TYPICAL ? ' (all years)' : ''}` +
              (firstDays.length ? `. Middle date of the first wave: ${fmtDoy(year, median)}` : '')
          : `No sightings in this hexagon${mode === TYPICAL ? '' : ' this year'}`,
      );
      // The window comes from past misses for whole strips of the map, each forecast from that year's real weather.
      // So it only applies to a replayed year: "all years" has no one year's weather, and its spread is much wider.
      // Last, so the short hover card (first lines only) and phone layouts keep their size; the pinned card shows it.
      const pk = data.interval?.peak;
      if (pk && q50 != null && mode !== TYPICAL)
        lines.push(`Peak here likely ${fmtDoy(year, q50 + pk[0])} to ${fmtDoy(year, q50 + pk[1])}.`);
      if (!cells[i]!.seen) lines.push('No lunas ever seen near here, so there is nothing to check this forecast against. Shown faint.');
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
        'Faint hexagons have no luna sightings nearby, ever. There is nothing to check the forecast against there.',
        'Sightings show where people look as much as where moths are. Towns and porch lights get counted too often. An empty spot does not mean no moths.',
        'The last version ran about 6 days early in the far south and 4 days late in the north. This one counts the week each moth flies and when people go looking, which fixes most of that. Its peak dates now run 0 to 3 days late in every strip of the map.',
        `For a single year, a hexagon\u2019s card gives a "peak here likely" window around its forecast. The margin comes from past misses for whole strips of the map: 8 in 10 strip peaks were within ${-(data.interval?.peak[0] ?? 6)} days early to ${data.interval?.peak[1] ?? 4} days late of the forecast. One spot can miss by more. With all years combined there is no one year\u2019s weather, so no window is shown.`,
        'When it learned only from Illinois, Indiana and Ohio, it guessed Wisconsin and Minnesota worse than their own usual dates (about 7 days off, against 7). So it is not ready for places it has never seen.',
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
      const one = (d: number) => d.toFixed(1);
      return {
        name: 'Luna moth',
        sci: data.species.sci,
        creature: 'moth',
        accent: css(MOON),
        hook: 'This map predicts when luna moths come out across seven Midwest states, based on how warm the spring has been. Photos people posted of real moths show how close it gets.',
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
              ? `Tested on ${mode === TYPICAL ? 'years' : mode} it had not learned from, the heat forecast was off by about ${one(sc.heat)} days, on average, for when moths started and peaked. ` +
                `Simply guessing each area\u2019s usual date was off by about ${one(sc.calendar)} days. ` +
                (sc.heat < sc.calendar ? 'So far the heat forecast is closer. ' : 'This time the usual date did as well or better. ') +
                (mode !== TYPICAL && sc.n < 3 ? `That year had enough sightings to check only ${sc.n} part${sc.n > 1 ? 's' : ''} of the map. ` : '')
              : `${mode} had too few sightings to check. The bars show all years combined. `) +
            'Not proven yet. It passes on years it never saw, but it failed a test on states it never saw (Wisconsin and Minnesota). The real test is the 2026 season, once its weather data is out in mid-2027.',
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
        title: 'Forecast: first wave of moths',
        items: [
          ...STAGES.map((s) => ({
            color: css(STAGE_COLOR[s]),
            label: s,
            shape: 'hex' as const,
          })),
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

