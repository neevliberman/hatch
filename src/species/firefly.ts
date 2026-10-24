import type { Creature } from '../core/layer';
import { blob, loop, pen, place, type P } from '../ui/sketch';
import { palette } from '../theme';
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
  thisOne: 'this firefly',
  noneSeen: 'No fireflies of this kind ever seen near here to check this against.',
  adults: 'adult common eastern fireflies',
  busyWhen: 'nights',
  words: { tagline: 'when fireflies glow', plural: 'fireflies', sightingsOf: 'firefly', countedAs: 'fireflies', shareName: 'fireflies', mark },
  season: { on: ['Firefly season is on', '. Fireflies are flashing somewhere in the Midwest right now.'], where: 'the central Midwest' },
  // Firefly light is yellow-green; a warm yellow keeps it apart from the luna's pale green.
  glow: palette.firefly,
  ink: '#8a5a00',
  creature: art,
  fine: 'fine-firefly/',
  endNote: ['That was the firefly season.', 'Press replay to watch it again'],
  sleep: { title: 'Sleeping till summer', line: 'larvae in the soil' },
  hook: 'Common eastern fireflies light up summer evenings once a year. This map predicts when they come out across seven Midwest states, based on how warm the spring has been. It is a first try, using the luna moth’s recipe.',
  steps: [
    { title: 'Winter', text: 'All winter the young firefly lives as a grub in damp soil.' },
    { title: 'Warmth wakes it', text: 'From March 1, every day warmer than 50 °F (10 °C) adds a little warmth. Hotter days add more.' },
    { title: 'Warm spring, early fireflies', text: 'Once it has had enough warmth, out it comes and starts to flash. A warm spring gets there sooner.' },
  ],
  checkedWhere: 'Illinois to central Wisconsin and Michigan',
  idNote: 'Fireflies are hard to name from a photo, and a flash at night is harder. Only records other iNaturalist users agreed on were used, and records of other firefly kinds were left out.',
  seasonNote: 'Fireflies have one flying season a year, so there is no second wave. Records after late August were left out.',
  effortNote: 'To allow roughly for when people go looking, the model counts how many beetle photos people posted each day in each state. Most beetle photos are taken by day, so this is a rough stand-in, and nobody has checked yet whether it helps.',
  holdoutYears: 4,
};
