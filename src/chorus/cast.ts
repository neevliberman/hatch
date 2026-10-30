import { cellToLatLng } from 'h3-js';
import { ATLAS_YEAR, loadAtlas, type Atlas } from '../atlas/atlas';
import { dayOfYear } from '../core/timeAxis';
import { songFor } from './songs';
import type { Singer } from './synth';

/**
 * Who is singing at a place on a day: every Atlas species with a known song, scored by the network's share of insect
 * photos there and then (the same numbers as the map), against its own best.
 *
 * Analogy: the guest list for the night. The Atlas says who tends to show up here this week; the temperature then
 * decides who actually sings (synth.ts).
 */

export interface Cast {
  singers: Singer[];
  name: (sp: number) => string;
  /** The Atlas cell, null when the place is off the map. */
  inside: boolean;
}

/** A singer needs at least this much of its own best share to be heard at all. */
const FLOOR = 0.015;

export async function castFor(lat: number, lng: number, ms: number, warmDays = 0): Promise<Cast | null> {
  const atlas: Atlas | null = await loadAtlas();
  if (!atlas) return null;
  const name = (sp: number) => atlas.species[sp]?.common ?? atlas.species[sp]?.name ?? '';
  const c = atlas.cellAt(lat, lng);
  if (c === null) return { singers: [], name, inside: false };
  const cell = atlas.cells[c]!;
  const day = Math.min(365, Math.max(1, dayOfYear(ms)));
  const year = new Date(ms).getUTCFullYear();
  let ahead = warmDays;
  if (year === ATLAS_YEAR) {
    const a = await atlas.ahead(year);
    if (a) ahead += a[c * 365 + day - 1]!;
  }
  const [la, ln] = cellToLatLng(cell.h);
  const logs = atlas.net.logShares({ lat: la, lng: ln, dd: cell.dd }, day, ahead);
  const singers: Singer[] = [];
  for (const s of atlas.species) {
    const song = songFor(s.name);
    if (!song) continue;
    const rel = Math.exp(logs[s.i]!) / s.peak;
    if (rel < FLOOR) continue;
    singers.push({ sp: s.i, song, density: Math.min(1, rel ** 0.5) });
  }
  singers.sort((a, b) => b.density - a.density);
  return { singers: singers.slice(0, 10), name, inside: true };
}
