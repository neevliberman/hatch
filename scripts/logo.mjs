// The Hatch logo: a little bug peeking out of a cracked hexagon shell, drawn the way the About sketches are: ink pen
// lines on top, colour laid underneath as a loose wash that doesn't quite line up with the ink.
// Writes public/favicon.svg (tab icon, switches to a dark tile in dark mode) and public/icons/hatch.svg (app icon).
// Usage: npm run icons (this, then the PNGs)
import { writeFileSync } from 'node:fs';

const INK = '#2b241c', PAPER = '#f8f2e3', LEAF = '#a9cf7a', SUN = '#c07a16';
const INK_D = '#f1e8d6', PAPER_D = '#2a2620', LEAF_D = '#7fae58', SUN_D = '#e0932a';

const rng = (seed) => { let n = seed * 7919 + 13; return () => ((n = (n * 16807) % 2147483647) / 2147483647); };
const f = (v) => +v.toFixed(1);
const move = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);
const poly = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';

/** Smooth path through points (Catmull-Rom as cubic Béziers). */
function curve(p, closed) {
  const n = p.length, at = (i) => (closed ? p[(i + n) % n] : p[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [a, b, c, e] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f(b[0] + (c[0] - a[0]) / 6)} ${f(b[1] + (c[1] - a[1]) / 6)} ${f(c[0] - (e[0] - b[0]) / 6)} ${f(c[1] - (e[1] - b[1]) / 6)} ${f(c[0])} ${f(c[1])}`;
  }
  return d + (closed ? 'Z' : '');
}
/** A steady hand line along a polyline: each edge bows a little, the pen wanders slowly, corners turn round. */
function hand(verts, { closed = false, seed = 1, bow = 0.3, wander = 0.1, round = 0.7, step = 9 } = {}) {
  const r = rng(seed), out = [];
  const segs = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    const k = Math.max(1, Math.round(len / step)), arc = (r() - 0.5) * 2 * bow * Math.min(1, len / 16), ph = r() * 6;
    const wv = wander * Math.min(1, len / 16), cut = Math.min(round / len, 0.3);
    for (let j = 0; j <= k; j++) {
      if (j === k && (closed || i < segs - 1)) continue;
      let t = j / k;
      if (j === 0 && (closed || i > 0)) t = cut; else if (j === k) t = 1; else t = cut + (1 - 2 * cut) * t;
      if (j === 0 && !closed && i === 0) t = 0;
      const off = arc * Math.sin(Math.PI * t) + wv * Math.sin(ph + t * 5.3) * Math.sin(Math.PI * t);
      out.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]);
    }
    if (closed || i < segs - 1) out.push([a[0] + (b[0] - a[0]) * (1 - cut), a[1] + (b[1] - a[1]) * (1 - cut)]);
  }
  return curve(out, closed);
}
/** A filled, roughly round blob. */
function blob(cx, cy, rad, seed) {
  const r = rng(seed), ph = r() * 6;
  return curve(Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2, k = 1 + 0.035 * Math.sin(ph + a * 2); return [cx + rad * k * Math.cos(a), cy + rad * k * 0.96 * Math.sin(a)]; }), true);
}
/** The lower half of a pointy-top hexagon, its top edge cracked into a crown: peaks at both walls, k equal valleys. */
function shell({ cx = 32, cy = 36, r = 22, y = 30, k = 3, d = 5 }) {
  const hx = r * Math.cos(Math.PI / 6), L = [cx - hx, y], R = [cx + hx, y];
  const crown = Array.from({ length: 2 * k + 1 }, (_, i) => [L[0] + (2 * hx * i) / (2 * k), y + (i % 2 ? d : 0)]);
  return [L, [cx - hx, cy + r / 2], [cx, cy + r], [cx + hx, cy + r / 2], R, ...crown.slice(1, -1).reverse()];
}

/** The drawing, in a 64-unit box, coloured by class (ink, paper, leaf, sun) so one file can carry both themes.
 * `small` is the tab-size cut: heavier lines and a smaller offset between wash and ink. */
function art(small) {
  const W = small ? 4 : 2.5, off = small ? 1.6 : 2.6, hr = small ? 10 : 9.5;
  const s = shell(small ? { d: 6 } : {});
  const pen = (d, w = W) => `<path class="ink" d="${d}" stroke-width="${f(w)}"/>`;
  const head = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2; return [32 + hr * Math.cos(a), 31 + hr * 0.96 * Math.sin(a)]; });
  // The shell's wash: the shell shape nudged down-right and shrunk a touch, with a looser hand than the ink.
  const wash = move(s, off, off * 0.8).map(([x, y]) => [32 + (x - 32) * 0.93, 44 + (y - 44) * 0.93]);
  return [
    `<path class="sun" d="${blob(32 + off, 31 + off * 0.7, hr * 0.98, 23)}"/>`,
    pen(hand(head, { closed: true, seed: 24, bow: 0.2, round: 0.9 }), W * 0.9),
    `<path class="paper" d="${poly(s)}"/>`,
    `<path class="leaf" d="${hand(wash, { closed: true, seed: 25, bow: 0.6, wander: 0.4, round: 1.4 })}"/>`,
    pen(hand(s, { closed: true, seed: 9, bow: small ? 0.18 : 0.3 })),
    ...[-1, 1].map((g) => pen(hand([[32 + g * 3.5, 23], [32 + g * 6, 16], [32 + g * 10.5, 10.5], [32 + g * 14, 11.5]], { seed: 30 + g, bow: 0.2, wander: 0, round: 0.8 }), W * 0.9)),
  ].join('');
}
const style = (dark) => `.ink{fill:none;stroke:${INK};stroke-linecap:round;stroke-linejoin:round}.paper,.tile{fill:${PAPER}}` +
  `.leaf{fill:${LEAF};opacity:.9;mix-blend-mode:multiply}.sun{fill:${SUN};opacity:.85;mix-blend-mode:multiply}` +
  (dark ? `@media (prefers-color-scheme:dark){.ink{stroke:${INK_D}}.paper,.tile{fill:${PAPER_D}}.leaf{fill:${LEAF_D};opacity:.77;mix-blend-mode:normal}.sun{fill:${SUN_D};opacity:.72;mix-blend-mode:normal}}` : '');

// Tab icon: a rounded paper tile, the drawing a little larger than the app icon's so it holds up at 16 px.
writeFileSync('public/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>${style(true)}</style>` +
  `<rect class="tile" width="64" height="64" rx="13"/><g transform="translate(32 32) scale(1.08) translate(-32 -33)">${art(true)}</g></svg>\n`);
// App icon: square, full bleed (the phone rounds the corners), always the light version.
writeFileSync('public/icons/hatch.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>${style(false)}</style>` +
  `<rect class="tile" width="64" height="64"/><g transform="translate(32 32) scale(.9) translate(-32 -33)">${art(false)}</g></svg>\n`);
console.log('wrote public/favicon.svg, public/icons/hatch.svg');
