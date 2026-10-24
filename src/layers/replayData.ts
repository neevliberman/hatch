import { latLngToCell } from 'h3-js';
import { GRID_RES } from '../core/grid';
import type { ReplayFile } from './lunaData';

/** Bit flags on a sighting (the last field of each `sightings` row). */
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

/** One row of a sightings list ([iNat id, year, day of year, lat, lng, flags]) as a dot. */
export const toSighting = ([id, year, doy, lat, lng, flags]: ReplayFile['sightings'][number]): Sighting => ({
  id,
  year,
  doy,
  pdoy: isLeap(year) && doy >= 60 ? doy - 1 : doy,
  lat,
  lng,
  flags,
  cell: latLngToCell(lat, lng, GRID_RES),
});

/** One species' replay file plus the lookups every layer needs. Luna and the firefly share this. */
export function replayData(data: ReplayFile) {
  const sightings: Sighting[] = data.sightings.map(toSighting);
  /** Sightings shown in a mode: one year, or all years pooled by day of year. */
  const sightingsFor = (mode: Mode): Sighting[] => (mode === TYPICAL ? sightings : sightings.filter((s) => String(s.year) === mode));
  const bandOf = (lat: number) => {
    const b = data.bands;
    return b.find((x) => lat >= x.lo && lat < x.hi) ?? (lat < b[0]!.lo ? b[0]! : b[b.length - 1]!);
  };
  const firstBroodCount = (mode: Mode) => sightingsFor(mode).filter((s) => !(s.flags & SECOND_BROOD)).length;
  return { data, sightings, sightingsFor, bandOf, firstBroodCount };
}

export type ReplayData = ReturnType<typeof replayData>;

/** The "How sure?" point on a card's "likely" window, from the file's own check (interval.checked): how often the real
 * peak landed inside it on past years, each year's window sized without that year. Species-neutral; null if unchecked. */
export function windowCheck(data: ReplayFile): string | null {
  const c = data.interval?.checked?.peak;
  if (!c) return null;
  const [k, n, lo, hi] = c;
  return `The "likely" dates caught the real peak of a whole band of the map in ${k} of ${n} past tries it never saw. The aim is 8 in 10; with this few tries the true rate could be anywhere from ${lo} to ${hi}%. One hexagon can miss by more.`;
}
