/**
 * The Atlas's species list, on its own so the species picker can load it without the network (src/atlas/atlas.ts).
 */

/** One output of the network: a species (or, last, every other insect). */
export interface AtlasSpecies {
  i: number;
  name: string;
  common: string | null;
  order: string | null;
  family: string | null;
  genus: string | null;
  /** Training records. */
  n: number;
  taxon: number | null;
  photo: string | null;
  credit: string | null;
  /** Its top share in any cell on any day of a typical year: the top of its colour scale. */
  peak: number;
  /** 2026's test against its own calendar: 1 the network won, 0 it lost, null too few records to test. */
  test: number | null;
}

export const atlasUrl = (f: string) => `${import.meta.env.BASE_URL}atlas/${f}`;
export const json = <T>(f: string): Promise<T | null> =>
  fetch(atlasUrl(f)).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

/** The ?species= key for a species: its scientific name, lower case, hyphens ("papilio-glaucus"). */
export const atlasKey = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

let index: Promise<AtlasSpecies[] | null> | null = null;
/** The species list (the last row, "other", left out). Fetched once. */
export function loadIndex(): Promise<AtlasSpecies[] | null> {
  index ??= json<AtlasSpecies[]>('species.json').then((s) => (s ? s.slice(0, -1) : ((index = null), null)));
  return index;
}
