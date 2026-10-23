import type { WebMercatorViewport } from '@deck.gl/core';
import type { Label } from './basemap';

/**
 * Place names over the map, as plain text in the page's own fonts (handwritten water and forest names, like notes in
 * a field notebook). Drawn in the DOM rather than WebGL: crisp at any zoom, and no text engine in the bundle.
 *
 * Each frame: take the names this zoom allows, most important first (states, big lakes, cities by size, forests, then
 * towns by size), and place each one only if its box is clear of every name already placed. Like a cartographer
 * working down a list: the big names claim their space, the small ones fill what's left, and nothing overlaps.
 */
const KIND_ORDER = { water: 0, state: 1, city: 2, park: 3, town: 4 } as const;
const FONT = {
  state: "700 12px 'Fraunces', Georgia, serif",
  water: "600 17px 'Caveat', cursive",
  park: "600 16px 'Caveat', cursive",
  city: "700 13px 'Atkinson Hyperlegible', system-ui, sans-serif",
  town: "400 12px 'Atkinson Hyperlegible', system-ui, sans-serif",
} as const;
/** States name the zoomed-out views only; closer in, the towns say where you are. */
const STATE_MAX_ZOOM = 6.3;
/** Space kept clear around each name, and how much of the screen names may cover (map space is king). */
const PAD = 5;
const TOWN_GAP = 14; // extra room either side of a town's name, so towns stay a few names apart, not shoulder to shoulder
const MAX_COVER = 0.035;
const DOT = 7; // a town's dot and the gap after it (style.css .place-town::before: 4 px, 5 px for a city, gap 3 px)
const STATE_SPACING = 2.5;
const DOT_R = 7; // a sighting dot with its halo

type Box = [number, number, number, number];

export function createLabels(container: HTMLElement) {
  const layer = document.createElement('div');
  layer.className = 'map-labels';
  layer.setAttribute('aria-hidden', 'true');
  container.appendChild(layer);
  const ctx = document.createElement('canvas').getContext('2d');
  const widths = new Map<string, number>();
  const nodes = new Map<string, HTMLSpanElement>();
  let sorted: Label[] = [];
  let shown = new Set<HTMLSpanElement>();
  let last = '';
  let lastDots: [number, number][][] = [];
  // Widths measured before the web fonts arrived are the fallback font's: measure again once they're in.
  void document.fonts?.ready.then(() => {
    widths.clear();
    last = '';
  });

  const width = (l: Label) => {
    const key = l[4] + l[0];
    let w = widths.get(key);
    if (w === undefined) {
      if (ctx) ctx.font = FONT[l[4]];
      // State names are letter-spaced capitals (STATE_SPACING px after each letter, as in style.css).
      w = (ctx?.measureText(l[0]).width ?? l[0].length * 7) + (l[4] === 'state' ? l[0].length * STATE_SPACING : 0);
      widths.set(key, w);
    }
    return w;
  };
  const height = (l: Label) => (l[4] === 'water' || l[4] === 'park' ? 18 : l[4] === 'city' ? 16 : 15);

  const node = (l: Label) => {
    const key = `${l[4]}|${l[0]}|${l[1]}|${l[2]}`;
    let n = nodes.get(key);
    if (!n) {
      n = document.createElement('span');
      n.className = `place place-${l[4]}`;
      n.textContent = l[0];
      layer.appendChild(n);
      nodes.set(key, n);
    }
    return n;
  };

  return {
    /** New names arrived (the detail file loaded): re-sort the list. */
    setLabels(all: Label[]) {
      sorted = [...all].sort((a, b) => KIND_ORDER[a[4]] - KIND_ORDER[b[4]] || b[5] - a[5]);
      widths.clear();
      last = '';
    },
    /** Place the names for this view, inside the free area (clear of the header, bottom bar and side panel) and off
     * the `dots` (the data comes first; one array per layer, the same array while its dots are unchanged). */
    update(vp: WebMercatorViewport | undefined, free: { top: number; bottom: number; right?: number }, dots: [number, number][][],
      covers: Element[]) {
      if (!vp) return;
      layer.classList.add('ready'); // the first frame is drawn: fade the names in with the map, not before it
      // Panels floating over the map (the header's buttons, the legend, a card) count as taken space too.
      const at = container.getBoundingClientRect();
      const coverBoxes = covers.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height)
        .map((r): Box => [r.left - at.left, r.top - at.top, r.right - at.left, r.bottom - at.top]);
      const { width: W, height: H, zoom } = vp;
      const [T, B, R] = [free.top, H - free.bottom, W - (free.right ?? 0)];
      const key = `${vp.longitude},${vp.latitude},${zoom},${W},${H},${T},${B},${R},${sorted.length},${coverBoxes.join(';')}`;
      if (key === last && dots.length === lastDots.length && dots.every((d, i) => d === lastDots[i])) return; // nothing moved
      lastDots = dots;
      last = key;
      const placed: Box[] = [...coverBoxes];
      // Names keep off the dots: the data comes first. A lake name that can't get clear waits for a closer zoom.
      let dotsIn = false;
      const addDots = () => {
        dotsIn = true;
        for (const d of dots.flat()) {
          const [x, y] = vp.project(d) as [number, number];
          if (x > -DOT_R && y > T - DOT_R && x < R + DOT_R && y < B + DOT_R) placed.push([x - DOT_R, y - DOT_R, x + DOT_R, y + DOT_R]);
        }
      };
      const next = new Set<HTMLSpanElement>();
      let cover = 0;
      const clear = (b: Box) => placed.every((p) => b[0] > p[2] || b[2] < p[0] || b[1] > p[3] || b[3] < p[1]);
      for (const l of sorted) {
        if (l[3] > zoom || (l[4] === 'state' && zoom >= STATE_MAX_ZOOM)) continue;
        if (!dotsIn) addDots();
        const [x, y] = vp.project([l[1], l[2]]) as [number, number];
        if (x < -50 || y < T - 20 || x > R + 50 || y > B + 20) continue;
        const w = width(l);
        const h = height(l);
        if (cover + w * h > MAX_COVER * (R * (B - T))) continue; // a shorter name may still fit
        const dotted = l[4] === 'town' || l[4] === 'city';
        const half = l[4] === 'city' ? 2.5 : 2; // the dot's centre sits on the place
        // A town's name sits right of its dot, or left of it when the right is taken. Anything else is centred, or
        // nudged up or down a line to get clear of the dots.
        const tries: [number, number, boolean][] = dotted
          ? [[x - half, y, false], [x - w - DOT + half, y, true]]
          : [0, -1, 1, -2, 2].map((k) => [x - w / 2, y + k * h, false]);
        const gap = l[4] === 'town' ? TOWN_GAP : PAD;
        for (const [left, cy, flip] of tries) {
          const box: Box = [left - gap, cy - h / 2 - PAD, left + w + (dotted ? DOT : 0) + gap, cy + h / 2 + PAD];
          if (box[0] < 0 || box[2] > R || box[1] < T || box[3] > B || !clear(box)) continue;
          placed.push(box);
          cover += w * h;
          const n = node(l);
          n.classList.toggle('flip', flip);
          n.style.transform = `translate(${Math.round(left)}px, ${Math.round(cy - h / 2)}px)`;
          n.style.display = '';
          next.add(n);
          break;
        }
      }
      for (const n of shown) if (!next.has(n)) n.style.display = 'none';
      shown = next;
    },
  };
}
