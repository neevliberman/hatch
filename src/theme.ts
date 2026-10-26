// Field Notebook: the map's colours (the page's colours are the tokens at the top of style.css).
// Paper land, a blue-grey wash for the lakes, ink lines, and a watercolour forecast.

type RGBA = [number, number, number, number];

const INK: RGBA = [43, 36, 28, 255];

const light = {
  bg: '#cfdcd8', // water and everything outside the land polygons
  land: [248, 242, 227, 255] as RGBA, // the seven forecast states
  landOuter: [236, 228, 210, 255] as RGBA,
  neighbourLine: [90, 70, 45, 60] as RGBA,
  stateLine: INK, // full ink so the borders still clear 3:1 over the dark peak green
  hexEdge: [70, 52, 30, 26] as RGBA,
  hoverTint: [43, 36, 28, 40] as RGBA, // an ink wash, visible on the pale hexes too
  // Lightness climbs to the peak and falls after it (pale sage -> deep leaf -> ochre -> faded brown), and "not yet"
  // and "over" are pale, so the ink goes where the moths are. The two pale ends stay apart by lightness as well as hue:
  // "not yet" a near-paper grey-sage (L* 90 on the paper), "over" a warm taupe clearly darker (L* 78, 1.4:1 against
  // "not yet"), both still well lighter than the live stages' colour.
  stages: {
    'not yet': [200, 208, 184, 105] as RGBA,
    starting: [183, 207, 140, 225] as RGBA,
    peak: [74, 128, 72, 225] as RGBA,
    'winding down': [196, 140, 56, 220] as RGBA,
    over: [170, 142, 114, 135] as RGBA,
  },
  // Fine full-ink hatching: 4.0:1 against the flat peak green, about 3:1 rendered (the 1.5 px lines are antialiased),
  // and 6:1 or more on every other stage.
  stripes: [43, 36, 28, 255] as RGBA,
  // Sightings are drawn as a marker in three rings: pale fill, ink rim, paper halo. The ink rim gives at least 4:1
  // against every light hex and the paper halo 3.4:1 against the dark peak green, so a dot always clears the 3:1
  // non-text contrast bar (WCAG 1.4.11) whatever it sits on.
  moth: [226, 246, 150, 255] as RGBA,
  second: [200, 80, 20, 255] as RGBA,
  // Firefly sightings: a warm glow yellow, so they never read as luna moths when the species switches.
  firefly: [250, 204, 40, 255] as RGBA,
  // Three clear lightness steps, so the dot types differ without relying on hue: pale moth, orange second wave
  // (3.4:1 against both others), small solid-ink rough location.
  rough: INK,
  front: [140, 87, 12, 255] as RGBA, // the forecast front (layers/front.ts): the app's amber, so it never reads as a border
  dotRim: INK,
  dotHalo: [248, 242, 227, 255] as RGBA,
  dotShadow: [43, 36, 28, 40] as RGBA,
  marker: [140, 87, 12, 255] as RGBA,
  pick: INK,
  // Map detail (map/basemap.ts): lakes in the water wash, rivers in blue ink on a paper casing, highways as paper
  // lines, forest outlines in leaf-green ink.
  water: [207, 220, 216, 255] as RGBA, // = bg
  riverInk: [52, 96, 128, 235] as RGBA,
  riverCase: [248, 242, 227, 170] as RGBA,
  road: [248, 242, 227, 190] as RGBA, // paper lines, like roads left blank on a printed map
  forest: [24, 64, 34, 210] as RGBA,
  trees: [24, 64, 34, 120] as RGBA, // the tree marks on woods (USGS land cover)
  transparent: [0, 0, 0, 0] as RGBA,
};

// The same notebook by lamplight: warm dark paper, chalky ink. Lightness still carries the stages (a dim "not yet", a
// bright "starting", a deep emerald peak), the dots are a bright fill in a near-black rim and a chalk halo (the light
// map's pale fill, ink rim and paper halo, inverted so the rim still separates the fill from bright hexes and the halo
// from dark ones), and the stripes are near-black on the emerald peak.
const CHALK: RGBA = [236, 227, 205, 255];
const SOOT: RGBA = [20, 16, 12, 255];
const lamp: typeof light = {
  bg: '#18252a',
  land: [44, 38, 31, 255],
  landOuter: [35, 30, 25, 255],
  neighbourLine: [225, 205, 170, 60],
  stateLine: CHALK,
  hexEdge: [235, 215, 180, 30],
  hoverTint: [255, 244, 214, 55],
  stages: {
    'not yet': [130, 146, 124, 70],
    starting: [116, 154, 80, 235],
    peak: [38, 134, 82, 240],
    'winding down': [204, 130, 44, 235],
    over: [150, 122, 98, 120],
  },
  stripes: SOOT,
  moth: [226, 246, 150, 255],
  second: [255, 150, 66, 255],
  firefly: [250, 204, 40, 255],
  rough: SOOT,
  front: [236, 168, 70, 255],
  dotRim: SOOT,
  dotHalo: CHALK,
  dotShadow: [0, 0, 0, 90],
  marker: [236, 168, 70, 255],
  pick: CHALK,
  water: [24, 37, 42, 255],
  riverInk: [118, 170, 206, 235],
  riverCase: [44, 38, 31, 170],
  road: [120, 108, 88, 200],
  forest: [118, 186, 126, 210],
  trees: [118, 186, 126, 110],
  transparent: [0, 0, 0, 0],
};

export type ThemeMode = 'light' | 'dark';
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const inks = { light: '#2f6a45', dark: '#8fd09a' };

const KEY = 'hatch-theme';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
/** The reader's saved choice, if any; otherwise the system setting. */
function chosen(): ThemeMode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}
const start = (): ThemeMode => document.documentElement.dataset.theme === 'dark' || document.documentElement.dataset.theme === 'light'
  ? (document.documentElement.dataset.theme as ThemeMode) // set before first paint by the script in index.html
  : chosen() ?? (systemDark.matches ? 'dark' : 'light');

let mode: ThemeMode = start();
/** The map's colours for the current mode. Mutated in place on a switch (layers hold references to it), so read it
 * when drawing and never keep one of its colours in a module-level constant. */
export const palette = clone(mode === 'dark' ? lamp : light);
/** Text colour for the species name and its marks in the About panel (the moth's own fill is too pale on paper). */
export let mothInk = inks[mode];
export const isDark = () => mode === 'dark';
/** Counts the switches. Layers put it in their update triggers, so deck reads their colour accessors again. */
export let epoch = 0;
/** `layer` with the epoch in its colour update triggers (after a switch; before one it comes back as it was). */
export function recoloured<L extends { props: object; clone(p: never): L }>(layer: L): L {
  if (!epoch) return layer;
  const t = ((layer.props as { updateTriggers?: Record<string, unknown[]> }).updateTriggers ?? {});
  const next = { ...t };
  for (const k of ['getFillColor', 'getLineColor', 'getColor']) next[k] = [...(t[k] ?? []), epoch];
  return layer.clone({ updateTriggers: next } as never);
}

const listeners = new Set<() => void>();
/** Run after the mode changes (once the palette holds the new colours). */
export const onTheme = (fn: () => void) => void listeners.add(fn);

const metaColor = { light: '#f8f2e3', dark: '#241f19' };
function apply(next: ThemeMode) {
  mode = next;
  epoch++;
  const { stages, ...rest } = clone(next === 'dark' ? lamp : light);
  Object.assign(palette, rest);
  Object.assign(palette.stages, stages); // in place: layers hold this object as their stage colours
  mothInk = inks[next];
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', metaColor[next]);
  listeners.forEach((fn) => fn());
}
apply(mode);
epoch = 0; // the first colours are not a switch

/** Switch modes and remember the choice. */
export function setMode(next: ThemeMode) {
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked: the choice lasts until reload */ }
  if (next !== mode) apply(next);
}
export const toggleMode = () => setMode(mode === 'dark' ? 'light' : 'dark');
// With no saved choice the page follows the system setting as it changes.
try { systemDark.addEventListener('change', () => { if (!chosen()) apply(systemDark.matches ? 'dark' : 'light'); }); } catch { /* an old Safari: no live follow */ }
