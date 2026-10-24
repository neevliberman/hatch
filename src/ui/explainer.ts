import type { CaveatCard, Explainer, RecordCheck, SpotStory } from '../core/layer';
import { sketchStrip } from './sketch';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Big cities: the town finder's list when the map's own names can't load, and the About example's nearest city. South to north. */
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

/** The bold answer to "how sure is it?", from the forecast's days off and the plain guess's (each layer's own scores),
 * on what they were scored on (`scope`: "on past years"), so it never reads as a claim about every test. */
function scoreLead([f, base]: { label: string; days: number }[], scope?: string): string {
  if (!f) return '';
  const n = (d: number) => `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
  const lead = `Usually within about ${n(f.days)}${scope ? ` ${scope}` : ''}.`;
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

const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "5 strip-years", with a word joiner after the hyphen so it stays on one line (the fonts have no non-breaking hyphen). */
export const stripYears = (n: number) => `${n} strip-\u2060year${n === 1 ? '' : 's'}`;

/** Years in words, three or more in a row as a span: [2026, 2027] "2026 and 2027", [2026, 2027, 2028, 2030] "2026–2028 and 2030". */
function years(ys: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < ys.length; ) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j]! + 1) j++;
    if (j - i >= 2) runs.push(`${ys[i]}\u2013${ys[j]}`);
    else for (let k = i; k <= j; k++) runs.push(String(ys[k]));
    i = j + 1;
  }
  return and(runs);
}

/** One verb group's live seasons as one check: "in 2026 and 2027", their strip-years added up, days off averaged per
 * strip-year. Every season in it already has the group's verb, so the pooled numbers keep it too. Other checks stay. */
function poolSeasons(cs: RecordCheck[]): RecordCheck[] {
  const live = cs.filter((c) => c.season != null && c.n);
  if (live.length < 2) return cs;
  const n = live.reduce((a, c) => a + c.n!, 0);
  const mean = (f: (c: RecordCheck) => number) => Math.round((live.reduce((a, c) => a + f(c) * c.n!, 0) / n) * 10) / 10;
  const pooled: RecordCheck = {
    where: `in ${years(live.map((c) => c.season!).sort((a, b) => a - b))}`,
    days: mean((c) => c.days),
    usual: mean((c) => c.usual),
    size: stripYears(n),
  };
  const at = cs.indexOf(live[0]!);
  return [...cs.slice(0, at).filter((c) => !live.includes(c)), pooled, ...cs.slice(at).filter((c) => !live.includes(c))];
}

/** The species' whole record against the usual date in one plain line, from its own checks (past years, places it never
 * learned from, every live season the scorecard holds, pooled per verb): what it beat, tied and lost to, each with how big a test it was, and
 * the numbers for any tie or loss. `through`: the last season the checks cover when this season's live check is not
 * among them ("Record through 2025"), so the line never passes for the whole record. Species-neutral: every word comes
 * from the checks. Empty when there are none. */
export function recordLine(checks: RecordCheck[], through?: number): string {
  if (!checks.length) return '';
  const t = (d: number) => Math.round(d * 10); // compare as shown, to a tenth of a day
  const size = (c: RecordCheck, more = '') => (c.size || more ? ` (${[c.size, more].filter(Boolean).join(': ')})` : '');
  const groups: [string, RecordCheck[], (c: RecordCheck) => string][] = [
    ['beat', poolSeasons(checks.filter((c) => t(c.days) < t(c.usual))), (c) => size(c)],
    ['tied with', poolSeasons(checks.filter((c) => t(c.days) === t(c.usual))), (c) => size(c, `${c.days.toFixed(1)} days off each`)],
    ['lost to', poolSeasons(checks.filter((c) => t(c.days) > t(c.usual))), (c) => size(c, `${c.days.toFixed(1)} days off against ${c.usual.toFixed(1)}`)],
  ];
  const clauses = groups
    .filter(([, cs]) => cs.length)
    .map(([verb, cs, tail], i) => `${verb} ${i ? 'it' : 'the usual date'} ${and(cs.map((c) => c.where + tail(c)))}`);
  const lost = groups[2]![1].length > 0;
  const body =
    clauses.length < 2 ? clauses[0]!
    : `${clauses.slice(0, -1).join(', ')}${lost ? ', but ' : ' and '}${clauses[clauses.length - 1]}`;
  return `${clauses.length > 1 ? 'Mixed record' : 'Record'} ${through ? `through ${through}` : 'so far'}: ${body}.`;
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
      ${__BASEMAP__ ? `<button type="button" class="ex-find" data-find aria-controls="finder"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.32 12.9l5.39 5.4-1.41 1.4-5.4-5.39A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/></svg>Or find a town</button>` : ''}
      <div data-spot="${esc(id)}"></div></div>
    ${
      score
        ? `<div class="ex-score" data-why><div class="ex-h">${esc(score.title)}</div>
        <p class="ex-lead">${esc(scoreLead(score.bars, score.scope))}</p>
        ${
          score.checks?.length
            ? // With files beside the page, hidden until the scorecard file adds this season's check (ui/scorecard.ts),
              // and kept hidden if it fails to load: never a record that silently leaves a season out. The one-file
              // build has no scorecard, so it shows the past and holdout checks only, named "Record through <year>".
              `<p class="ex-record" data-record="${esc(id)}" data-checks="${esc(JSON.stringify(score.checks))}" data-through="${score.checksThrough ?? ''}"${
                __BASEMAP__ ? ' hidden' : ''
              }>${esc(recordLine(score.checks, score.checksThrough))}</p>`
            : ''
        }
        <div class="ex-sub">Days off, on average. Shorter is better.</div>
        ${score.bars
          .map(
            (x) => `<div class="bar-l"><span>${esc(x.label)}</span><i class="${x.best ? 'best' : ''}" style="width:${((x.days / max) * 100).toFixed(1)}%"></i>
            <b>${x.days.toFixed(1)} days</b></div>`,
          )
          .join('')}
        <ul class="ex-pts">${score.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <div data-score="${esc(id)}" hidden></div></div>`
        : ''
    }
    <details class="ex-fine" data-key="fine-${esc(id)}"><summary>${esc(ex.finePrintLabel)}</summary>
      <ul>${cav.bullets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>
  </section>`;
}
