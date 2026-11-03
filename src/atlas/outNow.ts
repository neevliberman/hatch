/**
 * "Out here now": which species are near their best at one place on one day, for the pinned card's list
 * (layers/atlasLayer.ts). Plain arrays, no DOM, so Node can check it too.
 *
 * Analogy: a garden in bloom. The commonest plants are always there; what makes the day is which ones are flowering
 * now. So the list is ranked by how far each species is into its own season at this place (its expected photos today
 * as a share of its best day's here), with how common it is counting only a little. A species with no real season
 * here (about as many photos all year, or a best day at the edge of the months the network covers, likely a winter
 * one) is left out: it has no "best day" to be near. When hardly anything is near its best (early spring, late
 * autumn), the card falls back to the commonest species here, under the old title.
 */
import type { Atlas, AtlasSpecies } from './atlas';

/** A species must be at least this share of the insect photos here today to be listed: rarer is hardly "out". */
export const OUT_MIN_SHARE = 1e-3;
/** How much commonness counts beside nearness to the best day: the score is near * share^OUT_COMMON. At 0.25 a species
 * on its best day at 1 in 300 photos outranks one at 1 in 20 that is only halfway to its own. */
export const OUT_COMMON = 0.25;
/** Fewer than this share of its best day's photos: not "near its best" in any sense, left off. */
export const OUT_MIN_NEAR = 0.2;
/** A real season: its best day's expected photos at least this many times its median day's (a honey bee or a house
 * cockroach, about as common all year, scores 2-4; a skimmer 20). */
export const OUT_PEAKY = 4;
/** A best day within this many ribbon steps of either end of the months covered may be the edge of a winter peak. */
const EDGE_STEPS = 4;
/** "Near its best": within this many days of its best day here. Fewer than OUT_FEW such species: the fallback. */
export const OUT_NEAR_DAYS = 21;
export const OUT_FEW = 3;

/** Every species' season at one place: its log-share every STEP days ([day * S + species]), its best day's expected
 * photos there (share times the day's usual photos), that day (day of year), and whether it has a real season here. */
export interface PlaceSeasons {
  ls: Float32Array;
  best: Float32Array;
  bestDay: Uint16Array;
  seasonal: Uint8Array;
  /** Species. */
  S: number;
}

/** From the network's log-shares for a place's season (one row per ribbon day) and the usual photos on each. */
export function placeSeasons(ls: Float32Array, volume: readonly number[], S: number, from: number, step: number): PlaceSeasons {
  const n = ls.length / S;
  const best = new Float32Array(S);
  const bestDay = new Uint16Array(S);
  const seasonal = new Uint8Array(S);
  const col = new Float32Array(n);
  for (let s = 0; s < S; s++) {
    let k = 0;
    for (let j = 0; j < n; j++) {
      col[j] = Math.exp(ls[j * S + s]!) * (volume[j] ?? 0);
      if (col[j]! > col[k]!) k = j;
    }
    best[s] = col[k]!;
    bestDay[s] = from + k * step;
    const median = col.sort()[n >> 1]!;
    seasonal[s] = k >= EDGE_STEPS && k < n - EDGE_STEPS && best[s]! >= OUT_PEAKY * median ? 1 : 0;
  }
  return { ls, best, bestDay, seasonal, S };
}

/** The list, best first: species indices and their shares of the photos here today (0-1). */
export interface OutNow {
  i: Int16Array;
  share: Float32Array;
  /** Hardly anything near its best here: the commonest species instead (the old "Also out here"). */
  fallback: boolean;
}

/** The species out here on `doy` (`skip`: left out, such as the one already on the map, "other insects"). */
export function outNow(ps: PlaceSeasons, volume: readonly number[], doy: number, from: number, step: number, skip: (i: number) => boolean): OutNow {
  const { ls, best, bestDay, seasonal, S } = ps;
  const n = ls.length / S;
  const x = Math.min(n - 1, Math.max(0, (doy - from) / step));
  const k = Math.min(n - 2, Math.floor(x));
  const f = x - k;
  const v0 = volume[k] ?? 0;
  const v1 = volume[k + 1] ?? 0;
  const ranked: { i: number; share: number; score: number }[] = [];
  const common: { i: number; share: number; score: number }[] = [];
  let near = 0;
  for (let s = 0; s < S; s++) {
    if (skip(s)) continue;
    const a = Math.exp(ls[k * S + s]!);
    const b = Math.exp(ls[(k + 1) * S + s]!);
    const share = a + (b - a) * f;
    if (share < OUT_MIN_SHARE) continue;
    common.push({ i: s, share, score: share });
    if (!seasonal[s]) continue;
    const r = Math.min(1, (a * v0 + (b * v1 - a * v0) * f) / best[s]!);
    if (r < OUT_MIN_NEAR) continue;
    if (Math.abs(doy - bestDay[s]!) <= OUT_NEAR_DAYS) near++;
    ranked.push({ i: s, share, score: r * share ** OUT_COMMON });
  }
  const fallback = near < OUT_FEW;
  const list = (fallback ? common : ranked).sort((p, q) => q.score - p.score);
  return { i: Int16Array.from(list, (o) => o.i), share: Float32Array.from(list, (o) => o.share), fallback };
}

/** Every species' season at a place, for one run (a typical year, 2026, warmed: `key`), shared by all of an Atlas's
 * species layers (it doesn't depend on the species shown). The last few places are kept, the least recently used
 * going first. */
const caches = new WeakMap<Atlas, Map<string, PlaceSeasons>>();
const KEEP = 6;
export function placeCache(atlas: Atlas, key: string, make: () => PlaceSeasons): PlaceSeasons {
  let m = caches.get(atlas);
  if (!m) caches.set(atlas, (m = new Map()));
  let got = m.get(key);
  if (got) m.delete(key); // to the back: used just now
  else got = make();
  m.set(key, got);
  while (m.size > KEEP) m.delete(m.keys().next().value!);
  return got;
}

/** The chips, in this order: short everyday names. Butterflies are the butterfly and skipper families; the rest of
 * Lepidoptera are moths. Bees are the bee families; ants their own; the other Hymenoptera, wasps and sawflies, "Wasps". */
export const OUT_GROUPS = ['Butterflies', 'Moths', 'Bees', 'Wasps', 'Ants', 'Beetles', 'Flies', 'Bugs', 'Dragonflies', 'Grasshoppers'] as const;
/** At most this many chips (besides All): the groups with the most species in the place's list. */
export const OUT_CHIPS = 4;
const BUTTERFLIES = new Set(['Papilionidae', 'Pieridae', 'Lycaenidae', 'Riodinidae', 'Nymphalidae', 'Hesperiidae']);
const BEES = new Set(['Apidae', 'Halictidae', 'Andrenidae', 'Megachilidae', 'Colletidae', 'Melittidae']);
const BY_ORDER: Record<string, string> = { Coleoptera: 'Beetles', Diptera: 'Flies', Hemiptera: 'Bugs', Odonata: 'Dragonflies', Orthoptera: 'Grasshoppers' };
/** Its chip, or null for the few in none (lacewings, mantises…: under "All" only). */
export function groupOf(s: AtlasSpecies): string | null {
  if (s.order === 'Lepidoptera') return BUTTERFLIES.has(s.family ?? '') ? 'Butterflies' : 'Moths';
  if (s.order === 'Hymenoptera') return BEES.has(s.family ?? '') ? 'Bees' : s.family === 'Formicidae' ? 'Ants' : 'Wasps';
  return BY_ORDER[s.order ?? ''] ?? null;
}
