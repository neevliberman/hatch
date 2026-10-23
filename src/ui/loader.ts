import { loop, pen as fullPen, type P } from './sketch';

// The About panel's pen, with fewer samples per span: at this size more would only add bytes to the page.
const pen = (pts: P[], w: number, seed: number, twice = true) => fullPen(pts, w, seed, twice, 2);

// The loading note: a pen-drawn caterpillar inching round a pencilled circle, beside "Warming up the map…".
// Drawn once at build time (see vite.config.ts) and written into index.html, so it shows while the map's code is
// still downloading. The inching is CSS only (#loader in src/style.css): each segment sits at its own share of the
// body (--k), and the middle ones lift (--b) as the tail catches up with the head.

const R = 24; // where the segments' centres ride (src/style.css moves them there)
const N = 7;
const BODY = 6.6;
const TRACK = R - BODY - 2; // where the feet land: the pencilled circle the caterpillar inches round

/** One body segment drawn around (0, 0), facing +x (the way it walks), with two feet reaching in to the track. */
const segment = (seed: number, head = false): string => {
  const r = head ? BODY + 1 : BODY;
  const k = r / 5.4; // the face was drawn for a 5.4 head
  const feet: P[][] = head ? [] : [[[-2.2, r * 0.78], [-2.9, r + 2]], [[2, r * 0.8], [1.4, r + 2]]];
  const face = head
    ? pen([[1.5 * k, -4.6 * k], [3.4 * k, -7.4 * k], [5.6 * k, -8.6 * k]], 0.8, seed + 5, false) +
      pen([[-0.6 * k, -5 * k], [0, -8.2 * k], [1.4 * k, -9.8 * k]], 0.8, seed + 6, false) + pen(loop(2.4 * k, -1.2 * k, 1, 1, 0, 1.2), 1, seed + 7, false)
    : '';
  return `<ellipse class="wash" cx=".8" cy=".7" rx="${+(r - 0.5).toFixed(1)}" ry="${+(r * 0.85).toFixed(1)}"/><path class="pen" d="${
    pen(loop(0, 0, r, r * 0.9, 0.3, 1.15, seed), head ? 1.5 : 1.3, seed, head) + feet.map((f, i) => pen(f, 0.8, seed + 2 + i, false)).join('') + face
  }"/>`;
};

/** The track: a pencilled circle in short dashes, so it reads as a path walked round, not a ball. */
const track = () =>
  Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * 2 * Math.PI;
    return pen([0, 0.07, 0.14].map((d): P => [TRACK * Math.cos(a + d), TRACK * Math.sin(a + d)]), 0.7, 3 + i, false);
  }).join('');

export function loaderHtml(): string {
  // Two body drawings used in turn, so the segments don't look stamped; the head is drawn on its own.
  const segs = Array.from({ length: N }, (_, i) => {
    const k = i / (N - 1);
    const look = i === N - 1 ? segment(37, true) : `<use href="#cat-${'ab'[i % 2]}"/>`;
    return `<g style="--k:${+k.toFixed(3)};--b:${+Math.sin(Math.PI * k).toFixed(2)}">${look}</g>`;
  }).join('');
  return `<div id="loader"><svg viewBox="-40 -40 80 80" width="120" height="120" aria-hidden="true">
    <filter id="cat-boil" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="2" seed="2"/>
    <feDisplacementMap in="SourceGraphic" scale="1.4" xChannelSelector="R" yChannelSelector="G"/></filter>
    <defs><g id="cat-a">${segment(11)}</g><g id="cat-b">${segment(23)}</g></defs>
    <g filter="url(#cat-boil)"><path class="cat-path" d="${track()}"/><g class="walk">${segs}</g></g>
  </svg><p>Warming up the map…</p></div>`;
}
