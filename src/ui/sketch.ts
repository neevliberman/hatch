import type { Explainer } from '../core/layer';

// The About panel's picture strip, drawn the way a person doodles in a field notebook: tapered pen strokes that
// swell in the middle and thin at the ends, main lines gone over twice, shapes that overshoot instead of closing,
// a few quick hatch strokes on the shadow side. Each panel runs through a displacement filter whose noise seed
// changes a few times a second while the panel is open, so the lines "boil" like hand-drawn animation.

type P = [number, number];

/** A seeded random stream, so a drawing looks the same every time it is built. */
const rng = (seed: number) => {
  let n = seed * 7919 + 13;
  return () => ((n = (n * 16807) % 2147483647) / 2147483647);
};

/** Smooth a hand-placed polyline (Catmull-Rom), `k` samples per span. */
function smooth(pts: P[], k = 6): P[] {
  if (pts.length < 3) return pts;
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
 * back over it once, a little off and lighter. */
function pen(pts: P[], w = 1.3, seed = 1, twice = true): string {
  const r = rng(seed);
  let d = '';
  for (let pass = 0; pass < (twice ? 2 : 1); pass++) {
    const drift = pass ? 0.8 : 0.25;
    const s = smooth(pts.map(([x, y]) => [x + (r() - 0.5) * drift, y + (r() - 0.5) * drift] as P));
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
function loop(cx: number, cy: number, rx: number, ry: number, rot = 0, turns = 1.15, a0 = -2): P[] {
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
const place = (pts: P[], dx: number, dy: number, deg = 0, k = 1): P[] => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return pts.map(([x, y]) => [dx + k * (x * c - y * s), dy + k * (x * s + y * c)]);
};

/** A smooth closed shape, used for the watercolour washes (no outline). */
const blob = (pts: P[]) => `M${smooth(pts).map(([x, y]) => `${f1(x)} ${f1(y)}`).join('L')}Z`;

/** A few quick parallel strokes, as a hand shades one side of a shape. */
const hatch = (x: number, y: number, n: number, dx: number, len: number, slant: number, seed: number) => {
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
  /** Anything that moves or needs its own element (wings that flap, marks that appear). */
  extra?: string;
}

/** Each animal's winter (panel 1) and coming out (panel 3). Panel 2, warm days adding up, is shared. */
function creatureArt(kind: Explainer['creature'], moving: boolean): [Art, Art] {
  if (kind === 'firefly') {
    const grub = [8, 16, 24, 32].map((x, i) => pen([[34 + x - 8, 62], [34 + x - 4, 58], [34 + x, 62]], 1.1, 40 + i)).join('');
    const bug = place([[0, -11], [3, -4], [3, 6], [0, 12], [-3, 6], [-3, -4], [0, -11]], 64, 34);
    return [
      {
        wash: `<path class="wash tan" d="${blob(loop(50, 62, 18, 5, 0, 1))}"/>`,
        ink: flake(20, 16, 1, 1) + flake(76, 22, 0.8, 4) + pen([[8, 46], [30, 44], [52, 46], [92, 44]], 1.2, 7) +
          hatch(14, 54, 3, 22, 2, 1, 9) + grub + pen([[34, 62], [50, 65], [66, 62]], 0.8, 50) + pen(loop(25, 61, 2, 2), 0.9, 51),
        extra: '<text class="note" x="68" y="56" transform="rotate(-8 68 56)">zzz</text>',
      },
      {
        wash: `<path class="wash sun" d="${blob(loop(65, 45, 8, 8, 0, 1))}"/>`,
        ink: pen([[14, 70], [30, 68], [44, 70]], 1.1, 60) + pen(bug, 1.3, 61) +
          ([[-8, 0], [-6, 6], [0, 9], [6, 6], [8, 0]] as P[]).map(([x, y], i) => pen([[65 + x, 45 + y], [65 + x * 1.5, 45 + y * 1.5]], 0.7, 70 + i, false)).join(''),
        extra: `<g class="flap" style="transform-origin:64px 30px">${pen(place([[1, -6], [8, -9], [12, -2], [9, 6], [2, 4]], 64, 30), 1, 62)}${pen(place([[-1, -6], [-8, -9], [-12, -2], [-9, 6], [-2, 4]], 64, 30), 1, 63)}</g>`,
      },
    ];
  }
  // Moth. Winter: a cocoon under a curled leaf. Then: the split cocoon, and the moth resting above it.
  const M = (pts: P[]) => place(pts, 70, 27, -10, 0.95);
  const wings = MOTH.wings.map((w, i) => pen(M(w), i === 1 ? 0.6 : 1.2, 80 + i)).join('') +
    MOTH.spots.map((s, i) => pen(M(s), 0.8, 90 + i, false)).join('');
  return [
    {
      wash: `<path class="wash tan" d="${blob(loop(56, 63.5, 11, 5, -0.35, 1))}"/>`,
      // An oak leaf on the ground, with the cocoon tucked against it; silk wraps round the cocoon.
      ink: flake(18, 16, 1, 1) + flake(80, 22, 0.75, 4) +
        pen([[8, 71], [13, 63], [11, 57], [18, 56], [19, 49], [26, 50], [29, 43], [35, 46], [41, 41], [44, 49], [51, 50], [47, 57], [53, 61], [45, 66], [30, 70], [9, 71]], 1.2, 10) +
        pen([[9, 71], [4, 74]], 1, 11, false) +
        pen([[10, 70], [26, 58], [42, 45]], 0.7, 12, false) +
        pen([[19, 63], [15, 59]], 0.5, 17, false) + pen([[26, 58], [22, 52]], 0.5, 18, false) + pen([[33, 52], [32, 46]], 0.5, 19, false) +
        pen([[27, 59], [37, 58], [46, 60]], 0.5, 25, false) +
        pen(loop(54, 62, 12, 5.5, -0.35, 1.2, 0.6), 1.4, 13) +
        pen([[47, 61], [50, 66.5], [49, 70]], 0.6, 26, false) + pen([[53, 57], [56, 63], [55, 68]], 0.6, 27, false) + pen([[59, 55], [62, 60], [62, 64]], 0.6, 28, false) +
        hatch(52, 69, 5, 2.4, 4, 1.2, 14) +
        pen([[22, 74], [42, 73], [58, 74.5]], 0.8, 15, false) + pen([[66, 73], [80, 72]], 0.8, 16, false),
      extra: '<text class="note" x="68" y="48" transform="rotate(-8 68 48)">zzz</text>',
    },
    {
      wash: `<path class="wash leaf" d="${MOTH.wash.map((w) => blob(M(w).map(([x, y]) => [x + 2, y + 1.5] as P))).join('')}"/>`,
      // The same cocoon as in winter, its top torn open.
      ink: pen(loop(28, 64, 12, 5.5, -0.35, 0.5, 0), 1.4, 20) +
        pen([[16.7, 68.1], [19, 64.5], [21.5, 66.5], [24, 62.5], [27, 64.5], [30, 60.5], [33, 62.5], [36, 58.5], [39.3, 59.9]], 0.7, 21, false) +
        pen([[22, 69], [25, 66]], 0.5, 25, false) + pen([[32, 65], [34, 62]], 0.5, 26, false) +
        hatch(25, 72, 4, 2.6, 4, 1.2, 22) +
        pen([[8, 75], [28, 74], [46, 75.5]], 0.8, 23, false) +
        MOTH.body.map((b, i) => pen(M(b), i < 2 ? 1.1 : 0.7, 30 + i)).join('') +
        pen([[87, 40], [91, 37]], 0.7, 35, false) + pen([[88, 47], [93, 46]], 0.7, 36, false),
      extra: `<path class="trail" d="M32 57c0-12 8-20 22-22"/>
        <g class="${moving ? 'flap' : ''}" style="transform-origin:70px 27px">${`<path class="pen" d="${wings}"/>`}</g>`,
    },
  ];
}

/** Panel 2: warm days counted as tally marks from March 1, until a little flag says "enough!". Hotter days are
 * pressed harder. When moving, the marks go down one bunch at a time, then the flag, then it all stays a while. */
function tally(moving: boolean): Art {
  const sun = pen(loop(14, 15, 6, 6, 0, 1.25), 1.3, 1) +
    [[15, 9], [55, 7], [100, 10], [150, 6], [-25, 8]]
      .map(([deg, len], i) => {
        const a = (deg! * Math.PI) / 180;
        return pen([[14 + 9 * Math.cos(a), 15 + 9 * Math.sin(a)], [14 + (9 + len!) * Math.cos(a), 15 + (9 + len!) * Math.sin(a)]], 0.9, 3 + i, false);
      })
      .join('');
  const groups: [number, number][] = [[32, 44], [46, 44], [60, 44], [74, 44], [10, 66], [24, 66], [38, 66]];
  const hot = new Set([2, 3, 5]);
  const r = rng(5);
  const at = (i: number) => (0.04 + i * 0.07).toFixed(2);
  const show = (t: string) =>
    moving ? `<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;${t};${(+t + 0.02).toFixed(2)};0.95;1" dur="10s" repeatCount="indefinite"/>` : '';
  const marks = groups
    .map(([x, y], i) => {
      const w = hot.has(i) ? 1.7 : 1.1;
      let d = '';
      for (let k = 0; k < 4; k++) {
        const x0 = x + k * 2.6 + (r() - 0.5) * 0.6;
        d += pen([[x0, y + (r() - 0.5)], [x0 + (r() - 0.3) * 2.4, y - 10 - 2 * r()]], w, 100 + i * 9 + k, false);
      }
      d += pen([[x - 1.5, y - 2], [x + 10, y - 9.5]], w, 100 + i * 9 + 5, false);
      return `<path class="pen" d="${d}">${show(at(i))}</path>`;
    })
    .join('');
  const flag = pen([[55, 74], [56, 60], [55.5, 46]], 1.2, 40) + pen([[55.5, 46], [65, 48.5], [56, 53]], 1, 41);
  return {
    wash: '<path class="wash sun" d="' + blob(loop(16, 17, 5.5, 5.5, 0, 1)) + '"/>',
    ink: sun,
    // A key by the sun: a warm day earns a mark, a hot day several.
    extra: `<text class="note small" x="34" y="15" transform="rotate(-3 34 15)">warm day =</text>
      <text class="note small" x="34" y="26" transform="rotate(-3 34 26)">hot day =</text>
      <path class="pen" d="${pen([[80, 16], [81, 8]], 1.1, 50, false)}${[0, 1, 2].map((k) => pen([[75 + k * 3, 27], [76 + k * 3, 19]], 1.6, 51 + k, false)).join('')}"/>
      <text class="note small" x="3" y="41" transform="rotate(-5 3 41)">Mar 1</text>${marks}
      <g><path class="wash warn" d="${blob([[56.5, 47], [64, 49], [57, 52]])}"/><path class="pen" d="${flag}"/><text class="note warn" x="59" y="66" transform="rotate(-6 59 66)">enough!</text>${show(at(7.5))}</g>`,
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
  const [winter, out] = creatureArt(ex.creature, moving);
  const panes = [winter, tally(moving), out].map(
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
