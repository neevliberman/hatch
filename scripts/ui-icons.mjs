// Draws the UI icons with the About sketches' pen (src/ui/sketch.ts), so one hand draws the whole app.
// Run once, paste the printed paths into index.html and src/ui/scrubber.ts: nothing is drawn at runtime.
//   node scripts/ui-icons.mjs
// Each icon is on a 24-unit grid. The pen's outlines are thinned (Ramer-Douglas-Peucker) and written as short
// relative moves to keep the bytes down.
import { pen, loop } from '../src/ui/sketch.ts';

const T = 0.1; // simplify tolerance, in grid units (under 0.1px on a 20px icon)

function simplify(pts) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let far = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
    if (d > far) (far = d), (at = i);
  }
  return far < T ? [a, b] : [...simplify(pts.slice(0, at + 1)).slice(0, -1), ...simplify(pts.slice(at))];
}

const num = (v) => (v / 10).toString().replace(/^(-?)0\./, '$1.');

/** Numbers in path shorthand: a minus, or a leading dot after a number that already has one, stands in for the
 * space ("0 .7" must keep its space or it reads back as 0.7). */
const pack = (nums) =>
  nums.map(num).reduce((s, n, i, all) => s + (!i || n[0] === '-' || (n[0] === '.' && all[i - 1].includes('.')) ? '' : ' ') + n, '');

/** pen()'s "M x y L x y ... Z" outlines, thinned and rewritten as relative moves in tenths. */
function compact(d) {
  let out = '';
  let cur = [0, 0];
  for (const sub of d.split('Z').filter(Boolean)) {
    const pts = sub.replace('M', '').split('L').map((s) => s.trim().split(' ').map((v) => Math.round(Number(v) * 10)));
    const thin = simplify(pts);
    // Every move is relative, the first from where the previous outline started (z took the pen back there).
    out += 'm' + pack([thin[0][0] - cur[0], thin[0][1] - cur[1]]);
    out += 'l' + pack(thin.slice(1).flatMap((p, i) => [p[0] - thin[i][0], p[1] - thin[i][1]])) + 'z';
    cur = thin[0];
  }
  return out.replace(/^m/, 'M');
}

const arc = (cx, cy, r, from, to, n = 12) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// A filled ink dot, a little lopsided (as pen()'s outline format, so compact() takes it).
const DOT = `M${loop(12, 12, 2, 1.8, 0.4, 1, 0).slice(0, -1).map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`;

// A filled wedge with a slightly uneven edge, for Play.
const wedge = 'M8.5 18.6L18.6 11.8L8.2 5.3Z';

const icons = {
  // My area: a crosshair whose circle overshoots, a dot gone round twice, four ticks.
  locate: pen(loop(12, 12, 6.6, 6.4, 0.2, 1.15), 2.2, 3) + DOT +
    pen([[12.2, 1], [11.9, 5.2]], 1.8, 5, false) + pen([[12, 18.8], [12.2, 23]], 1.8, 6, false) +
    pen([[1, 11.8], [5.2, 12.1]], 1.8, 7, false) + pen([[18.8, 12], [23, 11.8]], 1.8, 8, false),
  // Share: an arrow out of an open tray, the shaft drawn twice.
  share: pen([[12, 15.5], [12.1, 9], [12, 3]], 2, 11) + pen([[7.6, 7.4], [10, 5], [12, 3], [14.2, 5.1], [16.4, 7.3]], 2, 12, false) +
    pen([[6.4, 10.6], [5.8, 15], [6, 20.4], [12, 20.7], [18, 20.3], [18.1, 15], [17.7, 10.6]], 2, 13, false),
  // Back to the whole Midwest: four corners of a frame and a dot in the middle.
  recenter: [
    [[3.2, 8.6], [3, 5], [3.4, 3.2], [5, 3.1], [8.6, 3.3]],
    [[15.4, 3], [19, 3.2], [20.8, 3.3], [20.9, 5], [20.7, 8.6]],
    [[20.9, 15.4], [21, 19], [20.6, 20.8], [19, 20.9], [15.4, 20.7]],
    [[8.6, 21], [5, 20.8], [3.2, 20.6], [3.1, 19], [3.3, 15.4]],
  ].map((p, i) => pen(p, 2, 21 + i, false)).join('') + DOT,
  prev: pen([[15, 4.8], [11.4, 8.5], [8, 12.1], [11.6, 15.6], [15.2, 19.2]], 2.4, 31),
  next: pen([[9, 4.8], [12.6, 8.4], [16, 11.9], [12.5, 15.6], [8.8, 19.2]], 2.4, 32),
  // Play: a filled wedge with its three sides drawn over it as separate strokes (a closed stroke folds over itself at
  // the corners and leaves pinholes).
  play: wedge + pen([[8.1, 4.8], [13.4, 8.2], [19, 11.9]], 1.6, 71, false) + pen([[19, 11.7], [13.6, 15.3], [8.3, 19]], 1.6, 72, false) +
    pen([[8.5, 19.2], [8.2, 12], [8.3, 4.7]], 1.6, 73, false),
  pause: pen([[8.8, 5], [9, 12], [8.9, 19]], 4.2, 41) + pen([[15.1, 5.1], [15, 12], [15.2, 19]], 4.2, 42),
  // Replay: a loop drawn round the clock (anticlockwise) and an arrowhead where it ends.
  replay: (() => {
    const pts = arc(12, 12.6, 7.4, -40, 245, 14).map(([x, y]) => [24 - x, y]);
    const [e, b] = [pts[pts.length - 1], pts[pts.length - 2]];
    const len = Math.hypot(e[0] - b[0], e[1] - b[1]);
    const [dx, dy] = [(e[0] - b[0]) / len, (e[1] - b[1]) / len];
    const wing = (s) => [e[0] - 4 * dx + s * 3.6 * -dy, e[1] - 4 * dy + s * 3.6 * dx];
    return pen(pts, 2.2, 51) + pen([wing(1), e, wing(-1)], 2, 52, false);
  })(),
  cross: pen([[6.5, 6.4], [12, 12], [17.6, 17.5]], 2.2, 61, false) + pen([[17.5, 6.5], [12, 12], [6.4, 17.6]], 2.2, 62, false),
};

let total = 0;
for (const [k, d] of Object.entries(icons)) {
  const c = compact(d);
  total += c.length;
  console.log(`${k} (${c.length}):\n${c}\n`);
}
console.log(`total ${total} bytes`);
