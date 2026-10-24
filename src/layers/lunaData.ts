import raw from '../data/luna-replay.json';
import { replayData, SECOND_BROOD, type Mode, type Sighting } from './replayData';

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
    /** Degree-days at which half have come out, by latitude. */
    median_dd_at_lat?: Record<string, number>;
    loyo_mae: { heat: number; p1: number; cal: number };
    holdout_mae: { heat: number; p1: number; cal: number; cal_lat: number } | null;
    noise_floor: number;
    /** Strip-years scored leave-one-year-out and in the IL/IN/OH to WI/MN holdout (species built by pipeline/species). */
    band_years?: number;
    holdout_band_years?: number;
  };
  /** Added in P3: 80% band for a forecast date, as day offsets [low, high] of real minus forecast. */
  interval?: {
    level: number;
    onset: [number, number];
    peak: [number, number];
    /** How often the window caught the real date on past years, each year's window sized without that year:
     * [inside, strip-years, 90% interval low %, high %] (pipeline/fit/CALIBRATION.md). `season`: a fresh season's
     * strip peaks against the live window (luna only). */
    checked?: {
      onset: [number, number, number, number];
      peak: [number, number, number, number];
      season?: { year: number; as_of: string; peak: [number, number] };
    };
  };
  /** Added in P3: per latitude band, average days off and mean peak bias (forecast minus real). */
  scorecard?: { band: string; band_years: number; mae: { heat: number; p1: number; cal: number }; bias_peak: { heat: number; p1: number } }[];
  /** [iNat id, year, day of year, lat, lng, flags] */
  sightings: [number, number, number, number, number, number][];
  counts: Record<string, number>;
}

export const data = raw as unknown as ReplayFile;
export const luna = replayData(data);

export { APPROXIMATE, SECOND_BROOD, TYPICAL, toSighting, type Mode, type Sighting } from './replayData';
export const { sightings, bandOf } = luna;

/** Live sightings only: not yet confirmed by other iNaturalist users (needs ID). Drawn a little fainter. */
export const UNCONFIRMED = 4;
/** This season, forecast every night from the weather so far (public/live/latest.json): every species with a part in it. */
export const LIVE: Mode = 'live';

/** This season so far, from public/live/latest.json (src/layers/liveData.ts); empty until that file arrives. */
let liveSightings: Sighting[] = [];
export const setLiveSightings = (s: Sighting[]) => void (liveSightings = s);

/** Sightings shown in a mode: one year, all years pooled by day of year, or this season's (live). */
export const sightingsFor = (mode: Mode): Sighting[] => (mode === LIVE ? liveSightings : luna.sightingsFor(mode));
export const firstBroodCount = (mode: Mode) => sightingsFor(mode).filter((s) => !(s.flags & SECOND_BROOD)).length;

/** Day of year -> UTC ms in `year` (1 = 1 Jan). */
export const doyToMs = (year: number, doy: number) => Date.UTC(year, 0, doy);
