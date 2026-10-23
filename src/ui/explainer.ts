import type { CaveatCard, Explainer, SpotStory } from '../core/layer';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// The picture strip is drawn like a quick pen sketch in a field notebook. Every line is inked twice more, a little
// off, the way a hand goes back over a line; then each panel runs through a displacement filter whose noise seed
// changes a few times a second, so the lines "boil" like hand-drawn animation (see boil() below).
const ink = (d: string, cls = '') => {
  const c = cls ? ` ${cls}` : '';
  return `<path d="${d}"${cls ? ` class="${cls}"` : ''}/><path d="${d}" class="ghost${c}" transform="translate(.9 -.7)"/>` +
    `<path d="${d}" class="ghost${c}" transform="translate(-.6 .8)"/>`;
};

/** Pen shading inside an ellipse centred on (cx, cy): a zigzag scribble, or with `box`, a box of quick parallel
 * hatch strokes. Seeded, so it holds still between renders. */
function scribble(cx: number, cy: number, rx: number, ry: number, step: number, seed: number, box = false): string {
  let n = seed;
  const r = () => ((n = (n * 16807) % 2147483647) / 2147483647);
  const f = (v: number) => v.toFixed(1);
  let d = '';
  for (let x = -rx + step / 2, up = true; x < rx; x += step, up = !up) {
    const h = (box ? ry : ry * Math.sqrt(1 - (x / rx) ** 2)) * (0.72 + 0.28 * r());
    const px = cx + x + (r() - 0.5) * step;
    d += box ? `M${f(px - h * 0.4)} ${f(cy + h)}L${f(px + h * 0.4)} ${f(cy - h)}` : `${d ? 'L' : 'M'}${f(px)} ${f(cy + (up ? -h : h))}`;
  }
  return `<path class="scr" d="${d}"/>`;
}

const GROUND = 'M6 68c14-3 26 2 40-1s30 2 50-1';
const flake = ([x, y]: [number, number]) => `M${x - 2.5} ${y}h5M${x} ${y - 2.5}v5M${x - 1.8} ${y - 1.8}l3.6 3.6M${x + 1.8} ${y - 1.8}l-3.6 3.6`;
const SNOW = ([[16, 14], [42, 9], [74, 16], [60, 30], [26, 32], [88, 36]] as [number, number][]).map(flake).join('');

// Each animal: how it waits out winter (panel 1), where it climbs out from (panel 3), and the adult, drawn around
// (0, 0) with the right wings separate so they can be mirrored and flap. All in a 100 x 84 panel.
const CREATURES: Record<Explainer['creature'], { winter: string; start: string; wing: string; body: string }> = {
  moth: {
    // A cocoon wrapped in silk, lying in the fallen leaves.
    winter: `${ink(SNOW, 'snow')}${ink(GROUND)}${ink('M10 66c5-8 15-9 21-5-4 6-13 8-21 5ZM11 66l18-4')}
      ${ink('M64 66c6-6 16-6 22-1-6 5-15 5-22 1ZM65 66l20-1')}
      <g transform="rotate(-10 46 56)"><ellipse class="wash tan" cx="47" cy="57" rx="14" ry="8"/>${scribble(46, 56, 13, 7, 1.7, 7)}
      ${ink('M32 56C32 50 40 48 46 48S60 51 60 56 52 64 46 64 32 62 32 56Z')}${ink('M39 49c2 4 2 10 0 14M46 48c2 5 2 11 0 16M53 49c2 4 2 10 0 14', 'thin')}</g>
      <text class="note" x="64" y="46" transform="rotate(-12 64 46)">z z z</text>`,
    // The empty cocoon, split open.
    start: `<g transform="translate(26 62)">${scribble(0, 3, 10, 3, 1.3, 3)}${ink('M-12-1C-12 5-4 7 2 6S12 2 12-2')}${ink('M-12-2C-10-9 0-11 6-7')}</g>`,
    // Luna moth: pale green wings, an eyespot on each, and long curling tails on the hind wings.
    wing: `<path class="wash leaf" d="M1-5C6-15 17-20 25-16 27-10 18-3 1-1ZM1 0C9 0 17 5 15 11 13 15 9 17 8 22 7 28 9 33 12 37 6 34 3 26 3 18 2 12 1 6 1 0Z"/>
      ${ink('M1-5C6-15 17-20 25-16 27-10 18-3 1-1Z')}${ink('M1 0C9 0 17 5 15 11 13 15 9 17 8 22 7 28 9 33 12 37 6 34 3 26 3 18 2 12 1 6 1 0Z')}
      ${ink('M4-4C10-10 16-13 22-14M3 2C8 5 11 9 11 13', 'thin')}<circle cx="14" cy="-9" r="2.2"/><circle cx="9" cy="8" r="1.8"/>`,
    body: `${ink('M0-8C2-8 2-3 2 2S1 11 0 11-2 6-2 2-2-8 0-8Z')}${scribble(0, 2, 1.6, 8, 1.1, 5, true)}
      ${ink('M-1-8C-3-13-6-15-9-14c-1 0-1 2 1 1M1-8C3-13 6-15 9-14c1 0 1 2-1 1', 'thin')}`,
  },
  firefly: {
    // A grub in the soil under the snow.
    winter: `${ink(SNOW, 'snow')}${ink('M6 44c14-3 26 2 40-1s30 2 50-1')}${ink('M14 52h.5M30 58h.5M70 54h.5M84 62h.5M22 72h.5M58 74h.5', 'thin')}
      <ellipse class="wash tan" cx="50" cy="62" rx="17" ry="5"/>${ink('M34 62c2-4 6-4 8 0 2-4 6-4 8 0 2-4 6-4 8 0 2-4 6-4 8 0M34 62c8 3 24 3 32 0')}
      ${ink('M33 61a2 2 0 1 0-.1 0')}<text class="note" x="66" y="56" transform="rotate(-12 66 56)">z z z</text>`,
    start: `<g transform="translate(26 64)">${ink('M-10 0c4-3 16-3 20 0')}${scribble(0, 2, 8, 2, 2, 3)}</g>`,
    wing: `${ink('M1-6C7-8 12-2 10 8 8 12 3 10 1 6Z')}${scribble(5, 2, 3.5, 6, 1.6, 9)}`,
    body: `<circle class="wash sun" cx="0" cy="8" r="8"/>${ink('M0-11C3-11 3-4 3 2S2 12 0 12-3 8-3 2-3-11 0-11Z')}
      ${ink('M-6 13l-3 3M6 13l3 3M0 17v4M-8 7h-4M8 7h4', 'thin')}${ink('M-1-11l-4-5M1-11l4-5', 'thin')}`,
  },
};

/** A hand-drawn frame for one panel. */
const FRAME = 'M3 5C30 3 66 6 97 4 96 30 98 56 96 80 66 82 32 79 4 81 5 56 2 30 3 5Z';

function panes(fid: string, ex: Explainer, moving: boolean): string[] {
  const c = CREATURES[ex.creature];
  // Warm days stack up in the jar, hotter days taller, until the top block pokes over the "enough" line; it fills in
  // about four seconds, then stays full for most of the loop.
  const days = [5, 7, 4, 8, 6, 10];
  let top = 74;
  const blocks = days
    .map((h, i) => {
      top -= h;
      const at = (0.03 + i * 0.07).toFixed(2);
      const show = moving
        ? `<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;${at};${(+at + 0.02).toFixed(2)};0.95;1" dur="10s" repeatCount="indefinite"/>`
        : '';
      return `<g>${show}<rect class="wash sun" x="62" y="${top}" width="22" height="${h}"/>${scribble(73, top + h / 2, 10, h / 2 - 0.6, 2.2, 11 + i, true)}
        ${ink(`M62 ${top}c7 .6 15-.6 22 0`, 'thin')}</g>`;
    })
    .join('');
  // Warmth drips from the sun into the jar; held still along the way for reduced motion.
  const drops = [0, 1, 2]
    .map((i) =>
      moving
        ? `<circle class="drop" r="1.6" cx="30" cy="22" style="animation-delay:${i * 0.8}s"/>`
        : `<circle class="drop still" r="1.6" cx="${32 + i * 13}" cy="${[19, 15, 18][i]}"/>`,
    )
    .join('');
  const sun = `<circle class="wash sun" cx="16" cy="14" r="7"/>${ink('M9 14c0-5 3-7 7-7s7 3 7 7-3 7-7 7-7-3-7-7Z')}
    ${ink(Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      const p = (r: number) => `${(16 + r * Math.cos(a)).toFixed(1)} ${(14 + r * Math.sin(a)).toFixed(1)}`;
      return `M${p(10)}L${p(14)}`;
    }).join(''), 'thin')}`;
  const jar = `${blocks}${ink('M61 20c1 18-1 36 0 54 8 1 16-1 24 0-1-18 1-36 0-54')}${ink('M54 36c13 .5 26-.5 38 0', 'dash')}
    <text class="note" x="57" y="33" text-anchor="end">enough</text>`;
  const trail = '<path class="trail" d="M28 56c6-14-10-18 2-28s22 2 30-4"/>';
  const bug = `<g transform="translate(70 30) scale(.85)"><g class="flap">${c.wing}<g transform="scale(-1,1)">${c.wing}</g></g>${c.body}</g>`;
  return [
    `${c.winter}`,
    `${sun}${drops}${jar}`,
    `${ink(GROUND)}${c.start}${trail}${bug}`,
  ].map((art) => `<svg class="ex-pane" viewBox="0 0 100 84" aria-hidden="true"><g filter="url(#${fid})">${ink(FRAME, 'frame')}${art}</g></svg>`);
}

/** The picture strip: three sketched panels (winter, warmth adds up, out they come), each over its caption. */
function strip(id: string, ex: Explainer): string {
  const fid = `ex-boil-${id.replace(/[^\w-]/g, '')}`;
  const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  boil();
  const art = panes(fid, ex, moving);
  // The captions say the same thing in words, so screen readers skip the drawings.
  return `<svg class="ex-defs" aria-hidden="true" focusable="false"><filter id="${fid}" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="1"/>
      <feDisplacementMap in="SourceGraphic" scale="2.2" xChannelSelector="R" yChannelSelector="G"/></filter></svg>
    <ol class="ex-steps">${ex.steps.map((s, i) => `<li><div class="ex-pic">${art[i]}${i < 2 ? '<span class="ex-then" aria-hidden="true">\u2192</span>' : ''}</div><b>${esc(s.title)}</b>${esc(s.text)}</li>`).join('')}</ol>`;
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
  }, 140);
}

/** Cities for the spot picker, so keyboard and screen-reader users can choose a place without the map. South to north. */
export const CITIES = [
  { name: 'Carbondale, IL', lat: 37.73, lng: -89.22 },
  { name: 'Cincinnati, OH', lat: 39.1, lng: -84.51 },
  { name: 'Indianapolis, IN', lat: 39.77, lng: -86.16 },
  { name: 'Springfield, IL', lat: 39.8, lng: -89.65 },
  { name: 'Columbus, OH', lat: 39.96, lng: -83.0 },
  { name: 'Des Moines, IA', lat: 41.59, lng: -93.62 },
  { name: 'Cleveland, OH', lat: 41.5, lng: -81.69 },
  { name: 'Chicago, IL', lat: 41.88, lng: -87.63 },
  { name: 'Detroit, MI', lat: 42.33, lng: -83.05 },
  { name: 'Grand Rapids, MI', lat: 42.96, lng: -85.67 },
  { name: 'Madison, WI', lat: 43.07, lng: -89.4 },
  { name: 'Milwaukee, WI', lat: 43.04, lng: -87.91 },
  { name: 'Minneapolis, MN', lat: 44.98, lng: -93.27 },
  { name: 'Marquette, MI', lat: 46.54, lng: -87.4 },
  { name: 'Duluth, MN', lat: 46.79, lng: -92.1 },
];

/** One place's season as a strip: coloured stages, ticks for real sightings, a marker on today. */
export function spotHtml(s: SpotStory | null): string {
  if (!s) return '<p class="muted">No forecast here. Hatch covers land in seven Midwest states.</p>';
  const [a, b] = s.span;
  const pct = (d: number) => `${(((Math.min(b, Math.max(a, d)) - a) / (b - a)) * 100).toFixed(2)}%`;
  const width = (from: number, to: number) => `${(((Math.min(b, to) - Math.max(a, from)) / (b - a)) * 100).toFixed(2)}%`;
  const segs = s.segments
    .filter((g) => g.to > a && g.from < b)
    .map((g) => `<i class="seg" title="${esc(g.label)}" style="left:${pct(g.from)};width:${width(g.from, g.to)};background:${g.color}"></i>`)
    .join('');
  const shown = s.ticks.filter((d) => d >= a && d <= b);
  const ticks = shown
    .map((d) => `<i class="tick-s" style="left:${pct(d)}"></i>`)
    .join('');
  const months = s.months
    .filter((m) => m.doy >= a && m.doy < b)
    .map((m) => `<span style="left:${pct(m.doy)}">${esc(m.label)}</span>`)
    .join('');
  return `<div class="spot-title">${esc(s.title)}</div>
    <p class="spot-say">${esc(s.sentence)}</p>
    <div class="spot-strip" aria-hidden="true">${segs}${ticks}<b class="today" style="left:${pct(s.today)}"></b></div>
    <div class="spot-axis" aria-hidden="true">${months}</div>
    <div class="spot-key">${s.segments
      .map((g) => `<span><i class="k-seg" style="background:${g.color}"></i>${esc(g.label)}</span>`)
      .join('')}<span><i class="k-tick"></i>real sighting (${shown.length} here)</span><span><i class="k-today"></i>the date you picked</span></div>`;
}

/** The whole species section of the drawer. Its spot card is filled separately, so it can follow the map. */
export function explainerHtml(id: string, ex: Explainer, cav: CaveatCard): string {
  const score = ex.score;
  const max = score ? Math.max(...score.bars.map((x) => x.days)) : 1;
  return `<section class="ex" style="--ac:${esc(ex.accent)}">
    <h3 class="ex-name">${esc(ex.name)} <i>${esc(ex.sci)}</i></h3>
    <p class="ex-hook">${esc(ex.hook)}</p>
    <figure class="ex-fig">${strip(id, ex)}</figure>
    <div class="ex-spot"><p class="ex-intro">${esc(ex.spotIntro)}<span class="phone-only"> Close this panel first.</span></p>
      <label class="ex-place">Or pick a city <select data-place><option value="">Choose…</option>${CITIES.map(
        (c) => `<option value="${c.lat},${c.lng}">${esc(c.name)}</option>`,
      ).join('')}</select></label>
      <div data-spot="${esc(id)}"></div></div>
    ${
      score
        ? `<div class="ex-score" data-why><div class="ex-h">${esc(score.title)}</div>
        <div class="ex-sub">Days off, on average. Shorter is better.</div>
        ${score.bars
          .map(
            (x) => `<div class="bar-l"><span>${esc(x.label)}</span><i class="${x.best ? 'best' : ''}" style="width:${((x.days / max) * 100).toFixed(1)}%"></i>
            <b>${x.days.toFixed(1)} days</b></div>`,
          )
          .join('')}
        <p>${esc(score.text)}</p></div>`
        : ''
    }
    <details class="ex-fine" data-key="fine-${esc(id)}"><summary>${esc(ex.finePrintLabel)}</summary>
      <ul>${cav.bullets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>
  </section>`;
}
