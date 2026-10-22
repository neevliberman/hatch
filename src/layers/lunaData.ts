import { latLngToCell } from 'h3-js';
import raw from '../data/luna-replay.json';
import { GRID_RES } from '../core/grid';

/** Shape of src/data/luna-replay.json (built by pipeline/replay/build_replay.py). */
export interface ReplayFile {
  version: number;
  generated: string;
  species: { name: string; sci: string; inat_taxon: number };
  years: number[];
  quantiles: number[];
  cells: string[];
  seen: number[];
  /** Per mode ("2015".."2025", "typical"): per cell, the day of year the forecast share reaches each quantile (null = never). */
  forecast: Record<string, (number | null)[][]>;
  bands: { label: string; lo: number; hi: number; cutoff: number | null }[];
  scores: {
    band: string;
    year: number;
    n: number;
    obs_onset: number;
    obs_peak: number;
    heat_onset: number;
    heat_peak: number;
    cal_onset: number;
    cal_peak: number;
    /** What the previous (P1/P2) model said; heat_* is the current model. */
    p1_onset?: number;
    p1_peak?: number;
  }[];
  /** Added in P3: which model made the forecast and its headline scores (days, onset+peak average). */
  model?: {
    id: string;
    spec: string;
    summary: string;
    loyo_mae: { heat: number; p1: number; cal: number };
    holdout_mae: { heat: number; p1: number; cal: number; cal_lat: number };
    noise_floor: number;
  };
  /** Added in P3: 80% band for a forecast date, as day offsets [low, high] of real minus forecast. */
  interval?: { level: number; onset: [number, number]; peak: [number, number] };
  /** Added in P3: per latitude band, average days off and mean peak bias (forecast minus real). */
  scorecard?: { band: string; band_years: number; mae: { heat: number; p1: number; cal: number }; bias_peak: { heat: number; p1: number } }[];
  /** [iNat id, year, day of year, lat, lng, flags] */
  sightings: [number, number, number, number, number, number][];
  counts: Record<string, number>;
}

export const data = raw as unknown as ReplayFile;

export const SECOND_BROOD = 1;
export const APPROXIMATE = 2;

/** "typical" pools every year by day of year; otherwise a calendar year as a string. */
export type Mode = string;
export const TYPICAL: Mode = 'typical';

export interface Sighting {
  id: number;
  year: number;
  doy: number;
  /** Day of year of the same calendar date in a non-leap year: where the dot sits on the pooled "typical year" axis. */
  pdoy: number;
  lng: number;
  lat: number;
  flags: number;
  cell: string;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export const sightings: Sighting[] = data.sightings.map(([id, year, doy, lat, lng, flags]) => ({
  id,
  year,
  doy,
  pdoy: isLeap(year) && doy >= 60 ? doy - 1 : doy,
  lat,
  lng,
  flags,
  cell: latLngToCell(lat, lng, GRID_RES),
}));

/** Sightings shown in a mode: one year, or all years pooled by day of year. */
export function sightingsFor(mode: Mode): Sighting[] {
  return mode === TYPICAL ? sightings : sightings.filter((s) => String(s.year) === mode);
}

export function bandOf(lat: number) {
  const b = data.bands;
  return b.find((x) => lat >= x.lo && lat < x.hi) ?? (lat < b[0]!.lo ? b[0]! : b[b.length - 1]!);
}

/** Day of year -> UTC ms in `year` (1 = 1 Jan). */
export const doyToMs = (year: number, doy: number) => Date.UTC(year, 0, doy);

export const firstBroodCount = (mode: Mode) => sightingsFor(mode).filter((s) => !(s.flags & SECOND_BROOD)).length;
