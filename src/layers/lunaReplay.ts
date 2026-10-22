import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import { latLngToCell } from 'h3-js';
import { GRID_RES } from '../core/grid';
import { dayOfYear, TimeAxis, type TimeSpec } from '../core/timeAxis';
import type { CaveatCard, HatchLayer, LegendSpec, ProbeCard } from '../core/layer';
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
const STAGE_COLOR: Record<Stage, RGBA> = {
  'not yet': [22, 30, 52, 150],
  starting: [38, 92, 140, 205],
  peak: [64, 168, 188, 220],
  'winding down': [92, 90, 150, 200],
  over: [44, 38, 66, 160],
};
const MOON: RGBA = [196, 255, 206, 255];
const SECOND: RGBA = [255, 196, 120, 255];
const GREY: RGBA = [168, 176, 190, 255];
const css = (c: RGBA) => `rgb(${c[0]},${c[1]},${c[2]})`;

const dotColor = (s: Sighting): RGBA => (s.flags & APPROXIMATE ? GREY : s.flags & SECOND_BROOD ? SECOND : MOON);

const fmtDoy = (year: number, doy: number) =>
  new Date(doyToMs(year, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const modeLabel = (mode: Mode) =>
  mode === TYPICAL ? `typical year (${data.years[0]}-${data.years[data.years.length - 1]} pooled)` : mode;

/** Scrub 1 Apr - 30 Sep. `doy` keeps the cursor on the same calendar day when switching years. */
export function replayTimeSpec(mode: Mode, doy = 161): TimeSpec {
  const year = mode === TYPICAL ? TYPICAL_AXIS_YEAR : Number(mode);
  return {
    start: Date.UTC(year, 3, 1),
    end: Date.UTC(year, 8, 30),
    stepMs: TimeAxis.DAY,
    initial: doyToMs(year, doy),
    label:
      mode === TYPICAL
        ? (ms) => `${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} · typical year`
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

  return {
    id: 'luna-replay',
    title: 'Luna moth',
    mode: () => mode,
    setMode(m) {
      mode = m;
      shown = sightingsFor(m);
    },

    render({ t, theme }) {
      const doy = dayOfYear(t);
      // Time reaches the dots only through the filter range (a GPU uniform), so scrubbing never re-uploads them.
      const filter = {
        getFilterValue: (s: Sighting) => s.doy,
        filterRange: [doy - GLOW_DAYS, doy + 0.5] as [number, number],
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
          updateTriggers: { getFillColor: [mode] },
          ...filter,
        }),
        new ScatterplotLayer<Sighting>({
          id: 'luna-dots',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: dotColor,
          radiusUnits: 'pixels',
          getRadius: 2.6,
          pickable: false,
          updateTriggers: { getFillColor: [mode] },
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
          s.flags & SECOND_BROOD ? 'Second brood (shown as seen; not forecast)' : 'First brood (the one we forecast)',
        ];
        if (s.flags & APPROXIMATE) lines.push('Location blurred or rough: shown in grey');
        return {
          title: `Luna moth · ${fmtDoy(s.year, s.doy)}, ${s.year}`,
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
      const lines = [`Heat forecast here today: ${stage}`];
      if (q05 != null && q50 != null && q25 != null && q75 != null)
        lines.push(`Starting ~${fmtDoy(year, q05)} · busiest ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}`);
      const band = bandOf(lngLat[1]);
      const sc =
        mode === TYPICAL
          ? null
          : data.scores.find((r) => r.band === band.label && r.year === year);
      if (sc)
        lines.push(
          `${band.label}°N this year: real peak ${fmtDoy(year, sc.obs_peak)} · heat said ${fmtDoy(year, sc.heat_peak)} · calendar said ${fmtDoy(year, sc.cal_peak)}`,
        );
      const here = sightingsFor(mode).filter((s) => s.cell === cell);
      const first = here.filter((s) => !(s.flags & SECOND_BROOD));
      lines.push(
        here.length
          ? `Seen in this hex${mode === TYPICAL ? ' (all years)' : ''}: ${here.length} sighting${here.length > 1 ? 's' : ''}` +
              (first.length ? `, first-brood middle ${fmtDoy(year, first[Math.floor(first.length / 2)]!.doy)}` : '')
          : `No sightings in this hex${mode === TYPICAL ? '' : ' this year'}`,
      );
      if (!cells[i]!.seen) lines.push('No lunas ever recorded nearby, so the forecast is drawn faint');
      return { title: `Luna moth · ${modeLabel(mode)}`, lines };
    },

    caveats(): CaveatCard {
      const all = scoreSummary();
      const yr = mode === TYPICAL ? null : scoreSummary(Number(mode));
      const c = data.counts;
      const bullets = [
        `Dots are real iNaturalist sightings of adult luna moths (captive and reared ones removed), ${c.sightings?.toLocaleString() ?? '?'} in 7 states, ${data.years[0]}-${data.years[data.years.length - 1]}. Each one glows for ${GLOW_DAYS} days because an adult lives about a week.`,
        'Hex colours are the heat forecast. Think of a bank account: from 1 March every day above 10 °C pays in a little warmth, and lunas come out once enough is saved. The forecast reads each spot’s real daily temperatures and says where the first brood should be: not yet, starting, peak, winding down.',
        `How good is it? In a first test, each year was guessed without seeing that year's moths. The heat forecast called the start and the peak about ${all.heat.toFixed(1)} days off on average; the plain calendar (“it's usually early June here”) was about ${all.calendar.toFixed(1)} days off. Promising, not proven: this version was picked after the first try lost, so it still has to pass on the 2026 season before we claim it.`,
        'Watch for a pattern: the forecast tends to run a little early in the south and late in the north. The first test found lunas in the north come out with less warmth saved up than southern ones (local adaptation or daylength, still an open question), and one Midwest-wide model splits the difference.',
        'This is a replay, not a real forecast: it uses the temperatures that actually happened. A spring forecast would have to use weather forecasts and will be less sharp.',
        'Amber dots are the southern second brood (July-August). They are shown as seen; the forecast covers the first brood only.',
        'Grey dots have a blurred or rough location (privacy settings or a big error circle).',
        'Sightings show where people look as much as where moths are: towns and porch lights are over-counted, and an empty spot does not mean no moths.',
        'Faint hexes have never had a luna recorded nearby, so their forecast has nothing to check against.',
      ];
      if (yr && yr.n)
        bullets.push(
          `${mode}, latitude by latitude: ` +
            yr.rows
              .map((r) => `${r.band}°N real peak ${fmtDoy(r.year, r.obs_peak)}, heat ${fmtDoy(r.year, r.heat_peak)}, calendar ${fmtDoy(r.year, r.cal_peak)}`)
              .join('; ') +
            '.',
        );
      else if (yr) bullets.push(`${mode} had too few sightings in every latitude band to score (needs 20).`);
      return { title: 'Luna moth replay: what you are looking at', severity: 'normal', bullets };
    },

    legend(): LegendSpec {
      return {
        title: 'Heat forecast (first brood)',
        items: [
          ...STAGES.map((s) => ({
            color: css(STAGE_COLOR[s]),
            label: s,
            shape: 'hex' as const,
          })),
          { color: css(MOON), label: 'sighting', shape: 'dot' },
          { color: css(SECOND), label: '2nd brood', shape: 'dot' },
          { color: css(GREY), label: 'rough spot', shape: 'dot' },
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

