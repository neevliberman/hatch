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
  }[];
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
  lng: number;
  lat: number;
  flags: number;
  cell: string;
}

export const sightings: Sighting[] = data.sightings.map(([id, year, doy, lat, lng, flags]) => ({
  id,
  year,
  doy,
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
