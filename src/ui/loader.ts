import { loop, pen as fullPen, type P } from './sketch';

// The loading note: a monarch caterpillar inching along a milkweed leaf, pen and watercolour like Exo, beside "Warming up the map…".
// Drawn once at build time (see vite.config.ts) and written into index.html, so it shows while the map's code is still
// downloading. It must keep moving while the page is busy (parsing the map's code, setting up WebGL), so it is a flip
// book: 12 hand-drawn frames side by side in one strip, and CSS steps the strip along (#loader .strip in src/style.css).
// A transform animation on an HTML element runs on the compositor, off the main thread, so it never stalls the way a
// filter or an SVG animation does. The ink "boils" because every frame is its own set of takes.

const pen = (pts: P[], w: number, seed: number, twice = true) => fullPen(pts, w, seed, twice, 2);

const FRAMES = 12;
const W = 100; // one frame is W x H units
const H = 56;
const N = 8; // body segments; the last is the head
const GROUND = 40; // the leaf's edge
const STEP = 14; // how far one inch carries it, and the spacing of the leaf's veins
const D0 = 42; // tail-to-head when stretched
const D1 = D0 - STEP; // when bunched
const TAKES = 3;
const CREAM = '#f7f3e6';

const f1 = (v: number) => +v.toFixed(1);
const smooth = (p: number) => p * p * (3 - 2 * p);

/** The drawings reused by every frame: three takes of a segment's bands, of the head, and of the tail filament. */
function defs(): string {
  let d = '';
  for (let t = 0; t < TAKES; t++) {
    const seed = 11 + t * 7;
    // One segment's bands: a black band with a cream one either side, and two prolegs. The body itself is one wash (see frame()).
    d += `<g id="b${t}"><path style="fill:${CREAM}" d="${pen([[-1.9, -4.4], [-2.2, 0], [-1.9, 4.4]], 0.7, seed, false)}${pen([[1.9, -4.5], [2.2, 0], [1.9, 4.4]], 0.7, seed + 1, false)}"/>` +
      `<path style="fill:var(--text)" d="${pen([[0, -4.8], [0.3, 0], [0, 4.8]], 1.3, seed + 2, false)}${pen([[-1.2, 4.8], [-1.6, 6.4]], 0.5, seed + 3, false)}${pen([[1.4, 4.9], [1.9, 6.4]], 0.5, seed + 4, false)}"/></g>`;
    // The head: black, with cream face stripes, an eye, and the two filaments that curl up and forward.
    d += `<g id="h${t}"><ellipse style="fill:#26201a" cx=".5" cy=".6" rx="4.8" ry="5.2"/>` +
      `<path style="fill:${CREAM}" d="${pen([[0.8, -4], [2.4, -1.4], [2.2, 2.4]], 0.9, 50 + t, false)}${pen([[-1.4, -4.2], [-0.8, 0], [-1.2, 3.6]], 0.7, 53 + t, false)}"/>` +
      `<circle style="fill:${CREAM}" cx="3" cy="-1" r=".9"/>` +
      `<path style="fill:var(--text)" d="${pen(loop(0, 0, 5, 5.4, 0.2, 1.15, 40 + t), 0.8, 40 + t, true)}${pen([[-0.5, -4.6], [1, -9.4], [5.2, -13.4]], 0.6, 60 + t, false)}"/></g>`;
    d += `<path id="f${t}" style="fill:var(--text)" d="${pen([[-1, -4.6], [-2.6, -8.2], [-5.4, -9.8]], 0.6, 70 + t, false)}"/>`;
  }
  return d;
}

/** One frame of the cycle: the tail planted while the head reaches, then the head planted while the tail draws up. */
function frame(f: number): string {
  const t = f / FRAMES;
  const [tail, head] = t < 0.5 ? [0, D1 + STEP * smooth(t * 2)] : [STEP * smooth((t - 0.5) * 2), D0];
  const mid = (tail + head) / 2;
  const bunch = (D0 - (head - tail)) / STEP; // 0 stretched, 1 bunched
  const take = f % TAKES;
  const ox = W / 2 - mid; // ground x -> frame x
  // The leaf: a wash with a slightly curved edge, a drawn edge and midrib, and veins that differ in length and slant.
  let g = `<path style="fill:var(--wash-leaf);opacity:.65" d="M-8 ${GROUND + 1.8}Q50 ${GROUND + 0.4} 108 ${GROUND + 2.4}L108 ${GROUND + 12}Q50 ${GROUND + 15} -8 ${GROUND + 11}Z"/>`;
  g += `<path style="fill:var(--text)" d="${pen([[-8, GROUND + 1.6], [W / 2, GROUND + 0.7], [W + 8, GROUND + 1.8]], 0.7, 80 + take, true)}"/>`;
  g += `<path style="fill:var(--line-strong)" d="${pen([[-8, GROUND + 7], [W / 2, GROUND + 6.4], [W + 8, GROUND + 7.2]], 0.6, 90 + take, false)}`;
  for (let n = -2; n <= 9; n++) {
    const x = n * STEP + ox;
    if (x < -10 || x > W + 10) continue;
    const j = (n * 37 + 11) % 5; // a fixed wobble per vein, so the leaf is not a ruler
    g += pen([[x, GROUND + 6.8], [x + 2.6 + j * 0.3, GROUND + 9 + j * 0.2], [x + 5 + j * 0.5, GROUND + 10.6 + j * 0.2]], 0.5, 100 + n + take * 5, false);
  }
  g += '"/>';
  const c = Array.from({ length: N }, (_, i): P => {
    const k = i / (N - 1);
    return [tail + (head - tail) * k + ox, GROUND - 5 - 13 * bunch * Math.sin(Math.PI * k)];
  });
  // The body is one continuous wash, with a soft yellow bloom a little off it (the watercolour not quite on the lines),
  // inked along its top and underside; the bands and the head go over it.
  const line = c.map(([x, y]) => `${f1(x)} ${f1(y)}`).join('L');
  let body = `<path d="M${line}" style="fill:none;stroke:#e6b93c;stroke-width:10;stroke-linecap:round;stroke-linejoin:round"/>`;
  body += `<path d="M${c.map(([x, y]) => `${f1(x + 0.8)} ${f1(y + 0.9)}`).join('L')}" style="fill:none;stroke:#f2cf5a;stroke-width:9;stroke-linecap:round;stroke-linejoin:round;opacity:.35"/>`;
  body += `<path style="fill:var(--text)" d="${pen(c.map(([x, y]): P => [x, y - 5.1]), 0.7, 120 + take, true)}${pen(c.slice(0, -1).map(([x, y]): P => [x, y + 5.2]), 0.7, 125 + take, true)}"/>`;
  c.forEach(([x, y], i) => {
    if (i === N - 1) return;
    body += `<use href="#b${(take + i) % TAKES}" x="${f1(x)}" y="${f1(y)}"/>`;
    if (i === 1) body += `<use href="#f${take}" x="${f1(x)}" y="${f1(y)}"/>`;
  });
  body += `<use href="#h${take}" x="${f1(c[N - 1]![0])}" y="${f1(c[N - 1]![1])}"/>`;
  return `<svg x="${f * W}" y="0" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}${body}</svg>`;
}

export function loaderHtml(): string {
  const frames = Array.from({ length: FRAMES }, (_, f) => frame(f)).join('');
  return `<div id="loader"><div class="cat" aria-hidden="true"><svg class="strip" width="${FRAMES * 150}" height="84" viewBox="0 0 ${FRAMES * W} ${H}"><defs>${defs()}</defs>${frames}</svg></div><p>Warming up the map…</p></div>`;
}
