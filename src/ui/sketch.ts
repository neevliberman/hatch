import type { Creature, Explainer } from '../core/layer';

// The About panel's picture strip, drawn the way a person doodles in a field notebook: tapered pen strokes that
// swell in the middle and thin at the ends, main lines gone over twice, shapes that overshoot instead of closing,
// a few quick hatch strokes on the shadow side. Each panel runs through a displacement filter whose noise seed
// changes a few times a second while the panel is open, so the lines "boil" like hand-drawn animation.

export type P = [number, number];

/** A seeded random stream, so a drawing looks the same every time it is built. */
const rng = (seed: number) => {
  let n = seed * 7919 + 13;
  return () => ((n = (n * 16807) % 2147483647) / 2147483647);
};

/** Smooth a hand-placed polyline (Catmull-Rom), `k` samples per span. */
function smooth(pts: P[], k = 6): P[] {
  if (pts.length < 2) return pts;
  const out: P[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[Math.max(0, i - 1)]!, pts[i]!, pts[i + 1]!, pts[Math.min(pts.length - 1, i + 2)]!];
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

const f1 = (v: number) => v.toFixed(1);

/** One pen stroke as a filled outline, thin at both ends and fuller in the middle. With `twice`, the hand goes
 * back over it once, a little off and lighter. `k`: samples per span (fewer for tiny drawings). */
export function pen(pts: P[], w = 1.3, seed = 1, twice = true, k = 6): string {
  const r = rng(seed);
  let d = '';
  for (let pass = 0; pass < (twice ? 2 : 1); pass++) {
    const drift = pass ? 0.8 : 0.25;
    const s = smooth(pts.map(([x, y]) => [x + (r() - 0.5) * drift, y + (r() - 0.5) * drift] as P), k);
    const ww = pass ? w * 0.5 : w;
    const press = 0.8 + 0.4 * r();
    const left: string[] = [];
    const right: string[] = [];
    s.forEach(([x, y], i) => {
      const a = s[Math.max(0, i - 1)]!;
      const b = s[Math.min(s.length - 1, i + 1)]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t = i / (s.length - 1);
      const h = (ww / 2) * press * (0.2 + 0.8 * Math.sqrt(Math.sin(Math.PI * t)));
      const nx = (-(b[1] - a[1]) / len) * h;
      const ny = ((b[0] - a[0]) / len) * h;
      left.push(`${f1(x + nx)} ${f1(y + ny)}`);
      right.unshift(`${f1(x - nx)} ${f1(y - ny)}`);
    });
    d += `M${left.join('L')}L${right.join('L')}Z`;
  }
  return d;
}

/** A hand-drawn loop: an ellipse that drifts as it goes round and overshoots where it started. */
export function loop(cx: number, cy: number, rx: number, ry: number, rot = 0, turns = 1.15, a0 = -2): P[] {
  const n = Math.round(10 * turns);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + (i / n) * turns * 2 * Math.PI;
    const g = 1 + 0.08 * (i / n);
    const x = rx * g * Math.cos(a);
    const y = ry * g * Math.sin(a);
    return [cx + x * c - y * s, cy + x * s + y * c] as P;
  });
}

/** Move, turn (degrees) and scale a drawing made around (0, 0). */
export const place = (pts: P[], dx: number, dy: number, deg = 0, k = 1): P[] => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return pts.map(([x, y]) => [dx + k * (x * c - y * s), dy + k * (x * s + y * c)]);
};

/** A smooth closed shape, used for the watercolour washes (no outline). */
export const blob = (pts: P[]) => `M${smooth(pts).map(([x, y]) => `${f1(x)} ${f1(y)}`).join('L')}Z`;

/** A few quick parallel strokes, as a hand shades one side of a shape. */
export const hatch = (x: number, y: number, n: number, dx: number, len: number, slant: number, seed: number) => {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const l = len * (0.6 + 0.5 * r());
    const x0 = x + i * dx + (r() - 0.5);
    return pen([[x0, y], [x0 + slant, y - l]], 0.6, seed + i, false);
  }).join('');
};

const flake = (x: number, y: number, k: number, seed: number) =>
  pen([[x - 3 * k, y - 2 * k], [x + 3 * k, y + 2 * k]], 0.7, seed, false) +
  pen([[x + 2.5 * k, y - 2.5 * k], [x - 2.5 * k, y + 2.5 * k]], 0.7, seed + 1, false) +
  pen([[x + 0.3, y - 3.5 * k], [x - 0.3, y + 3.5 * k]], 0.7, seed + 2, false);

// The luna moth, perched with its wings half open, drawn around its body. The far wings are a little smaller.
const MOTH = {
  wings: [
    [[1, -4], [8, -14], [20, -18], [26, -13], [21, -6], [9, -2], [2, 0]],
    [[3, -6], [12, -13], [22, -14]],
    [[-1, -4], [-7, -12], [-16, -15], [-21, -10], [-16, -4], [-7, -1], [-2, 0]],
    [[2, 1], [12, 3], [16, 9], [12, 15], [9, 22], [10, 31], [14, 37], [8, 31], [5, 21], [3, 11], [1, 3]],
    [[-2, 1], [-10, 3], [-13, 8], [-10, 14], [-8, 21], [-9, 28], [-12, 33], [-6, 28], [-4, 20], [-2, 10]],
  ] as P[][],
  spots: [loop(16, -10, 2.2, 1.8, 0, 1.1), loop(-12, -8, 1.6, 1.4, 0, 1.1), loop(9, 9, 1.6, 1.6, 0, 1.1)],
  body: [
    [[0, -8], [1.8, -3], [1.4, 5], [0, 11]],
    [[0, -8], [-1.6, -3], [-1.2, 5], [0, 11]],
    [[-1, -8], [-4, -13], [-8, -15], [-9, -13.5]],
    [[1, -8], [3, -13], [7, -16], [8.5, -14.5]],
  ] as P[][],
  wash: [
    [[1, -4], [8, -14], [20, -18], [26, -13], [21, -6], [9, -2], [12, 3], [16, 9], [12, 15], [9, 22], [10, 31], [14, 37], [6, 28], [3, 11]],
    [[-1, -4], [-7, -12], [-16, -15], [-21, -10], [-16, -4], [-7, -1], [-10, 3], [-13, 8], [-10, 14], [-8, 21], [-9, 28], [-12, 33], [-5, 25], [-2, 10]],
  ] as P[][],
};

interface Art {
  /** Washes go under the ink. */
  wash?: string;
  ink: string;
  /** Anything that moves or needs its own element (wings that flap, a cocoon that rocks, labels). */
  extra?: string;
}

/** The luna moth as the About panel draws it: a cocoon wrapped in silk in the leaf litter, and the adult perched
 * with its wings half open. Other species bring their own drawing (src/species/). */
export const MOTH_ART: Creature = {
  winters: 'litter',
  shell: true,
  sleeper: (cx, cy, k, seed) => ({
    wash: blob(loop(cx + 1.5, cy + 1.5, 11 * k, 5 * k, -0.35, 1)),
    ink: pen(loop(cx, cy, 12 * k, 5.5 * k, -0.35, 1.2, 0.6), 1.4, seed) +
      ([[-7, -1, -4, 4.5, -5, 8], [-1, -5, 2, 1, 1, 6], [5, -7, 8, -2, 8, 2]] as number[][])
        .map(([a, b, c, d, e, f], i) => pen([[cx + a! * k, cy + b! * k], [cx + c! * k, cy + d! * k], [cx + e! * k, cy + f! * k]], 0.6, seed + 1 + i, false))
        .join('') + hatch(cx - 2 * k, cy + 7 * k, 5, 2.4 * k, 4 * k, 1.2, seed + 5),
  }),
  adult: (cx, cy, k, seed) => {
    const M = (pts: P[]) => place(pts, cx, cy, -10, k);
    const w = Math.max(0.8, 1.2 * Math.sqrt(k));
    return {
      wash: MOTH.wash.map((p) => blob(M(p).map(([x, y]) => [x + 2 * k, y + 1.5 * k] as P))).join(''),
      wings: MOTH.wings.map((p, i) => pen(M(p), i === 1 ? 0.6 * w : w, seed + i)).join('') +
        MOTH.spots.map((p, i) => pen(M(p), 0.7, seed + 10 + i, false)).join(''),
      body: MOTH.body.map((b, i) => pen(M(b), i < 2 ? w : 0.7, seed + 20 + i)).join(''),
    };
  },
};

/** The off-season margin note's sketch (64x34): a cocoon on the leaf litter, or a grub under the ground line. */
export function restingSketch(c: Creature): string {
  const litter = c.winters === 'litter';
  const s = litter ? c.sleeper(26, 16, 1.1, 13) : c.sleeper(32, 22, 1, 40);
  return `<path class="wash" d="${s.wash}"/><path d="${s.ink + (litter
    ? pen([[3, 29], [30, 28], [61, 29.5]], 1.1, 3) + pen([[40, 27], [48, 22], [58, 26], [48, 28], [40, 27]], 0.9, 5)
    : pen([[3, 11], [30, 10], [61, 11.5]], 1.1, 3))}"/>`;
}

const sunAt = (cx: number, cy: number, r: number, rays: number[][], seed: number) =>
  pen(loop(cx, cy, r, r, 0, 1.25), 1.3, seed) +
  rays
    .map(([deg, len], i) => {
      const a = (deg! * Math.PI) / 180;
      const q = (d: number): P => [cx + d * Math.cos(a), cy + d * Math.sin(a)];
      return pen([q(r + 3), q(r + 3 + len!)], 0.9, seed + 1 + i, false);
    })
    .join('');

/** Panel 1: winter. A cocoon tucked against an oak leaf under the snow, or a grub in the soil. */
function winter(kind: Creature): Art {
  const z = '<text class="note" x="68" y="48" transform="rotate(-8 68 48)">zzz</text>';
  const snow = ([[34, 12], [52, 22], [62, 9], [8, 32], [90, 40], [44, 32]] as P[]).map(([x, y], i) => pen(loop(x, y, 0.7, 0.7, 0, 1), 0.7, 20 + i, false)).join('');
  if (kind.winters === 'soil') {
    const g = kind.sleeper(50, 62, 1, 40);
    return {
      wash: `<path class="wash tan" d="${g.wash}"/>`,
      ink: flake(20, 16, 1.4, 1) + flake(76, 22, 1.1, 4) + snow + pen([[8, 46], [30, 44], [52, 46], [92, 44]], 1.2, 7) + hatch(14, 54, 3, 22, 2, 1, 9) + g.ink,
      extra: z,
    };
  }
  const c = kind.sleeper(54, 62, 1, 13);
  return {
    wash: `<path class="wash tan" d="${c.wash}"/>`,
    ink: flake(18, 16, 1.4, 1) + flake(80, 22, 1.1, 4) + snow +
      pen([[8, 71], [13, 63], [11, 57], [18, 56], [19, 49], [26, 50], [29, 43], [35, 46], [41, 41], [44, 49], [51, 50], [47, 57], [53, 61], [45, 66], [30, 70], [9, 71]], 1.2, 10) +
      pen([[9, 71], [4, 74]], 1, 11, false) + pen([[10, 70], [26, 58], [42, 45]], 0.7, 12, false) +
      pen([[19, 63], [15, 59]], 0.5, 17, false) + pen([[26, 58], [22, 52]], 0.5, 18, false) + pen([[33, 52], [32, 46]], 0.5, 19, false) +
      c.ink + pen([[22, 74], [42, 73], [58, 74.5]], 0.8, 15, false) + pen([[66, 73], [80, 72]], 0.8, 16, false),
    extra: z,
  };
}

/** Panel 2: warmth wakes it. The sun beams wavy heat down onto the sleeper, which starts to stir. */
function wake(kind: Creature, moving: boolean): Art {
  const c = kind.sleeper(66, 62, 0.9, 60);
  // Three wavy heat lines from the sun down towards the sleeper.
  const waves = [-5, 0, 5]
    .map((off, i) => {
      const pts: P[] = [];
      for (let t = 0; t <= 1.001; t += 0.125) {
        const along: P = [27 + t * 26, 27 + t * 20];
        const wig = Math.sin(t * Math.PI * 4) * 1.6 + off;
        pts.push([along[0] - 0.6 * wig, along[1] + 0.8 * wig]);
      }
      return pen(pts, 0.9, 70 + i);
    })
    .join('');
  // Warm days pile up one after another: a row of small suns, bigger for hotter days.
  const days = ([[8, 1.4], [15, 2.4], [22, 1.6], [29, 3], [37, 2.2]] as P[])
    .map(([x, r], i) => pen(loop(x, 66, r, r, 0, 1.2), 0.8, 90 + i, false))
    .join('');
  const dayWash = ([[8, 1.4], [15, 2.4], [22, 1.6], [29, 3], [37, 2.2]] as P[]).map(([x, r]) => blob(loop(x + 0.6, 66.6, r, r, 0, 1))).join('');
  const stir = pen([[50, 56], [48, 60], [50, 64]], 0.7, 80, false) + pen([[82, 56], [84, 60], [82, 64]], 0.7, 81, false);
  return {
    wash: `<path class="wash sun" d="${blob(loop(21.5, 20.5, 6.5, 6.5, 0, 1))}${dayWash}"/>`,
    ink: days + pen([[41, 66], [45, 65.5]], 0.7, 96, false) + pen([[43, 63.5], [45.5, 65.5], [43, 67.5]], 0.7, 97, false) + sunAt(20, 19, 7, [[200, 3.5], [250, 4], [300, 3.5], [345, 5], [160, 3.5]], 1) +
      pen([[54, 72], [68, 71], [88, 72.5]], 0.8, 82, false) + waves,
    extra: `<text class="note small" x="6" y="38" transform="rotate(-5 6 38)">50°F+</text>
      <text class="note small" x="4" y="78" transform="rotate(-3 4 78)">day after day</text>
      <g class="${moving ? 'rock' : ''}" style="transform-origin:66px 66px"><path class="wash tan" d="${c.wash}"/><path class="pen" d="${c.ink}${stir}"/></g>`,
  };
}

/** Panel 3: the payoff. Two springs side by side: in a warm one the adult is out in May; in a cool one it is still
 * asleep in May and comes out in June. */
function race(kind: Creature, moving: boolean): Art {
  const early = kind.adult(54, 17, 0.42, 100);
  const late = kind.adult(84, 56, 0.42, 130);
  const still = kind.sleeper(50, 64, 0.55, 160);
  const cloud = pen([[5, 62], [4, 58], [8, 56], [10, 52], [15, 51], [18, 54], [21, 55], [23, 59], [20, 62], [6, 62]], 1.1, 170) +
    pen([[8, 65], [7, 69]], 0.7, 172, false) + pen([[13, 65], [12, 69]], 0.7, 173, false) + pen([[18, 65], [17, 69]], 0.7, 174, false);
  // The warm spring's cocoon is already empty, torn open at the top.
  const shell = pen(loop(30, 22, 6, 2.8, -0.35, 0.5, 0), 1, 175) +
    pen([[24.4, 24], [26, 22], [28, 23], [30, 20.5], [32, 21.5], [35.6, 20]], 0.6, 176, false);
  const flap = (a: { wash: string; wings: string }, x: number, y: number) =>
    `<g class="${moving ? 'flap' : ''}" style="transform-origin:${x}px ${y}px">${kind.glow ? '' : `<path class="wash leaf" d="${a.wash}"/>`}<path class="pen" d="${a.wings}"/></g>`;
  return {
    wash: `<path class="wash sun" d="${blob(loop(13, 19.5, 4.5, 4.5, 0, 1))}"/>${kind.glow ? `<path class="wash sun" d="${early.wash}${late.wash}"/>` : ''}` +
      `<path class="wash tan" d="${still.wash}"/>`,
    ink: sunAt(12, 18, 4.5, [[200, 1.8], [250, 3], [300, 3], [340, 3.5], [20, 3]], 171) + cloud +
      pen([[5, 43], [50, 42.2], [95, 43.5]], 0.6, 180, false) +
      pen([[37, 21], [41, 20.5], [44, 21]], 0.7, 181, false) + pen([[41.5, 18.5], [44.5, 21], [41.5, 23.5]], 0.7, 182, false) +
      pen([[26, 64], [40, 63.5]], 0.7, 183, false) + pen([[60, 63.5], [72, 63]], 0.7, 184, false) + pen([[69, 60.5], [72.5, 63], [69, 65.5]], 0.7, 185, false) +
      (kind.shell ? shell : '') + early.body + late.body + still.ink,
    extra: `<text class="note small" x="4" y="36" transform="rotate(-4 4 36)">warm</text>
      <text class="note small" x="4" y="78" transform="rotate(-4 4 78)">cool</text>
      <text class="note small" x="47" y="40" transform="rotate(-3 47 40)">May</text>
      <text class="note small" x="44" y="78" transform="rotate(-3 44 78)">May</text>
      <text class="note small" x="55" y="57" transform="rotate(-8 55 57)">zz</text>
      <text class="note small" x="76" y="79" transform="rotate(-3 76 79)">June</text>
      ${flap(early, 54, 17)}${flap(late, 84, 56)}`,
  };
}

// The wiggly frame: four strokes that cross at the corners rather than meeting.
const FRAME = [
  [[1, 4.5], [50, 3.5], [99, 5]],
  [[96.5, 1.5], [97.5, 42], [96, 82.5]],
  [[99, 80], [50, 81.5], [1.5, 79.5]],
  [[3.5, 82], [2.5, 42], [4, 2]],
] as P[][];

/** A little hand-drawn arrow between panels; `seed` makes each one a bit different. */
const arrow = (seed: number) =>
  `<svg class="ex-then" viewBox="0 0 14 16" aria-hidden="true"><path class="pen" d="${
    pen([[1, 9], [6, 7 + seed * 0.6], [12, 8]], 1.1, 200 + seed) + pen([[8, 4], [12.5, 8], [8, 12]], 1, 210 + seed, false)
  }"/></svg>`;

/** The three sketched panels, each over its caption. Screen readers get the captions only. */
export function sketchStrip(id: string, ex: Explainer, captions: string[]): string {
  const fid = `ex-boil-${id.replace(/[^\w-]/g, '')}`;
  const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  boil();
  const panes = [winter(ex.creature), wake(ex.creature, moving), race(ex.creature, moving)].map(
    (a, i) => `<div class="ex-pic"><svg class="ex-pane" viewBox="0 0 100 84" aria-hidden="true"><g filter="url(#${fid})">
      <path class="frame" d="${FRAME.map((s, k) => pen(s, 1, 300 + i * 10 + k, false)).join('')}"/>${a.wash ?? ''}<path class="pen" d="${a.ink}"/>${a.extra ?? ''}</g></svg>${i < 2 ? arrow(i) : ''}</div>`,
  );
  return `<svg class="ex-defs" aria-hidden="true" focusable="false"><filter id="${fid}" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="1"/>
      <feDisplacementMap in="SourceGraphic" scale="1.8" xChannelSelector="R" yChannelSelector="G"/></filter></svg>
    <ol class="ex-steps">${captions.map((c, i) => `<li>${panes[i]}${c}</li>`).join('')}</ol>`;
}

/** Swaps the sketch filters' noise seed about seven times a second while the About panel is open, so the pen lines
 * wobble in place. Skipped for reduced motion (the lines stay sketchy, just still) and while the panel is shut. */
let boiling = false;
function boil() {
  if (boiling) return;
  boiling = true;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let seed = 1;
  setInterval(() => {
    if (still.matches || document.hidden || !document.querySelector('#drawer.open')) return;
    seed = (seed % 3) + 1;
    for (const t of document.querySelectorAll('.ex-defs feTurbulence')) t.setAttribute('seed', String(seed));
  }, 150);
}
