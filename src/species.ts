import type { LunaLayer } from './layers/lunaReplay';
import type { Mode } from './layers/replayData';
import { loadLive } from './layers/liveData';

/**
 * Every species Hatch can show, in menu order: the one list the species menu, the ?species= link and the loading
 * all come from. The luna moth ships in the page; every other species is fetched (its code and its data file, in
 * parallel) the first time someone picks it, so the first load never grows with the list.
 *
 * Adding a species: its data (pipeline/species, which writes public/species/<key>/), a config with its words and
 * sketch (src/species/<key>.ts, a SpeciesConfig), and one entry here. Its live season comes with it once the nightly
 * job forecasts it (pipeline/live/registry.py): the loader picks its part of public/live/latest.json by `key`.
 */
export interface SpeciesEntry {
  /** The ?species= value; layer ids start with it. */
  key: string;
  /** The menu's name (a narrow phone's closed menu shows the species' sketch mark instead). */
  label: string;
  /** The menu's group once the list is long enough to need them ("Moths", "Beetles"). */
  group: string;
  /** Loads the layer (code and data); resolves null when its data can't be fetched. Absent for the built-in luna. */
  load?: (mode: Mode, onData: () => void) => Promise<LunaLayer | null>;
}

// The one-file build has no species files beside it and offers luna only, so the loaders (and the species code
// they pull in) are left out of it. The live file is the one luna already fetches (fetched once for every species).
const lazy = (config: () => Promise<{ config: import('./layers/oneGeneration').SpeciesConfig }>, file: string): SpeciesEntry['load'] =>
  __BASEMAP__
    ? async (mode, onData) => {
        const url = `${import.meta.env.BASE_URL}${file}`;
        void loadLive(); // the live file on its way alongside (one fetch for every species)
        const json = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const [{ config: cfg }, gen, data] = await Promise.all([config(), import('./layers/oneGeneration'), json]);
        if (!gen.isReplay(data)) return null;
        const live = await loadLive(cfg.key, data.cells);
        return gen.createOneGenerationLayer(cfg, data, mode, onData, live);
      }
    : undefined;

export const SPECIES: SpeciesEntry[] = [
  { key: 'luna', label: 'Luna moth', group: 'Moths' },
  { key: 'firefly', label: 'Firefly', group: 'Beetles', load: lazy(() => import('./species/firefly'), 'firefly-replay.json') },
  {
    key: 'japanese-beetle',
    label: 'Japanese beetle',
    group: 'Beetles',
    load: lazy(() => import('./species/japaneseBeetle'), 'species/japanese-beetle/replay.json'),
  },
];

/** Past this many species the menu lists them under group headings. */
export const GROUP_AFTER = 6;
