import type { Creature } from '../core/layer';
import { blob, loop, pen, place, type P } from '../ui/sketch';
import type { SpeciesConfig } from '../layers/oneGeneration';
import mark from '../marks/japanese-beetle.svg';

/** The Japanese beetle as the About panel draws it: a C-shaped white grub curled in the soil, and the adult from
 * above, its wing covers parted (they lift as it takes off), six legs and clubbed feelers. */
const art: Creature = {
  winters: 'soil',
  // Typical first beetles around the end of June (most of the map mid June to mid July): a warm spring's are out in June.
  months: ['June', 'July'],
  sleeper: (cx, cy, k, seed) => {
    const arc = (rx: number, ry: number, a0: number, a1: number): P[] =>
      Array.from({ length: 9 }, (_, i) => {
        const a = a0 + ((a1 - a0) * i) / 8;
        return [cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)] as P;
      });
    // The body's outer and inner curve, a few cross creases, and the round head at its tip.
    const ribs = [1.4, 2.2, 3, 3.8, 4.6].map((a, i) =>
      pen([[cx + 4 * k * Math.cos(a), cy + 2.6 * k * Math.sin(a)], [cx + 9 * k * Math.cos(a), cy + 6 * k * Math.sin(a)]], 0.5, seed + 10 + i, false)).join('');
    return {
      wash: blob(loop(cx, cy, 9 * k, 6 * k, 0, 1)),
      ink: pen(arc(9.5, 6.5, 0.9, 5.7), 1.2, seed) + pen(arc(4, 2.6, 1.1, 5.4), 0.9, seed + 1) + ribs +
        pen(loop(cx + 6.5 * k, cy + 3.5 * k, 2.6 * k, 2.4 * k), 1, seed + 2) +
        pen([[cx + 4 * k, cy + 1 * k], [cx + 2.5 * k, cy - 0.5 * k]], 0.6, seed + 3, false),
    };
  },
  adult: (cx, cy, k, seed) => {
    const F = (pts: P[]) => place(pts, cx, cy, 0, k);
    const w = Math.max(0.7, Math.sqrt(k));
    const legs = ([[[4, -2], [9, -5]], [[5, 3], [10, 4]], [[4, 8], [8, 12]]] as P[][])
      .flatMap((l) => [l, l.map(([x, y]) => [-x, y] as P)])
      .map((l, i) => pen(F(l), 0.8, seed + 10 + i, false))
      .join('');
    return {
      wash: blob(loop(cx, cy + 3 * k, 7 * k, 9 * k, 0, 1)),
      wings: pen(F([[0.5, -2], [5, -1.5], [6.5, 4], [5, 10], [0.5, 12.5]]), w, seed) +
        pen(F([[-0.5, -2], [-5, -1.5], [-6.5, 4], [-5, 10], [-0.5, 12.5]]), w, seed + 1),
      body: pen(F(loop(0, -5, 4.5, 2.8, 0, 1.15)), w, seed + 2) + pen(F(loop(0, -9.5, 2.2, 1.7, 0, 1.15)), w, seed + 3) + legs +
        pen(F([[-1, -11], [-3, -14]]), 0.7, seed + 20, false) + pen(F([[1, -11], [3, -14]]), 0.7, seed + 21, false),
    };
  },
};

/** The Japanese beetle (Popillia japonica), built by pipeline/species (`japanese-beetle`). */
export const config: SpeciesConfig = {
  key: 'japanese-beetle',
  name: 'Japanese beetle',
  one: 'Japanese beetle',
  oneLower: 'Japanese beetle',
  thisOne: 'Japanese beetles',
  noneSeen: 'No Japanese beetles ever seen near here to check this against.',
  adults: 'adult Japanese beetles',
  busyWhen: 'days',
  words: { tagline: 'when Japanese beetles emerge', plural: 'beetles', sightingsOf: 'Japanese beetle', countedAs: 'beetles', shareName: 'Japanese beetles', mark },
  season: { on: ['Japanese beetle season is on', '. The beetles are out somewhere in the Midwest right now.'], where: 'southern Illinois, Indiana and Ohio' },
  // Copper, like its wing covers: apart from the luna's pale green and the firefly's yellow.
  glow: [238, 134, 62, 255],
  ink: '#9a4a1c',
  creature: art,
  fine: 'species/japanese-beetle/fine/',
  endNote: ['That was the beetle season.', 'Press replay to watch it again'],
  sleep: { title: 'Sleeping till summer', line: 'grubs deep in the soil' },
  hook: 'Japanese beetles, first found in the US in 1916, now come out across the Midwest once a summer and eat the leaves of hundreds of kinds of plants. Knowing when lets a gardener pick the first ones off by hand instead of spraying, which can harm bees. This map predicts when, from how warm the spring has been. It is a first try, using the luna moth’s recipe.',
  steps: [
    { title: 'Winter', text: 'All winter the young beetle lives as a curled white grub in the soil under lawns and fields.' },
    { title: 'Warmth wakes it', text: 'From March 1, every day warmer than 50 °F (10 °C) adds a little warmth. Hotter days add more.' },
    { title: 'Warm spring, early beetles', text: 'Once it has had enough warmth, it digs up and comes out to feed. A warm spring gets there sooner.' },
  ],
  checkedWhere: 'all seven states, southern Illinois to northern Minnesota',
  idNote: 'Japanese beetles are fairly easy to name from a photo: a shiny green head, copper wing covers and white tufts along the sides. Some native beetles look alike. Only records other iNaturalist users agreed on were used.',
  seasonNote: 'Japanese beetles have one generation a year here, so there is no second wave. Records after late August were left out, though a few beetles fly into September.',
  effortNote: 'To allow roughly for when people go looking, the model counts how many photos of other beetles people posted each day in each state. Japanese beetles themselves are left out, so their own summer boom never counts as people looking. Nobody has checked yet whether it helps.',
  extra: [
    'A beetle lives for weeks, not about a week as the model assumes (it was built for moths). The model makes up for it by spreading the season out, so the colours follow when beetles get photographed, not when each one digs out.',
    'The beetle is still spreading north and west. In a striped hexagon, the forecast says when it would come out if it lived there, not that it does.',
  ],
};
