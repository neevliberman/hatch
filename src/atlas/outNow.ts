/**
 * "Out here now": which species are near their best at one place on one day, for the pinned card's list
 * (layers/atlasLayer.ts). Plain arrays, no DOM, so Node can check it too.
 *
 * Analogy: a garden in bloom. The commonest plants are always there; what makes the day is which ones are flowering
 * now. So the list is ranked by how far each species is into its own season at this place (its expected photos today
 * as a share of its best day's here), with how common it is counting only a little.
 */
import type { AtlasSpecies } from './index';

/** A species must be at least this share of the insect photos here today to be listed: rarer is hardly "out". */
export const OUT_MIN_SHARE = 1e-3;
/** How much commonness counts beside nearness to the best day: the score is near * share^OUT_COMMON. At 0.25 a species
 * on its best day at 1 in 300 photos outranks one at 1 in 20 that is only halfway to its own. */
export const OUT_COMMON = 0.25;
/** Fewer than this share of its best day's photos: not "near its best" in any sense, left off. */
export const OUT_MIN_NEAR = 0.2;

/** Every species' season at one place: its log-share every STEP days ([day * S + species]), and its best day's
 * expected photos there (share times the day's usual photos). */
export interface PlaceSeasons {
  ls: Float32Array;
  best: Float32Array;
  /** Species. */
  S: number;
}

/** From the network's log-shares for a place's season (one row per ribbon day) and the usual photos on each. */
export function placeSeasons(ls: Float32Array, volume: readonly number[], S: number): PlaceSeasons {
  const n = ls.length / S;
  const best = new Float32Array(S);
  for (let j = 0; j < n; j++) {
    const v = volume[j] ?? 0;
    for (let s = 0; s < S; s++) {
      const p = Math.exp(ls[j * S + s]!) * v;
      if (p > best[s]!) best[s] = p;
    }
  }
  return { ls, best, S };
}

export interface OutNow {
  i: number;
  /** Its share of insect photos here today. */
  share: number;
  /** Its expected photos today as a share of its best day's here (0-1). */
  near: number;
}

/** Day `doy` as a position on the season's steps: [step, fraction toward the next]. */
const stepOf = (doy: number, from: number, step: number, n: number): [number, number] => {
  const x = Math.min(n - 1, Math.max(0, (doy - from) / step));
  const k = Math.min(n - 2, Math.floor(x));
  return [k, x - k];
};

/** The species out here on `doy`, best first (`skip`: left out, such as the one already on the map, "other insects"). */
export function outNow(ps: PlaceSeasons, volume: readonly number[], doy: number, from: number, step: number, skip: (i: number) => boolean): OutNow[] {
  const { ls, best, S } = ps;
  const n = ls.length / S;
  const [k, f] = stepOf(doy, from, step, n);
  const v0 = volume[k] ?? 0;
  const v1 = volume[k + 1] ?? 0;
  const got: (OutNow & { score: number })[] = [];
  for (let s = 0; s < S; s++) {
    if (skip(s)) continue;
    const a = Math.exp(ls[k * S + s]!);
    const b = Math.exp(ls[(k + 1) * S + s]!);
    const share = a + (b - a) * f;
    if (share < OUT_MIN_SHARE || !(best[s]! > 0)) continue;
    const near = Math.min(1, (a * v0 + (b * v1 - a * v0) * f) / best[s]!);
    if (near < OUT_MIN_NEAR) continue;
    got.push({ i: s, share, near, score: near * share ** OUT_COMMON });
  }
  return got.sort((x, y) => y.score - x.score).map(({ i, share, near }) => ({ i, share, near }));
}

/** Its expected photos here every other STEP days, scaled to its best (0-1): the row's small season line. */
export function curveOf(ps: PlaceSeasons, volume: readonly number[], i: number): number[] {
  const { ls, best, S } = ps;
  const n = ls.length / S;
  const out: number[] = [];
  for (let j = 0; j < n; j += 2) out.push(Math.round((Math.exp(ls[j * S + i]!) * (volume[j] ?? 0) * 100) / best[i]!) / 100);
  return out;
}

/** The chips, in this order: short everyday names. Butterflies are the butterfly and skipper families; the rest of
 * Lepidoptera are moths. Bees are the bee families; ants their own; the other Hymenoptera, wasps and sawflies, "Wasps". */
export const OUT_GROUPS = ['Butterflies', 'Moths', 'Bees', 'Wasps', 'Ants', 'Beetles', 'Flies', 'Bugs', 'Dragonflies', 'Grasshoppers'] as const;
const BUTTERFLIES = new Set(['Papilionidae', 'Pieridae', 'Lycaenidae', 'Riodinidae', 'Nymphalidae', 'Hesperiidae']);
const BEES = new Set(['Apidae', 'Halictidae', 'Andrenidae', 'Megachilidae', 'Colletidae', 'Melittidae']);
const BY_ORDER: Record<string, string> = { Coleoptera: 'Beetles', Diptera: 'Flies', Hemiptera: 'Bugs', Odonata: 'Dragonflies', Orthoptera: 'Grasshoppers' };
/** Its chip, or null for the few in none (lacewings, mantises…: under "All" only). */
export function groupOf(s: AtlasSpecies): string | null {
  if (s.order === 'Lepidoptera') return BUTTERFLIES.has(s.family ?? '') ? 'Butterflies' : 'Moths';
  if (s.order === 'Hymenoptera') return BEES.has(s.family ?? '') ? 'Bees' : s.family === 'Formicidae' ? 'Ants' : 'Wasps';
  return BY_ORDER[s.order ?? ''] ?? null;
}
