import type { AtlasSpecies } from '../atlas/index';
import { nameOf, ORDER_NAMES } from '../atlas/names';

/**
 * The species picker's tree of life: every Atlas species on one radial family tree, drawn on a canvas you can pinch,
 * drag and tap. The branching is Open Tree of Life's synthetic tree (pipeline/atlas/build_tree.py): who split from
 * whom, with no dates or branch lengths, so the rings mean "how many splits from the tips", not time.
 * Analogy: a family tree drawn as a wheel, great-great-grandparents at the hub and today's species round the rim.
 *
 * Layout. Each species gets a slot on the rim (in the tree's own leaf order, with a small gap between orders) and a
 * branch sits at the middle of its children's slots, `1 - (height / tallest)^0.7` of the way out, so tips line up
 * on the rim and the many shallow splits near the tips get room. Branches get thicker with the species they carry.
 * Zooming in brings in family and genus names, then each species' iNaturalist photo and name round the rim.
 */

/** tree.json: [label, rank, ...children]; a leaf is the species' index in species.json. */
type Raw = number | [string, string, ...Raw[]];
export interface TreeData {
  src: string;
  /** Species the tree lacks, placed beside their nearest relative in the species list. */
  g: number[];
  t: Raw;
}

export interface TNode {
  /** Order, family or genus name; '' for a branch that is none of those exactly; the species' name on a tip. */
  label: string;
  rank: '' | 'o' | 'f' | 'g' | 's';
  kids: TNode[];
  parent: TNode | null;
  /** The species (index into the species list) on a tip, else -1. */
  sp: number;
  /** Species below; splits to its deepest tip; first and last tip slot. */
  n: number;
  h: number;
  lo: number;
  hi: number;
  /** Its angle (radians), the span of its children, its distance out (0 hub, 1 rim). */
  a: number;
  a0: number;
  a1: number;
  r: number;
  /** The one order every species below shares, else null: its colour. */
  order: string | null;
}

export interface TreeOfLife {
  /** Ring the species on the map now (its index), or nobody. */
  mark(sp: number | null): void;
  /** Redraw after the sheet opens or the theme changes, growing the branches in on the first open. */
  shown(): void;
  /** How far into its season each species is on the map's day `day` ("Sep 5"): 0-1 by species index, or null. Those
   * at a quarter of their best day or more glow round the rim, counted in a note ("412 out on Sep 5"). */
  glow(out: Float32Array | null, day: string): void;
}

const R = 1000; // world units, hub to rim
const GAP = 3; // empty slots between two orders on the rim
const isTip = (n: TNode) => n.sp >= 0;
const ORDER_TOKENS: Record<string, string> = {
  Lepidoptera: '--o-lep',
  Coleoptera: '--o-col',
  Diptera: '--o-dip',
  Hymenoptera: '--o-hym',
  Hemiptera: '--o-hem',
  Odonata: '--o-odo',
  Orthoptera: '--o-ort',
};
/** A species glows once its day has at least this share of its best day's expected photos ("Out now" on the map). */
const OUT = 0.25;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The tree as linked nodes, laid out on the wheel. */
export function buildTree(data: TreeData, species: AtlasSpecies[]): { root: TNode; tips: TNode[]; slots: number } {
  const tips: TNode[] = [];
  // A few species come without an order: borrow it from another species of the same genus.
  const genusOrder = new Map(species.filter((s) => s.order && s.genus).map((s) => [s.genus!, s.order!] as const));
  const make = (raw: Raw, parent: TNode | null): TNode => {
    const base = { kids: [] as TNode[], parent, a: 0, a0: 0, a1: 0, r: 0 };
    if (typeof raw === 'number') {
      const s = species[raw]!;
      const tip: TNode = { ...base, label: nameOf(s), rank: 's', sp: raw, n: 1, h: 0, lo: tips.length, hi: tips.length, order: s.order ?? genusOrder.get(s.name.split(' ')[0]!) ?? null };
      tips.push(tip);
      return tip;
    }
    const [label, rank, ...rest] = raw;
    const node: TNode = { ...base, label, rank: rank as TNode['rank'], sp: -1, n: 0, h: 0, lo: tips.length, hi: 0, order: null };
    for (const c of rest) {
      const k = make(c, node);
      node.kids.push(k);
      node.n += k.n;
      node.h = Math.max(node.h, k.h + 1);
    }
    node.hi = tips.length - 1;
    const o = node.kids[0]!.order;
    node.order = node.kids.every((k) => k.order === o) ? o : null;
    return node;
  };
  const root = make(data.t, null);
  // Rim slots: one per tip, plus a gap wherever the order changes.
  const slot: number[] = [];
  let s = 0;
  tips.forEach((t, i) => {
    if (i && t.order !== tips[i - 1]!.order) s += GAP;
    slot.push(s++);
  });
  const total = s + GAP;
  const place = (n: TNode) => {
    if (isTip(n)) {
      n.a = n.a0 = n.a1 = ((slot[n.lo]! + 0.5) / total) * Math.PI * 2 - Math.PI / 2;
      n.r = 1;
      return;
    }
    n.kids.forEach(place);
    n.a0 = n.kids[0]!.a;
    n.a1 = n.kids[n.kids.length - 1]!.a;
    n.a = (n.a0 + n.a1) / 2;
    n.r = 1 - Math.pow(n.h / root.h, 0.7);
  };
  place(root);
  return { root, tips, slots: total };
}

/** The nearest branch at or above `n` with a name (an order, family or genus), or the whole tree. */
export const named = (n: TNode): TNode => {
  let m: TNode = n;
  while (m.parent && !m.label) m = m.parent;
  return m;
};
const inside = (n: TNode, of: TNode) => n.lo >= of.lo && n.hi <= of.hi;
const plainName = (n: TNode) => (n.rank === 'o' ? (ORDER_NAMES[n.label] ?? n.label) : n.label);

/**
 * Mount the tree in `host` (an empty element that sets its own size). `onPick` gets a species index when the reader
 * chooses "Show on map"; `crumbs` gets the named branches from the hub to the current selection, for the breadcrumb.
 */
export function mountTree(
  host: HTMLElement,
  data: TreeData,
  species: AtlasSpecies[],
  onPick: (sp: number) => void,
  crumbs: (path: TNode[], go: (n: TNode) => void) => void,
): TreeOfLife {
  const { root, tips, slots } = buildTree(data, species);
  /** Pixels between neighbouring tips on the rim at the current zoom. */
  const tipGap = () => (Math.PI * 2 * R * view.s) / slots;
  const grafted = new Set(data.g);
  const nodes: TNode[] = [];
  (function walk(n: TNode) {
    nodes.push(n);
    n.kids.forEach(walk);
  })(root);
  const labelled = nodes
    .filter((n) => n.label && !isTip(n) && n.n > 1)
    .sort((a, b) => 'ofg'.indexOf(a.rank) - 'ofg'.indexOf(b.rank) || b.n - a.n);

  host.innerHTML = `<canvas class="tol-canvas" tabindex="0" role="application"
      aria-label="Tree of life. Drag or pinch to explore; arrow keys walk the branches, Enter opens, plus and minus zoom."></canvas>
    <div class="tol-card" hidden><img alt="" width="44" height="44" referrerpolicy="no-referrer" hidden><div class="tol-t"><b></b><span></span></div>
      <button type="button" class="tol-go"></button></div>
    <p class="tol-out" hidden></p>
    <p class="tol-src">Branching: <a href="https://tree.opentreeoflife.org" target="_blank" rel="noopener">Open Tree of Life</a>, no dates</p>
    <p class="tol-live" aria-live="polite"></p>`;
  const cv = host.querySelector<HTMLCanvasElement>('canvas')!;
  const ctx = cv.getContext('2d')!;
  const card = host.querySelector<HTMLElement>('.tol-card')!;
  const live = host.querySelector<HTMLElement>('.tol-live')!;
  const outNote = host.querySelector<HTMLElement>('.tol-out')!;
  let out: Float32Array | null = null;

  /** Zoom, the hub's place on screen, and the wheel's turn (radians): a branch being looked at turns to face right. */
  const view = { s: 1, tx: 0, ty: 0, rot: 0, min: 0.1 };
  /** Closest zoom: neighbouring tips 64 px apart, room for photos and names. */
  const maxS = (64 * slots) / (Math.PI * 2 * R);
  let W = 0;
  let H = 0;
  let dpr = 1;
  let sel: TNode | null = null;
  let current: TNode | null = null;
  let grow = 1; // 0..1 while the branches grow in on first open
  let grown = false;
  let raf = 0;
  let colors: Record<string, string> = {};
  let font = 'sans-serif';

  const readColors = () => {
    const cs = getComputedStyle(host);
    const v = (k: string) => cs.getPropertyValue(k).trim();
    font = cs.fontFamily;
    colors = { ink: v('--text'), muted: v('--muted'), halo: v('--halo'), edge: v('--o-other'), accent: v('--accent'), glow: v('--tol-glow') };
    for (const [o, t] of Object.entries(ORDER_TOKENS)) colors[o] = v(t);
  };
  const colOf = (n: TNode) => (n.order && colors[n.order]) || colors.edge!;

  // Photos: iNaturalist squares, fetched once each, only for tips big enough on screen to show them.
  const photos = new Map<number, HTMLImageElement | null>();
  const photo = (sp: number) => {
    if (photos.has(sp)) return photos.get(sp);
    const url = species[sp]?.photo;
    if (!url) return photos.set(sp, null), null;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.onload = () => redraw();
    img.onerror = () => photos.set(sp, null);
    img.src = url;
    photos.set(sp, img);
    return img;
  };

  // Geometry
  /**
   * Screen distance from the hub for a branch `r` of the way out. Whole wheel: straight proportion. Zoomed in, the
   * depth turns into a fixed step per split (a fisheye along the radius): the last few splits sit a finger's width
   * apart behind the tips and older ones queue up behind them, so a genus still shows its branching instead of
   * lines running in from far off screen.
   */
  const STEP = 26;
  const rpx = (r: number) => {
    const rim = R * view.s;
    if (r >= 1) return r * rim;
    const d = (1 - r) * rim;
    // The fisheye only starts once the wheel is bigger than the fixed-step depth (so the hub is long off screen) and
    // is fully on four times past that.
    const deep = STEP * Math.pow(root.h, 0.9);
    const k = Math.min(1, Math.max(0, Math.log(rim / deep) / Math.log(4)));
    const splits = root.h * Math.pow(1 - r, 1 / 0.7); // undo the layout's curve: how many splits back from the tips
    return Math.max(0, rim - ((1 - k) * d + k * Math.min(d, STEP * Math.pow(splits, 0.9))));
  };
  const xy = (n: TNode, r = n.r): [number, number] => {
    const d = rpx(r);
    return [Math.cos(n.a + view.rot) * d + view.tx, Math.sin(n.a + view.rot) * d + view.ty];
  };
  const wholeScale = () => Math.max(0.02, Math.min((W / 2 - 38) / R, (H / 2 - 56) / R)); // room for the you-are-here pin
  const fitAll = () => {
    const s = wholeScale();
    view.min = s * 0.8;
    Object.assign(view, { s, tx: W / 2, ty: H / 2 });
  };
  const clamp = () => {
    // Keep some of the wheel on screen, however far it is dragged.
    const ext = R * 1.1 * view.s;
    view.tx = Math.min(W + ext - 60, Math.max(-ext + 60, view.tx));
    view.ty = Math.min(H + ext - 60, Math.max(-ext + 60, view.ty));
  };
  const size = () => {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const first = !W;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    // A resize (a phone turned, the window dragged) keeps the same part of the tree in the middle.
    view.tx += (r.width - W) / 2;
    view.ty += (r.height - H) / 2;
    W = r.width;
    H = r.height;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    if (first) fitAll();
    else view.min = wholeScale() * 0.8;
    clamp();
    draw();
  };

  // Drawing
  /** Line weight: a twig for one species, thickening like a trunk towards the hub. */
  const weight = (n: TNode) => Math.min(3.4, 0.9 + Math.log2(n.n) * 0.24);
  /** Outside the selection (a species' selection is its genus or family, so its relatives stay lit). */
  const dim = (n: TNode) => {
    const f = sel && isTip(sel) ? named(sel.parent!) : sel;
    return !!f && f !== root && !inside(n, f) && !inside(f, n);
  };
  function draw() {
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = view.s;
    const reach = grow; // during the grow-in, only branches inside this fraction of the radius are drawn
    const onScreen = (x: number, y: number, m: number) => x > -m && y > -m && x < W + m && y < H + m;
    ctx.lineCap = 'round';
    let strokes = 0;
    // Branches: an arc across each branch's children, then a spoke out to each child.
    for (const n of nodes) {
      if (isTip(n) || n.r > reach) continue;
      const faded = dim(n);
      const w = weight(n);
      ctx.globalAlpha = faded ? 0.16 : 1;
      ctx.lineWidth = w;
      ctx.strokeStyle = colOf(n);
      const rr = rpx(n.r);
      ctx.beginPath();
      ctx.arc(view.tx, view.ty, rr, n.a0 + view.rot, n.a1 + view.rot);
      ctx.stroke();
      for (const k of n.kids) {
        const [x0, y0] = xy(k, n.r);
        const [x1, y1] = xy(k, Math.min(k.r, reach));
        if (isTip(k) && !onScreen(x0, y0, 40) && !onScreen(x1, y1, 40)) continue;
        ctx.globalAlpha = dim(k) ? 0.16 : 1;
        ctx.strokeStyle = colOf(k);
        ctx.lineWidth = weight(k);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        strokes++;
      }
    }
    ctx.globalAlpha = 1;
    cv.dataset.branches = String(strokes); // for the page tests: the canvas itself can't be read once a photo is on it
    if (reach < 1) return;

    // In season on the map's day: a glow just outside each such tip, brighter nearer its best day. Round the whole
    // wheel the glows run together into lit stretches of the rim; closer in, each tip gets its own halo.
    const gapPx = tipGap();
    if (out) {
      const photoSize = gapPx > 18 ? Math.min(22, gapPx * 0.42) : 0;
      ctx.save();
      ctx.fillStyle = colors.glow!;
      for (const t of tips) {
        const v = out[t.sp] ?? 0;
        if (v < OUT || dim(t)) continue;
        const [x, y] = xy(t, 1 + (photoSize ? photoSize + 5 : 5) / (R * s));
        if (!onScreen(x, y, 30)) continue;
        // Faint at a quarter of its best day, strong at its peak: the rim brightens where whole groups are at their height.
        ctx.globalAlpha = 0.08 + 0.5 * ((v - OUT) / (1 - OUT)) ** 1.5;
        ctx.beginPath();
        ctx.arc(x, y, photoSize ? photoSize + 6 : Math.max(2.5, Math.min(8, gapPx * 0.7)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // The species on the map now: its line of descent in the accent colour, a ring on its tip.
    if (current) {
      ctx.beginPath();
      let n: TNode = current;
      let [px, py] = xy(n);
      ctx.moveTo(px, py);
      while (n.parent) {
        const p = n.parent;
        [px, py] = xy(n, p.r);
        ctx.lineTo(px, py);
        // along the parent's arc to its own angle
        const rr = rpx(p.r);
        ctx.arc(view.tx, view.ty, rr, n.a + view.rot, p.a + view.rot, p.a < n.a);
        n = p;
      }
      ctx.strokeStyle = colors.halo!;
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = colors.accent!;
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }

    // Tips: a dot, then a photo and a name once there is room for them.
    if (gapPx > 3) {
      const rad = Math.min(22, gapPx * 0.42);
      for (const t of tips) {
        const [x, y] = xy(t, 1 + (gapPx > 18 ? rad + 5 : 0) / (R * s));
        if (!onScreen(x, y, 30)) continue;
        ctx.globalAlpha = dim(t) ? 0.2 : 1;
        const img = gapPx > 18 ? photo(t.sp) : null;
        if (img && img.complete && img.naturalWidth) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, x - rad, y - rad, rad * 2, rad * 2);
          ctx.restore();
          ctx.lineWidth = 2;
          ctx.strokeStyle = colOf(t);
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = colOf(t);
          ctx.beginPath();
          ctx.arc(x, y, gapPx > 18 ? rad * 0.5 : Math.min(4, gapPx * 0.36), 0, Math.PI * 2);
          ctx.fill();
        }
        if (t === current || t === sel) {
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = colors.accent!;
          ctx.beginPath();
          ctx.arc(x, y, (gapPx > 18 ? rad : 4) + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    if (gapPx > 11) {
      const out = gapPx > 18 ? Math.min(22, gapPx * 0.42) * 2 + 12 : 8;
      ctx.font = `${gapPx > 18 ? 13 : 11}px ${font}`;
      ctx.textBaseline = 'middle';
      for (const t of tips) {
        if (dim(t)) continue;
        const [x, y] = xy(t, 1 + out / (R * s));
        if (!onScreen(x, y, 120)) continue;
        const flip = Math.cos(t.a + view.rot) < 0;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(t.a + view.rot + (flip ? Math.PI : 0));
        ctx.textAlign = flip ? 'right' : 'left';
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors.halo!;
        ctx.strokeText(t.label, 0, 0);
        ctx.fillStyle = colors.ink!;
        ctx.fillText(t.label, 0, 0);
        ctx.restore();
      }
    }

    // A pin for the species on the map now, just outside the rim: its photo in an accent ring, "you are here".
    if (current && gapPx <= 18) {
      const [x, y] = xy(current, 1 + 22 / (R * s));
      const [rx, ry] = xy(current, 1);
      ctx.strokeStyle = colors.accent!;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(x, y);
      ctx.stroke();
      const img = photo(current.sp);
      ctx.fillStyle = colors.halo!;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      if (img && img.complete && img.naturalWidth) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, x - 12, y - 12, 24, 24);
        ctx.restore();
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.accent!;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Group names: orders by their plain names outside the rim while the whole wheel shows, then orders, families
    // and genera at their own branch once their slice is wide enough. Bigger groups first; no two overlap.
    const placed: [number, number, number, number][] = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const family = font;
    const overview = view.s < wholeScale() * 1.5;
    for (const n of labelled) {
      if (dim(n)) continue;
      const a0 = tips[n.lo]!.a;
      const a1 = tips[n.hi]!.a;
      const arc = (a1 - a0) * R * s;
      if (overview && (n.rank !== 'o' || arc < 46)) continue;
      if (!overview && arc < ({ o: 40, f: 54, g: 70 } as Record<string, number>)[n.rank]!) continue;
      if (arc > Math.max(W, H) * 4) continue;
      const text = overview ? plainName(n) : n.label;
      // In the whole-wheel view an order's name sits inside its own arm; closer in, each name sits on its branch.
      const mid = (a0 + a1) / 2 + view.rot;
      const [x, y] = overview
        ? [Math.cos(mid) * rpx(0.68) + view.tx, Math.sin(mid) * rpx(0.68) + view.ty]
        : xy(n);
      if (!onScreen(x, y, 60)) continue;
      const big = n.rank === 'o';
      ctx.font = `${big ? 700 : 600} ${big ? 13 : 12}px ${family}`;
      const w = ctx.measureText(text).width + 8;
      const box: [number, number, number, number] = [x - w / 2, y - 9, w, 18];
      if (placed.some((p) => box[0] < p[0] + p[2] && box[0] + box[2] > p[0] && box[1] < p[1] + p[3] && box[1] + box[3] > p[1])) continue;
      placed.push(box);
      ctx.lineWidth = 4;
      ctx.strokeStyle = colors.halo!;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = overview ? colors.ink! : n.order ? colOf(n) : colors.ink!;
      ctx.fillText(text, x, y);
    }
  }
  const redraw = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()));
  };

  // Flying the view
  let flight = 0;
  const fly = (to: { s: number; tx: number; ty: number; rot?: number }, ms = 520) => {
    const turn = to.rot === undefined ? 0 : Math.atan2(Math.sin(to.rot - view.rot), Math.cos(to.rot - view.rot));
    const from = { ...view };
    const t0 = performance.now();
    const id = ++flight;
    if (reducedMotion()) ms = 0;
    const step = () => {
      if (id !== flight) return;
      const k = ms ? Math.min(1, (performance.now() - t0) / ms) : 1;
      const e = 1 - Math.pow(1 - k, 3);
      view.s = from.s + (to.s - from.s) * e;
      view.tx = from.tx + (to.tx - from.tx) * e;
      view.ty = from.ty + (to.ty - from.ty) * e;
      view.rot = from.rot + turn * e;
      draw();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  };
  /**
   * Fit a branch on screen above the card. A narrow branch also turns to face right, so it reads like a printed tree:
   * splits on the left, species down the right with their names level. The view keeps the branch's last few splits,
   * not its full depth, so a small genus fills the screen instead of a thin sliver reaching back to the hub.
   */
  const fit = (n: TNode) => {
    if (n === root) return fly({ s: wholeScale(), tx: W / 2, ty: H / 2, rot: 0 });
    const a0 = tips[n.lo]!.a;
    const a1 = tips[n.hi]!.a;
    const narrow = a1 - a0 < Math.PI * 0.6;
    const rot = narrow ? -(a0 + a1) / 2 : view.rot;
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (a: number, r: number) => {
      const x = Math.cos(a + rot) * r * R;
      const y = Math.sin(a + rot) * r * R;
      b = [Math.min(b[0]!, x), Math.min(b[1]!, y), Math.max(b[2]!, x), Math.max(b[3]!, y)];
    };
    const room = H - 96; // above the card
    if (narrow) {
      // Scale to the tips' spread alone and pin the rim near the right edge, names beside it; the splits run off
      // to the left as far as they go.
      for (let i = n.lo; i <= n.hi; i++) add(tips[i]!.a, 1);
      const names = n.n <= 160 ? Math.min(240, W * 0.6) : 16;
      const sc = Math.max(view.min, Math.min(maxS, (room - 50) / Math.max(b[3]! - b[1]!, 1)));
      return fly({ s: sc, tx: W - names - 26 - R * sc, ty: room / 2 + 10, rot });
    }
    for (let i = n.lo; i <= n.hi; i++) add(tips[i]!.a, 1.04);
    add(n.a, n.r);
    const bw = Math.max(b[2]! - b[0]!, 60);
    const bh = Math.max(b[3]! - b[1]!, 60);
    const sc = Math.max(view.min, Math.min(maxS, Math.min((W - 36) / bw, (room - 40) / bh)));
    fly({ s: sc, tx: W / 2 - ((b[0]! + b[2]!) / 2) * sc, ty: room / 2 + 10 - ((b[1]! + b[3]!) / 2) * sc, rot });
  };

  // Selection and its card
  const pathTo = (n: TNode | null) => {
    const out: TNode[] = [];
    for (let m = n; m; m = m.parent) if (m.label || m === root) out.unshift(m);
    return out.filter((m) => !isTip(m));
  };
  const select = (n: TNode | null, zoom = false) => {
    sel = n === root ? null : n;
    crumbs(pathTo(n ?? root), go);
    if (!n || n === root) {
      card.hidden = true;
      live.textContent = 'All insects';
    } else {
      const tip = isTip(n);
      const s = tip ? species[n.sp]! : null;
      const up = n.parent ? named(n.parent) : null;
      card.hidden = false;
      const img = card.querySelector('img')!;
      img.hidden = !s?.photo;
      if (s?.photo) {
        img.src = s.photo;
        img.title = s.credit ?? '';
      }
      card.querySelector('b')!.textContent = tip ? nameOf(s!) : n.label ? plainName(n) : `${n.n} related species`;
      const sub = tip
        ? `${s!.name}${grafted.has(n.sp) ? ' · placed by its genus' : ''}`
        : `${n.n.toLocaleString()} species${n.rank === 'o' ? ` · ${n.label}` : ''}${up && up !== root ? ` · in ${plainName(up)}` : ''}`;
      card.querySelector('span')!.textContent = sub;
      card.querySelector('button')!.textContent = tip ? 'Show on map' : 'Zoom in';
      live.textContent = `${card.querySelector('b')!.textContent}, ${sub}`;
    }
    if (zoom && n) fit(n);
    draw();
  };
  const go = (n: TNode) => select(n, true);
  card.querySelector('button')!.addEventListener('click', () => {
    if (!sel) return;
    if (isTip(sel)) onPick(sel.sp);
    else fit(sel);
  });

  /** The tip or branch nearest a screen point, if one is close enough to mean it. */
  const hit = (px: number, py: number): TNode | null => {
    const gapPx = tipGap();
    // Beyond the rim, where photos and names are, a tap means the species in that slice.
    if (gapPx > 11) {
      const out = Math.hypot(px - view.tx, py - view.ty) - R * view.s;
      if (out > 0 && out < 280) {
        const ang = Math.atan2(py - view.ty, px - view.tx) - view.rot;
        let tip: TNode | null = null;
        let gap = Math.max(gapPx / 2, 12);
        for (const t of tips) {
          const d = Math.abs(Math.atan2(Math.sin(ang - t.a), Math.cos(ang - t.a))) * R * view.s;
          if (d < gap) (gap = d), (tip = t);
        }
        if (tip) return tip;
      }
    }
    let best: TNode | null = null;
    let bd = 24;
    for (const n of nodes) {
      const [x, y] = isTip(n) && gapPx > 18 ? xy(n, 1 + (Math.min(22, gapPx * 0.42) + 5) / (R * view.s)) : xy(n);
      const d = Math.hypot(x - px, y - py);
      if (d < bd) (bd = d), (best = n);
    }
    // A tap near a tiny unnamed fork in a crowded view means the group it belongs to.
    if (best && !isTip(best) && !best.label && gapPx < 6) best = named(best);
    if (best && isTip(best) && gapPx < 6) best = named(best.parent!);
    return best;
  };

  // Touch, mouse and wheel
  const ptr = new Map<number, [number, number]>();
  let press: { x: number; y: number; t: number; moved: number } | null = null;
  let pinch: { d: number; s: number; c: [number, number]; ang: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  const at = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const zoomAt = (c: [number, number], k: number) => {
    const ns = Math.min(maxS, Math.max(view.min, view.s * k));
    const f = ns / view.s;
    view.tx = c[0] - (c[0] - view.tx) * f;
    view.ty = c[1] - (c[1] - view.ty) * f;
    view.s = ns;
    clamp();
  };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    ptr.set(e.pointerId, at(e));
    flight++; // a touch stops any flight
    if (ptr.size === 1) press = { x: at(e)[0], y: at(e)[1], t: performance.now(), moved: 0 };
    if (ptr.size === 2) {
      const [a, b] = [...ptr.values()] as [[number, number], [number, number]];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: view.s, c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
      if (press) press.moved = 99;
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const was = ptr.get(e.pointerId);
    if (!was) return;
    const p = at(e);
    ptr.set(e.pointerId, p);
    if (ptr.size >= 2 && pinch) {
      const [a, b] = [...ptr.values()] as [[number, number], [number, number]];
      const c: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      zoomAt(c, (pinch.s * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d / view.s);
      view.tx += c[0] - pinch.c[0];
      view.ty += c[1] - pinch.c[1];
      pinch.c = c;
      // Two fingers twisting turn the wheel about the point between them.
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const d = Math.atan2(Math.sin(ang - pinch.ang), Math.cos(ang - pinch.ang));
      pinch.ang = ang;
      const [dx, dy] = [view.tx - c[0], view.ty - c[1]];
      view.tx = c[0] + dx * Math.cos(d) - dy * Math.sin(d);
      view.ty = c[1] + dx * Math.sin(d) + dy * Math.cos(d);
      view.rot += d;
    } else if (ptr.size === 1) {
      view.tx += p[0] - was[0];
      view.ty += p[1] - was[1];
      if (press) press.moved += Math.abs(p[0] - was[0]) + Math.abs(p[1] - was[1]);
      clamp();
    }
    redraw();
  });
  const release = (e: PointerEvent) => {
    ptr.delete(e.pointerId);
    if (ptr.size < 2) pinch = null;
    if (e.type === 'pointerup' && press && press.moved < 10 && performance.now() - press.t < 500 && !ptr.size) {
      const now = performance.now();
      const dbl = now - lastTap.t < 320 && Math.hypot(press.x - lastTap.x, press.y - lastTap.y) < 30;
      lastTap = { t: dbl ? 0 : now, x: press.x, y: press.y };
      const n = hit(press.x, press.y);
      if (dbl) {
        // Double tap: into the branch tapped, or twice as close.
        if (n && !isTip(n)) select(n, true);
        else fly({ ...zoomed([press.x, press.y], 2) });
      } else select(n);
    }
    if (!ptr.size) press = null;
  };
  const zoomed = (c: [number, number], k: number) => {
    const ns = Math.min(maxS, Math.max(view.min, view.s * k));
    const f = ns / view.s;
    const ext = R * 1.1 * ns;
    return {
      s: ns,
      tx: Math.min(W + ext - 60, Math.max(-ext + 60, c[0] - (c[0] - view.tx) * f)),
      ty: Math.min(H + ext - 60, Math.max(-ext + 60, c[1] - (c[1] - view.ty) * f)),
      rot: view.rot,
    };
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      flight++;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1); // Firefox scrolls in lines
      zoomAt(at(e), Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
      redraw();
    },
    { passive: false },
  );

  // Keys: Up to the parent group, Down into the biggest child, Left/Right along siblings, Enter opens.
  const namedKids = (n: TNode): TNode[] => n.kids.flatMap((k) => (!isTip(k) && !k.label ? namedKids(k) : [k]));
  cv.addEventListener('keydown', (e) => {
    const n = named(sel ?? root);
    let next: TNode | null | undefined;
    if (e.key === 'ArrowUp') next = n.parent ? named(n.parent) : root;
    else if (e.key === 'ArrowDown') next = isTip(n) ? n : [...namedKids(n)].sort((a, b) => b.n - a.n)[0];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const sibs = n.parent ? namedKids(named(n.parent)) : [n];
      const i = sibs.indexOf(n);
      next = sibs[(i + (e.key === 'ArrowRight' ? 1 : -1) + sibs.length) % sibs.length];
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (sel && isTip(sel)) onPick(sel.sp);
      else if (sel) fit(sel);
    } else if (e.key === '+' || e.key === '=') fly(zoomed([W / 2, H / 2], 1.6));
    else if (e.key === '-') fly(zoomed([W / 2, H / 2], 1 / 1.6));
    else return;
    e.preventDefault();
    if (next) select(next, true);
  });

  new ResizeObserver(size).observe(host);
  // The page's own light/dark switch sets data-theme on <html>.
  new MutationObserver(() => (readColors(), draw())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  readColors();
  select(null); // the breadcrumb's first step

  return {
    mark(sp) {
      current = sp === null ? null : (tips.find((t) => t.sp === sp) ?? null);
      draw();
    },
    shown() {
      if (!host.getBoundingClientRect().width) return; // still closed: grow in on the first real look
      readColors();
      size();
      if (grown) return draw();
      grown = true;
      if (reducedMotion()) return draw();
      const t0 = performance.now();
      const step = () => {
        grow = Math.min(1, (performance.now() - t0) / 700);
        grow = 1 - Math.pow(1 - grow, 2);
        draw();
        if (grow < 1) requestAnimationFrame(step);
      };
      grow = 0;
      step();
    },
    glow(o, day) {
      out = o;
      const n = o ? tips.filter((t) => (o[t.sp] ?? 0) >= OUT).length : 0;
      outNote.textContent = `${n.toLocaleString()} out on ${day}`;
      outNote.hidden = !o;
      cv.dataset.out = String(n); // for the page tests
      draw();
    },
  };
}
