import type { CaveatCard, Explainer, SpotStory } from '../core/layer';
import { sketchStrip } from './sketch';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

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

/** The bold answer to "how sure is it?", from the forecast's days off and the plain guess's (each layer's own scores). */
function scoreLead([f, base]: { label: string; days: number }[]): string {
  if (!f) return '';
  const n = (d: number) => `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
  const lead = `Usually within about ${n(f.days)}.`;
  if (!base || !(f.days > 0)) return lead; // no ratio against a perfect (or missing) score
  const r = base.days / f.days;
  const vs = `guessing the ${base.label.toLowerCase()}`;
  return `${lead} ${
    r >= 2.6 ? `About ${Math.round(r)} times as close as ${vs}.`
    : r >= 1.75 ? `About twice as close as ${vs}.`
    : r >= 1.15 ? `Closer than ${vs}, which is off by about ${n(base.days)}.`
    : r > 0.87 ? `About as close as ${vs}.`
    : `${vs[0]!.toUpperCase()}${vs.slice(1)} did better, at about ${n(base.days)}.`
  }`;
}

/** The whole species section of the drawer. Its spot card is filled separately, so it can follow the map. */
export function explainerHtml(id: string, ex: Explainer, cav: CaveatCard): string {
  const score = ex.score;
  const max = score ? Math.max(...score.bars.map((x) => x.days)) : 1;
  return `<section class="ex" style="--ac:${esc(ex.accent)}">
    <h3 class="ex-name">${esc(ex.name)} <i>${esc(ex.sci)}</i></h3>
    <p class="ex-hook">${esc(ex.hook)}</p>
    ${
      ex.notice
        ? `<div class="ex-notice" data-why><div class="ex-h">${esc(ex.notice.title)}</div>
        <ul>${ex.notice.bullets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
        : ''
    }
    <figure class="ex-fig">${sketchStrip(id, ex, ex.steps.map((x) => `<b>${esc(x.title)}</b>${esc(x.text)}`))}</figure>
    <div class="ex-spot"><p class="ex-intro">${esc(ex.spotIntro)}</p>
      <label class="ex-place">Or pick a city <select data-place><option value="">Choose…</option>${CITIES.map(
        (c) => `<option value="${c.lat},${c.lng}">${esc(c.name)}</option>`,
      ).join('')}</select></label>
      <div data-spot="${esc(id)}"></div></div>
    ${
      score
        ? `<div class="ex-score" data-why><div class="ex-h">${esc(score.title)}</div>
        <p class="ex-lead">${esc(scoreLead(score.bars))}</p>
        <div class="ex-sub">Days off, on average. Shorter is better.</div>
        ${score.bars
          .map(
            (x) => `<div class="bar-l"><span>${esc(x.label)}</span><i class="${x.best ? 'best' : ''}" style="width:${((x.days / max) * 100).toFixed(1)}%"></i>
            <b>${x.days.toFixed(1)} days</b></div>`,
          )
          .join('')}
        <ul class="ex-pts">${score.points.map(([tag, x]) => `<li><i>${esc(tag)}</i> ${esc(x)}</li>`).join('')}</ul>
        <div data-score="${esc(id)}" hidden></div></div>`
        : ''
    }
    <details class="ex-fine" data-key="fine-${esc(id)}"><summary>${esc(ex.finePrintLabel)}</summary>
      <ul>${cav.bullets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>
  </section>`;
}
