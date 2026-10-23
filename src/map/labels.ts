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
const MAX_COVER = 0.05;
const DOT = 7; // a town's dot and the gap after it (style.css .place-town::before)
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
     * the `dots` (the data comes first). `stamp` changes when the dots do. */
    update(vp: WebMercatorViewport | undefined, free: { top: number; bottom: number; right?: number }, dots: () => [number, number][], stamp: number,
      covers: Element[]) {
      if (!vp) return;
      // Panels floating over the map (the header's buttons, the legend, a card) count as taken space too.
      const at = container.getBoundingClientRect();
      const coverBoxes = covers.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height)
        .map((r): Box => [r.left - at.left, r.top - at.top, r.right - at.left, r.bottom - at.top]);
      const { width: W, height: H, zoom } = vp;
      const [T, B, R] = [free.top, H - free.bottom, W - (free.right ?? 0)];
      const key = `${vp.longitude},${vp.latitude},${zoom},${W},${H},${T},${B},${R},${sorted.length},${stamp},${coverBoxes.join(';')}`;
      if (key === last) return; // nothing moved
      last = key;
      const placed: Box[] = [...coverBoxes];
      // Town names keep off the dots. Lake and state names may cross them (zoomed out, the dots would leave no room),
      // so the dots go in only once those are placed.
      let dotsIn = false;
      const addDots = () => {
        dotsIn = true;
        for (const d of dots()) {
          const [x, y] = vp.project(d) as [number, number];
          if (x > -DOT_R && y > T - DOT_R && x < R + DOT_R && y < B + DOT_R) placed.push([x - DOT_R, y - DOT_R, x + DOT_R, y + DOT_R]);
        }
      };
      const next = new Set<HTMLSpanElement>();
      let cover = 0;
      const clear = (b: Box) => placed.every((p) => b[0] > p[2] || b[2] < p[0] || b[1] > p[3] || b[3] < p[1]);
      for (const l of sorted) {
        if (l[3] > zoom || (l[4] === 'state' && zoom >= STATE_MAX_ZOOM)) continue;
        if (!dotsIn && KIND_ORDER[l[4]] > KIND_ORDER.state) addDots();
        const [x, y] = vp.project([l[1], l[2]]) as [number, number];
        if (x < -50 || y < T - 20 || x > R + 50 || y > B + 20) continue;
        const w = width(l);
        const h = height(l);
        if (cover + w * h > MAX_COVER * (R * (B - T))) break;
        const dotted = l[4] === 'town' || l[4] === 'city';
        // A town's name sits right of its dot, or left of it when the right is taken; anything else is centred.
        const tries: [number, boolean][] = dotted ? [[x - DOT / 2, false], [x - w - DOT + DOT / 2, true]] : [[x - w / 2, false]];
        for (const [left, flip] of tries) {
          const box: Box = [left - PAD, y - h / 2 - PAD, left + w + (dotted ? DOT : 0) + PAD, y + h / 2 + PAD];
          if (box[0] < 0 || box[2] > R || box[1] < T || box[3] > B || !clear(box)) continue;
          placed.push(box);
          cover += w * h;
          const n = node(l);
          n.classList.toggle('flip', flip);
          n.style.transform = `translate(${Math.round(left)}px, ${Math.round(y - h / 2)}px)`;
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
