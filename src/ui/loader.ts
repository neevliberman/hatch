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

const f1 = (v: number) => +v.toFixed(1);
const smooth = (p: number) => p * p * (3 - 2 * p);

/** The drawings reused by every frame: three takes of each kind of segment, of the head, and of the leaf's strokes. */
function defs(): string {
  let d = '';
  for (let t = 0; t < TAKES; t++) {
    for (const c of ['y', 'w'] as const) {
      const seed = 11 + t * 7 + (c === 'w' ? 3 : 0);
      d += `<g id="c${c}${t}"><ellipse style="fill:${c === 'y' ? '#e6b93c' : '#f1ead6'}" cx=".5" cy=".5" rx="4.1" ry="5"/><path style="fill:var(--text)" d="${pen(loop(0, 0, 0.9, 4.2, 0, 1, -1.6), 1.2, seed + 1, false)}"/>` +
        `<path style="fill:var(--text)" d="${pen(loop(0, 0, 4.4, 5.3, 0.3, 1.15, seed), 1, seed, true)}"/>` +
        `<path style="fill:var(--text)" d="${pen([[-1.2, 4.6], [-1.6, 6.4]], 0.8, seed + 2, false)}${pen([[1.4, 4.7], [1.9, 6.4]], 0.8, seed + 3, false)}"/></g>`;
    }
    // The head: darker, a yellow-and-white face, an eye, and the two filaments that curl up and forward.
    d += `<g id="ch${t}"><ellipse style="fill:#4a3b2a" cx=".5" cy=".6" rx="4.8" ry="5.2"/><path style="fill:var(--text)" d="${pen(loop(0, 0, 5, 5.4, 0.2, 1.15, 40 + t), 1.3, 40 + t, true)}"/>` +
      `<path style="fill:#e6b93c" d="${pen([[1.2, -3.6], [2.6, -1.2], [2.4, 1.8]], 1.2, 50 + t, false)}"/>` +
      `<circle style="fill:var(--text)" cx="2.9" cy="-1.1" r=".9"/>` +
      `<path style="fill:var(--text)" d="${pen([[-0.5, -4.6], [0.6, -8.4], [3.4, -10.6]], 0.8, 60 + t, false)}"/></g>`;
    // The tail's filament, on the first segment.
    d += `<path id="cf${t}" style="fill:var(--text)" d="${pen([[-1, -4.6], [-2.6, -8.2], [-5.4, -9.8]], 0.8, 70 + t, false)}"/>`;
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
  let g = `<rect class="leaf" x="-6" y="${GROUND + 1.5}" width="${W + 12}" height="11" rx="4"/>`;
  g += `<path style="fill:var(--text)" d="${pen([[-8, GROUND + 1.2], [W / 2, GROUND + 0.6], [W + 8, GROUND + 1.4]], 1.1, 80 + take, true)}"/>`;
  g += `<path class="rib" d="${pen([[-8, GROUND + 7], [W / 2, GROUND + 6.4], [W + 8, GROUND + 7.2]], 0.9, 90 + take, false)}"/>`;
  // Veins every STEP along the leaf: they are what slides past as it walks.
  for (let n = -2; n <= 9; n++) {
    const x = n * STEP + ox;
    if (x < -10 || x > W + 10) continue;
    g += `<path class="rib" d="${pen([[x, GROUND + 6.8], [x + 3.2, GROUND + 9.2], [x + 6, GROUND + 11]], 0.7, 100 + n + take * 5, false)}"/>`;
  }
  let body = '';
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1);
    const x = tail + (head - tail) * k + ox;
    const y = GROUND - 5 - 9 * bunch * Math.sin(Math.PI * k) * 0.8;
    const look = i === N - 1 ? `ch${take}` : `c${i % 2 ? 'w' : 'y'}${(take + i) % TAKES}`;
    body += `<use href="#${look}" x="${f1(x)}" y="${f1(y)}"/>`;
    if (i === 1) body += `<use href="#cf${take}" x="${f1(x)}" y="${f1(y)}"/>`;
  }
  return `<svg x="${f * W}" y="0" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}${body}</svg>`;
}

export function loaderHtml(): string {
  const frames = Array.from({ length: FRAMES }, (_, f) => frame(f)).join('');
  return `<div id="loader"><div class="cat" aria-hidden="true"><svg class="strip" width="${FRAMES * 150}" height="84" viewBox="0 0 ${FRAMES * W} ${H}"><defs>${defs()}</defs>${frames}</svg></div><p>Warming up the map…</p></div>`;
}
