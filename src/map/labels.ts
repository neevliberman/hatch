import type { WebMercatorViewport } from '@deck.gl/core';
import type { Label } from './basemap';

/**
 * Place names over the map, as plain text in the page's own fonts (handwritten water and forest names, like notes in
 * a field notebook). Drawn in the DOM rather than WebGL: crisp at any zoom, and no text engine in the bundle.
 *
 * Each frame: take the names this zoom allows, most important first (states, cities by size, lakes, forests, then
 * towns by size), and place each one only if its box is clear of every name already placed. Like a cartographer
 * working down a list: the big names claim their space, the small ones fill what's left, and nothing overlaps.
 */
const KIND_ORDER = { state: 0, city: 1, water: 2, park: 3, town: 4 } as const;
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
/** A lake name must fit inside its lake, a state name well inside its state (a border through the text reads as struck
 * through): the room comes with the label (pipeline/basemap/fit_labels.py). Smaller type is tried before giving up. */
const WATER_SCALES = [1, 0.82, 0.68, 0.58];
/** The four Great Lakes are named from the first view: when even the smallest size is wider than the lake on a small
 * screen, a still smaller one may run a little over the shore (the paper halo keeps it readable). */
const GREAT_SCALE = 0.5;
const GREAT_SPILL = 1.8;
const STATE_SCALES = [1, 0.84];
const STATE_SHARE = 0.72;
const PARK_SHARE = 0.8; // a forest name keeps clear of the tract's edge (and the rivers along it)
/** When the full name will not fit its state at the smallest size, the two-letter code does. */
const ABBR: Record<string, string> = { MINNESOTA: 'MN', WISCONSIN: 'WI', MICHIGAN: 'MI', ILLINOIS: 'IL', INDIANA: 'IN', OHIO: 'OH', IOWA: 'IA' };

type Box = [number, number, number, number];
type Try = [number, number, boolean];

/** Places for a lake or state name: its own spot, then slid sideways inside its shape and (lakes) up or down. A Great
 * Lake tries up and down first, so it leaves the south end (Chicago) to the city. */
function sideways(l: Label, left: number, y: number, slack: number, vslack: number): Try[] {
  const across = [0, -0.5, 0.5, -1, 1].map((k): Try => [left + k * slack, y, false]);
  const upDown = vslack ? [-0.5, -1, 0.5, 1].map((k): Try => [left, y + k * vslack, false]) : [];
  return l[5] > 100 && l[4] === 'water' ? [...upDown, ...across] : [...across, ...upDown];
}

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

  const width = (l: Label, t = l[0]) => {
    const key = l[4] + t;
    let w = widths.get(key);
    if (w === undefined) {
      if (ctx) ctx.font = FONT[l[4]];
      // State names are letter-spaced capitals (STATE_SPACING px after each letter, as in style.css).
      w = (ctx?.measureText(t).width ?? t.length * 7) + (l[4] === 'state' ? t.length * STATE_SPACING : 0);
      widths.set(key, w);
    }
    return w;
  };
  const height = (l: Label) => (l[4] === 'water' || l[4] === 'park' ? 18 : l[4] === 'city' ? 16 : 15);

  const node = (l: Label, t = l[0]) => {
    const key = `${l[4]}|${t}|${l[1]}|${l[2]}`;
    let n = nodes.get(key);
    if (!n) {
      n = document.createElement('span');
      n.className = `place place-${l[4]}`;
      n.style.transformOrigin = '0 0';
      n.textContent = t;
      layer.appendChild(n);
      nodes.set(key, n);
    }
    return n;
  };

  return {
    /** New names arrived (the detail file loaded): re-sort the list. */
    setLabels(all: Label[]) {
      const rank = (l: Label) => (l[4] === 'water' && l[5] > 100 ? -1 : KIND_ORDER[l[4]]); // the Great Lakes first of all
      sorted = [...all].sort((a, b) => rank(a) - rank(b) || b[5] - a[5]);
      widths.clear();
      last = '';
    },
    /** Place the names for this view, inside the free area (clear of the header, bottom bar and side panel) and off
     * the `dots` (the data comes first; one array per layer, the same array while its dots are unchanged). */
    update(vp: WebMercatorViewport | undefined, free: { top: number; bottom: number; right?: number }, dots: [number, number][][],
      covers: Element[]) {
      if (!vp) return;
      // Names fade in with the map (this runs after a frame is drawn), once there are names to show.
      if (sorted.length) layer.classList.add('ready');
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
      // Sighting dots are boxes of their own: towns, forest names, lakes and states keep off them (the data comes
      // first). A city does not: it never goes unnamed because a dot sits on it, and its paper halo keeps it readable.
      // A lake or state name can't move off a dot, only slide sideways inside its shape; a state or Great Lake with no clear spot
      // there keeps its place on top of the dots rather than vanish (a smaller lake waits for a closer zoom).
      const dotBoxes: Box[] = [];
      for (const d of dots.flat()) {
        const [x, y] = vp.project(d) as [number, number];
        if (x > -DOT_R && y > T - DOT_R && x < R + DOT_R && y < B + DOT_R) dotBoxes.push([x - DOT_R, y - DOT_R, x + DOT_R, y + DOT_R]);
      }
      const next = new Set<HTMLSpanElement>();
      let cover = 0;
      const apart = (b: Box) => (p: Box) => b[0] > p[2] || b[2] < p[0] || b[1] > p[3] || b[3] < p[1];
      const clear = (b: Box, withDots: boolean) => placed.every(apart(b)) && (!withDots || dotBoxes.every(apart(b)));
      for (const l of sorted) {
        const kind = l[4];
        if (l[3] > zoom || (kind === 'state' && zoom >= STATE_MAX_ZOOM)) continue;
        const [x, y] = vp.project([l[1], l[2]]) as [number, number];
        if (x < -50 || y < T - 20 || x > R + 50 || y > B + 20) continue;
        const ext = kind === 'water' || kind === 'state' || (kind === 'park' && l[6] !== undefined);
        let text = l[0];
        let w = width(l);
        let h = height(l);
        let scale = 1;
        let slack = 0; // how far a name may slide sideways, and (lakes) up or down, and still sit inside its shape
        let vslack = 0;
        if (ext) {
          // Room in pixels from the label's data: the usable run (twice the distance to the nearer shore, since the
          // name is centred) in degrees of longitude, and for lakes the same upwards and downwards in latitude.
          const perDeg = (vp.project([l[1] + 1, l[2]]) as [number, number])[0] - x;
          const room = (l[6] ?? 99) * perDeg;
          const tall = l[7] !== undefined ? (l[7] * perDeg) / Math.cos((l[2] * Math.PI) / 180) : Infinity;
          const cap = kind === 'water' ? room * 0.95 - 6 : room * (kind === 'park' ? PARK_SHARE : STATE_SHARE);
          let k: number | undefined;
          for (const s of kind === 'water' ? WATER_SCALES : STATE_SCALES) if (w * s <= cap && h * s <= tall * 0.9) { k = s; break; }
          const abbr = ABBR[text];
          if (k === undefined && kind === 'state' && abbr) {
            text = abbr;
            w = width(l, text);
            if (w <= cap) k = 1;
          }
          if (k === undefined && kind === 'water' && l[5] > 100 && w * GREAT_SCALE <= room * GREAT_SPILL) k = GREAT_SCALE;
          if (k === undefined) continue; // too big for its lake, state or forest at this zoom: wait for a closer one
          scale = k;
          w *= k;
          h *= k;
          slack = Math.max(0, (cap - w) / 2);
          if (kind === 'water' && tall < Infinity) vslack = Math.max(0, (tall * 0.9 - h) / 2);
        }
        if (!ext && cover + w * h > MAX_COVER * (R * (B - T))) continue; // a shorter name may still fit (lakes and states are the frame: no budget)
        const dotted = kind === 'town' || kind === 'city';
        const half = kind === 'city' ? 2.5 : 2; // the dot's centre sits on the place
        // A town's name sits right of its dot, or left of it when the right is taken. A lake or state name slides a
        // little sideways inside its shape. Anything else is centred, or nudged up or down a line to get clear of dots.
        const tries: [number, number, boolean][] = dotted
          ? [[x - half, y, false], [x - w - DOT + half, y, true]]
          : ext
            ? sideways(l, x - w / 2, y, slack, vslack)
            : [0, -1, 1, -2, 2].map((k) => [x - w / 2, y + k * h, false]);
        const pad = ext ? PAD * scale : PAD; // a shrunk name keeps proportionally less air around it
        const gap = kind === 'town' ? TOWN_GAP : pad;
        // Pass 2 (states and the Great Lakes) is the last resort: on top of the dots.
        const lastResort = kind === 'state' || (kind === 'water' && l[5] > 100);
        for (let pass = lastResort ? 2 : 1; pass > 0; pass--) {
          for (const [left, cy, flip] of tries) {
            const box: Box = [left - gap, cy - h / 2 - pad, left + w + (dotted ? DOT : 0) + gap, cy + h / 2 + pad];
            if (box[0] < 0 || box[2] > R || box[1] < T || box[3] > B || !clear(box, kind !== 'city' && (pass === 2 || !lastResort))) continue;
            placed.push(box);
            if (!ext) cover += w * h;
            const n = node(l, text);
            n.classList.toggle('flip', flip);
            n.style.transform = `translate(${Math.round(left)}px, ${Math.round(cy - h / 2)}px)${scale < 1 ? ` scale(${scale})` : ''}`;
            n.style.display = '';
            next.add(n);
            pass = 0;
            break;
          }
        }
      }
      for (const n of shown) if (!next.has(n)) n.style.display = 'none';
      shown = next;
    },
  };
}
