import type { LunaLayer } from './layers/lunaReplay';
import type { Mode } from './layers/replayData';
import { whenFront, whenLive } from './layers/liveData';

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
  /** Loads the layer (code and data); resolves null when its data can't be fetched. Absent for the built-in luna.
   * The layer comes without waiting for the live file; onLive runs once its live forecast is attached. */
  load?: (mode: Mode, onData: () => void, onLive?: () => void) => Promise<LunaLayer | null>;
}

// The one-file build has no species files beside it and offers luna only, so the loaders (and the species code
// they pull in) are left out of it. The live file is shared (fetched once for every species, and only when wanted).
const lazy = (config: () => Promise<{ config: import('./layers/oneGeneration').SpeciesConfig }>, file: string): SpeciesEntry['load'] =>
  __BASEMAP__
    ? async (mode, onData, onLive) => {
        const url = `${import.meta.env.BASE_URL}${file}`;
        const json = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const [{ config: cfg }, gen, data] = await Promise.all([config(), import('./layers/oneGeneration'), json]);
        if (!gen.isReplay(data)) return null;
        const layer = gen.createOneGenerationLayer(cfg, data, mode, onData);
        // Its live forecast, whenever the live file is wanted and arrives (never holds up the species menu).
        void whenLive(cfg.key, data.cells).then((live) => live && (layer.setLive?.(live), onLive?.()));
        return layer;
      }
    : undefined;

// A migrant's tracker (sightings so far, no forecast): its data is public/species/<key>/front.json, its live part is
// `front.<key>` in the nightly file. See pipeline/front.
const tracker = (config: () => Promise<{ config: import('./layers/frontLayer').FrontConfig }>, file: string): SpeciesEntry['load'] =>
  __BASEMAP__
    ? async (mode, _onData, onLive) => {
        const url = `${import.meta.env.BASE_URL}${file}`;
        const json = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const [{ config: cfg }, front, data] = await Promise.all([config(), import('./layers/frontLayer'), json]);
        if (!front.isFront(data)) return null;
        const layer = front.createFrontLayer(cfg, data, mode);
        void whenFront(cfg.key).then((live) => live && (layer.setLive?.(live), onLive?.()));
        return layer;
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
  { key: 'monarch', label: 'Monarch', group: 'Butterflies', load: tracker(() => import('./species/monarch'), 'species/monarch/front.json') },
  { key: 'red-admiral', label: 'Red admiral', group: 'Butterflies', load: tracker(() => import('./species/redAdmiral'), 'species/red-admiral/front.json') },
];

/** Past this many species the menu lists them under group headings. */
export const GROUP_AFTER = 6;
