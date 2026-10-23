// Field Notebook: the map's colours (the page's colours are the tokens at the top of style.css).
// Paper land, a blue-grey wash for the lakes, ink lines, and a watercolour forecast.

type RGBA = [number, number, number, number];

const INK: RGBA = [43, 36, 28, 255];

export const palette = {
  bg: '#cfdcd8', // water and everything outside the land polygons
  land: [248, 242, 227, 255] as RGBA, // the seven forecast states
  landOuter: [236, 228, 210, 255] as RGBA,
  neighbourLine: [90, 70, 45, 60] as RGBA,
  stateLine: INK, // full ink so the borders still clear 3:1 over the dark peak green
  hexEdge: [70, 52, 30, 26] as RGBA,
  hoverTint: [43, 36, 28, 40] as RGBA, // an ink wash, visible on the pale hexes too
  // Lightness climbs to the peak and falls after it (pale sage -> deep leaf -> ochre -> faded brown), and "not yet"
  // is near-empty, so the stages read in order even for colour-blind eyes.
  stages: {
    'not yet': [214, 204, 176, 110] as RGBA,
    starting: [183, 207, 140, 225] as RGBA,
    peak: [74, 128, 72, 225] as RGBA,
    'winding down': [196, 140, 56, 220] as RGBA,
    over: [168, 150, 132, 170] as RGBA,
  },
  stripes: [43, 36, 28, 220] as RGBA, // dense ink hatching: at least 3.3:1 against every stage, peak included
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
  transparent: [0, 0, 0, 0] as RGBA,
};

/** Text colour for the species name and its marks in the About panel (the moth's own fill is too pale on paper). */
export const mothInk = '#2f6a45';
