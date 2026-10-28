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

/** The year whose real warmth ships (ahead-YEAR.bin), and whose photos are set against the network (seen-YEAR). */
export const ATLAS_YEAR = 2026;

export const atlasUrl = (f: string) => `${import.meta.env.BASE_URL}atlas/${f}`;
export const json = <T>(f: string): Promise<T | null> =>
  fetch(atlasUrl(f)).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

/** The ?species= key for a species: its scientific name, lower case, hyphens ("papilio-glaucus"). */
export const atlasKey = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

/** A year's biggest surprises (pipeline/atlas/seen.py): species index and a few words, "2.0×", "3%", "11 d late". */
export interface Surprise {
  i: number;
  note: string;
}
let surprising: Promise<{ year: number; list: Surprise[] } | null> | null = null;
/** The year's surprises for the species picker, from seen-YEAR.json. Fetched once; null when missing. */
export function loadSurprises(year: number): Promise<{ year: number; list: Surprise[] } | null> {
  surprising ??= json<{ species: [number, number, number | null, number | null][]; surprises?: number[] }>(`seen-${year}.json`).then((f) =>
    f?.surprises
      ? {
          year,
          list: f.surprises.map((i) => {
            const [, , r, d] = f.species[i]!;
            const note = r !== null ? (r < 1 ? `${Math.max(1, Math.round(r * 100))}%` : `${r < 9.95 ? r.toFixed(1) : Math.round(r)}×`) : `${Math.abs(d ?? 0)} d ${(d ?? 0) > 0 ? 'early' : 'late'}`;
            return { i, note };
          }),
        }
      : ((surprising = null), null),
  );
  return surprising;
}

let index: Promise<AtlasSpecies[] | null> | null = null;
/** The species list (the last row, "other", left out). Fetched once. */
export function loadIndex(): Promise<AtlasSpecies[] | null> {
  index ??= json<AtlasSpecies[]>('species.json').then((s) => (s ? s.slice(0, -1) : ((index = null), null)));
  return index;
}
