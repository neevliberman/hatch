import type { CaveatCard, Explainer, SpotStory } from '../core/layer';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// The animals, drawn around (0, 0), about 60 units wide. Wings and body are separate so the wings can flap.
const CREATURES: Record<Explainer['creature'], { wings: string; body: string }> = {
  moth: {
    // Fore and hind wing on the right, mirrored for the left; the hind wing trails the long luna tail.
    wings: ['', ' transform="scale(-1,1)"']
      .map(
        (m) => `<g${m}>
          <path d="M1-3C9-15 23-16 27-9 25-1 13 2 1 1Z"/>
          <path d="M1 1C10 1 18 6 15 13 13 19 10 25 8 33 5 24 2 13 1 6Z"/>
          <circle cx="15" cy="-6" r="2.3" class="eye"/></g>`,
      )
      .join(''),
    body: '<ellipse rx="2" ry="8" class="body"/><path d="M-1-8l-5-6M1-8l5-6" class="feelers"/>',
  },
  firefly: {
    wings: ['', ' transform="scale(-1,1)"']
      .map((m) => `<g${m}><path d="M1-6C7-8 12-2 10 8 8 12 3 10 1 6Z"/></g>`)
      .join(''),
    body: '<ellipse rx="3" ry="11" class="body"/><ellipse cy="7" rx="3.4" ry="4.5" class="glow"/><path d="M-1-11l-4-5M1-11l4-5" class="feelers"/>',
  },
};

/** The looping picture strip: the sun pays warm days into a jar; when it is full, the animal flies out. */
function strip(id: string, ex: Explainer): string {
  const clip = `ex-jar-${id.replace(/[^\w-]/g, '')}`;
  const c = CREATURES[ex.creature];
  const coins = [0, 1, 2].map((i) => `<circle r="3.2" class="coin" style="animation-delay:${i * 0.9}s"/>`).join('');
  // The captions below say the same thing in words, so screen readers skip the drawing.
  return `<svg class="ex-art" viewBox="0 0 300 96" aria-hidden="true">
    <g transform="translate(50 42)" class="sun"><circle r="13"/>
      <g class="rays">${Array.from({ length: 8 }, (_, i) => `<path d="M0-18v-7" transform="rotate(${i * 45})"/>`).join('')}</g></g>
    <g transform="translate(82 42)">${coins}</g>
    <g transform="translate(150 42)" class="jar">
      <clipPath id="${clip}"><path d="M-17-20h34v34a8 8 0 0 1-8 8h-18a8 8 0 0 1-8-8Z"/></clipPath>
      <g clip-path="url(#${clip})"><rect class="fill" x="-20" y="-22" width="40" height="46"/></g>
      <path class="glass" d="M-17-20h34v34a8 8 0 0 1-8 8h-18a8 8 0 0 1-8-8Z"/>
      <path class="lid" d="M-20-24h40"/><path class="mark" d="M-17-13h34"/></g>
    <g transform="translate(250 46)"><g class="bug"><g class="flap">${c.wings}</g>${c.body}</g></g>
    <path class="arrow" d="M196 42h18m-5-5 5 5-5 5"/>
  </svg>
  <ol class="ex-steps">${ex.steps.map((s) => `<li><b>${esc(s.title)}</b>${esc(s.text)}</li>`).join('')}</ol>`;
}

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
    <div class="ex-spot"><p class="ex-intro">${esc(ex.spotIntro)}<span class="phone-only"> On a phone, close this panel first, then reopen it.</span></p><div data-spot="${esc(id)}"></div></div>
    ${
      score
        ? `<div class="ex-score" data-why><div class="ex-h">${esc(score.title)}</div>
        <div class="ex-sub">Average miss, in days. Shorter is better.</div>
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
