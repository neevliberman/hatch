import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { buildGrid, type Cell } from '../core/grid';
import { dayOfYear, TimeAxis, type TimeSpec } from '../core/timeAxis';
import type { CaveatCard, HatchLayer, LegendSpec, ProbeCard } from '../core/layer';

export const DEMO_LABEL = 'Demo: synthetic heat wave, not real data';

/**
 * Pure function of (latitude, day-of-year) -> 0..1 "warmth index". NOT a temperature model.
 * Two ingredients so scrubbing visibly does something:
 *  - a seasonal swell (cold in March, warmest ~late July, a bit cooler to the north)
 *  - a Gaussian band of "heat" that sweeps from 36N to 48N between ~mid-May and ~late August
 */
export function syntheticHeat(lat: number, doy: number): number {
  const season = Math.max(0, Math.sin((Math.PI * (doy - 60)) / 240)) ** 1.5; // peaks doy ~180
  const north = (lat - 36) * 0.025; // colder going north
  const frontLat = 36 + ((doy - 135) / 95) * 12;
  const sweeping = doy > 115 && doy < 250 ? 1 : 0;
  const wave = sweeping * Math.exp(-(((lat - frontLat) / 1.6) ** 2));
  return Math.min(1, Math.max(0, 0.62 * season - north + 0.45 * wave));
}

// cold -> hot ramp, dark-theme friendly
const RAMP: [number, number, number][] = [
  [28, 46, 92],
  [64, 70, 160],
  [140, 70, 150],
  [222, 96, 96],
  [250, 170, 70],
  [255, 232, 140],
];

export function heatColor(v: number): [number, number, number, number] {
  const x = Math.min(1, Math.max(0, v)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, 215].map(Math.round) as [
    number,
    number,
    number,
    number,
  ];
}

/** Registration metadata: scrub 1 Mar - 31 Oct of `year`, one day per step. */
export function demoTimeSpec(year: number): TimeSpec {
  return { start: Date.UTC(year, 2, 1), end: Date.UTC(year, 9, 31), stepMs: TimeAxis.DAY, initial: Date.UTC(year, 5, 15) };
}

/** Synthetic layer. It builds its own grid: a real layer would also fetch its own data here. */
export function createDemoLayer(): HatchLayer {
  const cells: Cell[] = buildGrid();

  return {
    id: 'demo-heatwave',
    title: DEMO_LABEL,

    render({ t, theme }) {
      const doy = dayOfYear(t);
      return [
        new H3HexagonLayer<Cell>({
          id: 'demo-heatwave-hexes',
          data: cells,
          getHexagon: (c) => c.id,
          getFillColor: (c) => heatColor(syntheticHeat(c.lat, doy)),
          getLineColor: theme.hexEdge,
          stroked: true,
          filled: true,
          extruded: false,
          highPrecision: true,
          lineWidthMinPixels: 0.6,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 70],
          updateTriggers: { getFillColor: [doy] },
        }),
      ];
    },

    probe(lngLat, t): ProbeCard {
      const doy = dayOfYear(t);
      const v = syntheticHeat(lngLat[1], doy);
      return {
        title: 'SYNTHETIC value, not real data',
        lines: [`warmth index ${v.toFixed(2)} (0-1)`, `lat ${lngLat[1].toFixed(2)}, day-of-year ${doy}`],
      };
    },

    caveats(): CaveatCard {
      return {
        title: DEMO_LABEL,
        severity: 'synthetic',
        bullets: [
          'This layer is SYNTHETIC. It is a made-up function of latitude and day-of-year, not temperature, not degree-days, not sightings.',
          'It exists only to prove the plumbing: grid, time axis, scrubber, layer registry, probe and this drawer.',
          'Nothing here predicts when any insect emerges. Do not read anything into the colours.',
          'Real layers must fill this drawer with record counts, backtest error and threshold confidence intervals.',
        ],
      };
    },

    legend(): LegendSpec {
      return {
        title: 'Synthetic warmth index',
        stops: [
          { color: 'rgb(28,46,92)', label: 'low' },
          { color: 'rgb(140,70,150)', label: '' },
          { color: 'rgb(250,170,70)', label: '' },
          { color: 'rgb(255,232,140)', label: 'high' },
        ],
        note: 'Not real data',
      };
    },
  };
}
