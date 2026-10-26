import type { Creature } from '../core/layer';
import { blob, loop, pen, place, type P } from '../ui/sketch';
import { isDark, palette } from '../theme';
import type { SpeciesConfig } from '../layers/oneGeneration';
import mark from '../marks/firefly.svg';

/** The firefly as the About panel draws it: a grub in damp soil, and a flier with its lit tail glowing. */
const art: Creature = {
  winters: 'soil',
  // Typical first fireflies around Jun 18 (most of the map Jun 5 to Jul 6): a warm spring's are out in June.
  months: ['June', 'July'],
  glow: true,
  sleeper: (cx, cy, k, seed) => ({
    wash: blob(loop(cx, cy, 16 * k, 4.5 * k, 0, 1)),
    ink: [0, 1, 2, 3].map((i) => pen([[cx + (i * 8 - 16) * k, cy], [cx + (i * 8 - 12) * k, cy - 4 * k], [cx + (i * 8 - 8) * k, cy]], 1.1, seed + i)).join('') +
      pen([[cx - 16 * k, cy], [cx, cy + 3 * k], [cx + 16 * k, cy]], 0.8, seed + 5) + pen(loop(cx - 18 * k, cy - 1, 2 * k, 2 * k), 0.9, seed + 6),
  }),
  adult: (cx, cy, k, seed) => {
    const F = (pts: P[]) => place(pts, cx, cy, 0, k);
    const w = Math.max(0.7, Math.sqrt(k));
    return {
      wash: blob(loop(cx, cy + 8 * k, 8 * k, 8 * k, 0, 1)),
      wings: pen(F([[1, -6], [8, -9], [12, -2], [9, 6], [2, 4]]), w, seed) + pen(F([[-1, -6], [-8, -9], [-12, -2], [-9, 6], [-2, 4]]), w, seed + 1),
      body: pen(F([[0, -11], [3, -4], [3, 6], [0, 12], [-3, 6], [-3, -4], [0, -11]]), 1.3 * w, seed + 2) +
        ([[-8, 10], [0, 18], [8, 10]] as P[]).map(([x, y], i) => pen(F([[x * 0.8, y * 0.8 + 2], [x * 1.3, y * 1.2 + 2]]), 0.7, seed + 3 + i, false)).join(''),
    };
  },
};

/** The common eastern firefly (Photinus pyralis), built by pipeline/firefly. */
export const config: SpeciesConfig = {
  key: 'firefly',
  name: 'Common eastern firefly',
  one: 'Firefly',
  oneLower: 'firefly',
  adults: 'adult common eastern fireflies',
  words: { plural: 'fireflies', sightingsOf: 'firefly', countedAs: 'fireflies', shareName: 'fireflies', mark },
  season: { on: ['Firefly season is on', '. Fireflies are flashing in the Midwest now.'], where: 'the central Midwest' },
  // Firefly light is yellow-green; a warm yellow keeps it apart from the luna's pale green.
  get glow() { return palette.firefly; },
  get ink() { return isDark() ? '#f2c25a' : '#8a5a00'; },
  creature: art,
  fine: 'fine-firefly/',
  endNote: ['That was the firefly season.', 'Press replay to watch again'],
  sleep: { title: 'Sleeping till summer', line: 'larvae in the soil' },
  hook: 'Common eastern fireflies light up summer evenings. This map forecasts when they emerge across seven Midwest states from spring warmth. A first try, using the luna moth’s recipe.',
  steps: [
    { title: 'Winter', text: 'A grub in damp soil.' },
    { title: 'Warmth wakes it', text: 'From March 1, each day above 50 °F adds warmth. Hotter days add more.' },
    { title: 'Warm spring, early fireflies', text: 'With enough warmth it emerges and flashes. Warm springs mean earlier fireflies.' },
  ],
  checkedWhere: 'Illinois to central Wisconsin and Michigan',
  idNote: 'Fireflies are hard to identify from photos. Only records other iNaturalist users confirmed were used, and other firefly kinds were left out.',
  seasonNote: 'One season a year, no second wave. Records after late August were left out.',
  effortNote: 'To allow for when people go looking, the model counts beetle photos posted each day per state. Most are taken by day, so it is a rough stand-in, and unchecked.',
  holdoutYears: 4,
};
