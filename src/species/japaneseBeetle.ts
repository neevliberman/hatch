import type { Creature } from '../core/layer';
import { blob, loop, pen, place, type P } from '../ui/sketch';
import type { SpeciesConfig } from '../layers/oneGeneration';
import mark from '../marks/japanese-beetle.svg';
import { isDark } from '../theme';

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
  adults: 'adult Japanese beetles',
  words: { plural: 'beetles', sightingsOf: 'Japanese beetle', countedAs: 'beetles', shareName: 'Japanese beetles', mark },
  season: { on: ['Japanese beetle season is on', '. Beetles are out in the Midwest now.'], where: 'southern Illinois, Indiana and Ohio' },
  // Copper, like its wing covers: apart from the luna's pale green and the firefly's yellow.
  glow: [238, 134, 62, 255],
  get ink() { return isDark() ? '#f0a070' : '#9a4a1c'; },
  creature: art,
  fine: 'species/japanese-beetle/fine/',
  endNote: ['That was the beetle season.', 'Press replay to watch again'],
  sleep: { title: 'Sleeping till summer', line: 'grubs deep in the soil' },
  hook: 'Japanese beetles, in the US since 1916, now emerge across the Midwest each summer and eat the leaves of hundreds of plants. Knowing when lets a gardener hand-pick the first ones instead of spraying, which can harm bees. This map forecasts when from spring warmth. A first try, using the luna moth’s recipe.',
  steps: [
    { title: 'Winter', text: 'A curled white grub in the soil under lawns and fields.' },
    { title: 'Warmth wakes it', text: 'From March 1, each day above 50 °F adds warmth. Hotter days add more.' },
    { title: 'Warm spring, early beetles', text: 'With enough warmth it digs out and feeds. Warm springs mean earlier beetles.' },
  ],
  checkedWhere: 'all seven states, southern Illinois to northern Minnesota',
  idNote: 'Japanese beetles are fairly easy to identify: shiny green head, copper wing covers, white side tufts. Some native beetles look alike. Only records other iNaturalist users confirmed were used.',
  seasonNote: 'One generation a year, no second wave. Records after late August were left out, though a few beetles fly into September.',
  effortNote: 'To allow for when people go looking, the model counts photos of other beetles posted each day per state. Japanese beetles are left out, so their own boom does not count as people looking. Unchecked.',
  extra: [
    'Beetles live for weeks, not the week the model assumes (it was built for moths). It compensates by spreading the season out, so colors follow when beetles get photographed, not when each digs out.',
    'The beetle is still spreading north and west. In a striped hexagon, the forecast shows when it would emerge if it lived there.',
  ],
};
