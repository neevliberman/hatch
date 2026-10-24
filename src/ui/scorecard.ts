/**
 * This season's scorecard (pipeline/live/scorecard.py -> live/scorecard.json), in the About panel's "How sure is it?"
 * card: one line, then a small strip-by-strip table. Loaded lazily (its own chunk), and only when the drawer has a
 * card for it; anything wrong with the file just means no line. Each layer finds its own entry by species key
 * (layer id "luna-replay" -> "luna", "japanese-beetle-replay" -> "japanese-beetle"), so the words here never name a
 * species. A species with no entry in the file shows no line.
 */
import type { RecordCheck } from '../core/layer';
import { recordLine } from './explainer';

interface Dates { real: number; forecast: number; calendar: number }
interface Band { band: string; status: string; settles_on: string; peak?: Dates; miss?: number }
interface Card {
  summary: { scored: number; pending: number; too_few?: number; no_forecast?: number; miss: number | null; calendar_miss: number | null };
  bands: Band[];
}
interface File { version: number; kind: string; season: number; rehearsal?: boolean; layers?: Record<string, Card> }

let file: Promise<File | null> | null = null;

const md = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const day = (y: number, doy: number) => md(Date.UTC(y, 0, Math.round(doy)));
const days = (d: number) => `${d.toFixed(1)} days`;

function html(f: File, c: Card): string {
  const s = c.summary;
  const when = f.rehearsal ? `${f.season} (rebuilt after the fact)` : `${f.season} so far`;
  const line =
    s.scored && s.miss != null && s.calendar_miss != null
      ? `${when}: counting start and peak dates, the forecast missed by ${days(s.miss)} on average, the usual date by ${days(s.calendar_miss)}. The table shows peaks. ${s.scored} strip${s.scored > 1 ? 's' : ''} scored, ${s.pending || 'none'} pending.`
      : !s.scored && !s.pending
        ? (s.no_forecast ?? 0) > 0
          ? `${when}: no strip could be scored: too few sightings, or no forecast made early enough.`
          : `${when}: not enough sightings to score this season.`
        : `${when}: nothing scored yet, ${s.pending} strip${s.pending === 1 ? '' : 's'} pending. A strip is checked once its first wave is over and its sightings are 2 weeks old.`;
  const rows = c.bands
    .map((b) => {
      const p = b.peak;
      const cells =
        b.status === 'scored' && p
          ? `<td>${day(f.season, p.real)}</td><td>${day(f.season, p.forecast)}</td><td>${day(f.season, p.calendar)}</td>`
          : `<td colspan="3">${
              b.status === 'pending' ? `checked from ${md(Date.parse(b.settles_on))}`
              : b.status === 'no_forecast' ? 'no forecast made early enough'
              : 'too few sightings to check'
            }</td>`;
      return `<tr><th scope="row">${String(b.band).replace(/[^\d-]/g, '')}°N</th>${cells}</tr>`;
    })
    .join('');
  return `<p class="sc-line"><i>live check</i> ${line}</p>
    <table class="sc-tab"><caption class="sr">Peak dates by strip of the map</caption>
    <thead><tr><th scope="col">Strip</th><th scope="col">Peak seen</th><th scope="col">Forecast</th><th scope="col">Usual</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Fill every [data-score] card in `root` (the drawer re-renders, so this runs after each render), and add this season's
 * check to every [data-record] line, then show it. A layer the file has not scored this season shows its past checks,
 * named "Record through <last year>". If the file is missing or broken, the lines stay hidden: a record that silently
 * left this season out would read as the whole record. */
export function fillScores(root: HTMLElement): void {
  file ??= fetch(new URL(`${import.meta.env.BASE_URL}live/scorecard.json`, document.baseURI), { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<File>) : null))
    .catch(() => null);
  void file.then((f) => {
    if (!f || f.version !== 1 || f.kind !== 'scorecard') return;
    const card = (el: HTMLElement, attr: string) => f.layers?.[el.dataset[attr]!.replace(/-replay$/, '')];
    root.querySelectorAll<HTMLElement>('[data-record]').forEach((el) => {
      let checks: RecordCheck[] = [];
      try {
        checks = JSON.parse(el.dataset.checks ?? '[]') as RecordCheck[];
      } catch {
        return; // a bad attribute just means no line
      }
      const s = card(el, 'record')?.summary;
      const scored = !!(s?.scored && s.miss != null && s.calendar_miss != null);
      if (scored)
        checks.push({ where: `in ${f.season}`, days: s!.miss!, usual: s!.calendar_miss!, size: `${s!.scored} strip-year${s!.scored > 1 ? 's' : ''}` });
      el.textContent = recordLine(checks, scored ? undefined : Number(el.dataset.through) || undefined);
      el.hidden = !el.textContent;
    });
    root.querySelectorAll<HTMLElement>('[data-score]').forEach((el) => {
      const c = card(el, 'score');
      if (!c?.summary || !Array.isArray(c.bands)) return;
      el.innerHTML = html(f, c);
      el.hidden = false;
    });
  });
}
