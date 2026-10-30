/**
 * This season's scorecard (pipeline/live/scorecard.py -> live/scorecard.json), in the About panel's "How sure is it?"
 * card: one line, then a small strip-by-strip table. Loaded lazily (its own chunk), and only when the drawer has a
 * card for it; anything wrong with the file just means no line. Under it, folded, the models trying out against the map
 * and the drift check (the file's `league` block). Each layer finds its own entry by species key
 * (layer id "luna-replay" -> "luna", "japanese-beetle-replay" -> "japanese-beetle"), so the words here never name a
 * species. A species with no entry in the file shows no line.
 */
import type { RecordCheck } from '../core/layer';
import { recordLine, stripYears } from './explainer';

interface Dates { real: number; forecast: number; calendar: number }
interface Band { band: string; status: string; settles_on: string; peak?: Dates; miss?: number }
interface Card {
  summary: { scored: number; pending: number; too_few?: number; no_forecast?: number; miss: number | null; calendar_miss: number | null };
  bands: Band[];
}
type Summary = Card['summary'];
/** Every other season the file carries (scorecard.py with_seasons), each species' last published summary. Older files
 * have none. */
interface Past { season: number; rehearsal?: boolean; layers?: Record<string, { summary?: Summary }> }
/** The league block (pipeline/league/summary.py): per layer, the models trying out against it and the drift check. */
interface Tryout {
  name: string; against: 'map' | 'usual'; report_only: boolean; first_season: number; verdict_date: string; status: string;
  strips: number | null; D: number | null; takes_map: number | null;
}
interface League { season: number; layers?: Record<string, { tryouts?: Tryout[]; drift?: 'ok' | 'watch' | 'alarm' | null }> }
interface File { version: number; kind: string; season: number; rehearsal?: boolean; layers?: Record<string, Card>; seasons?: Past[]; league?: League }

let file: Promise<File | null> | null = null;

const md = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const day = (y: number, doy: number) => md(Date.UTC(y, 0, Math.round(doy)));
const days = (d: number) => `${d.toFixed(1)} days`;

function html(f: File, c: Card): string {
  const s = c.summary;
  const when = f.rehearsal ? `${f.season} (rebuilt after the fact)` : `${f.season} so far`;
  const line =
    s.scored && s.miss != null && s.calendar_miss != null
      ? `${when}: the forecast missed start and peak dates by ${days(s.miss)} on average, the usual date by ${days(s.calendar_miss)}. ${s.scored} strip${s.scored > 1 ? 's' : ''} scored, ${s.pending || 'none'} pending.`
      : !s.scored && !s.pending
        ? (s.no_forecast ?? 0) > 0
          ? `${when}: nothing scorable: too few sightings, or no early forecast.`
          : `${when}: too few sightings to score.`
        : `${when}: nothing scored yet, ${s.pending} strip${s.pending === 1 ? '' : 's'} pending. A strip is scored once its first wave is over and its sightings are 2 weeks old.`;
  const rows = c.bands
    .map((b) => {
      const p = b.peak;
      const cells =
        b.status === 'scored' && p
          ? `<td>${day(f.season, p.real)}</td><td>${day(f.season, p.forecast)}</td><td>${day(f.season, p.calendar)}</td>`
          : `<td colspan="3">${
              b.status === 'pending' ? `checked from ${md(Date.parse(b.settles_on))}`
              : b.status === 'no_forecast' ? 'no early forecast'
              : 'too few sightings'
            }</td>`;
      return `<tr><th scope="row">${String(b.band).replace(/[^\d-]/g, '')}°N</th>${cells}</tr>`;
    })
    .join('');
  return `<p class="sc-line"><i>live check</i> ${line}</p>
    <table class="sc-tab"><caption class="sr">Peak dates by strip of the map</caption>
    <thead><tr><th scope="col">Strip</th><th scope="col">Peak seen</th><th scope="col">Forecast</th><th scope="col">Usual</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const esc = (x: unknown) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Where one tryout stands, in a few words. */
function tryoutText(t: Tryout): string {
  const vs = t.against === 'usual' ? 'the usual date' : "the map's model";
  const unit = t.against === 'usual' ? 'place' : 'strip';
  switch (t.status) {
    case 'upcoming':
      return `starts ${t.first_season}, decided ${md(Date.parse(t.verdict_date))}`;
    case 'in_progress':
      return t.strips && t.D != null
        ? `${Math.abs(t.D).toFixed(1)} days ${t.D <= 0 ? 'closer' : 'further off'} than ${vs} on ${t.strips} ${unit}${t.strips > 1 ? 's' : ''} so far`
        : `shadowing ${vs}, nothing scored yet`;
    case 'challenger_wins': return t.takes_map ? `won: on the map from ${t.takes_map}` : 'won';
    case 'clock_wins': return 'won: an eastern layer is next';
    case 'champion_wins': return 'retired: at least 1 day worse';
    case 'calendar_stays': return 'retired: did not beat the usual date';
    case 'tie': return "tie: the map keeps its model";
    case 'no_verdict': return 'too few sightings to decide';
    default: return 'not graded this week';
  }
}

const DRIFT = {
  ok: 'no sign of drift',
  watch: 'possible drift; rechecking',
  alarm: 'looks stale; refit before next season',
};

function tryoutsHtml(l: League, key: string): string {
  const entry = l.layers?.[key];
  const ts = (Array.isArray(entry?.tryouts) ? entry.tryouts : []).filter((t) => t && typeof t.name === 'string');
  const drift = entry?.drift && Object.hasOwn(DRIFT, entry.drift) ? DRIFT[entry.drift] : '';
  if (!ts.length && !drift) return '';
  // Tryouts that have not started and share their dates say them once, in the intro.
  const same = ts.every((t) => t.status === 'upcoming' && t.first_season === ts[0]!.first_season && t.verdict_date === ts[0]!.verdict_date);
  const when = same ? ` ${ts.length > 1 ? 'All start' : 'Starts'} ${esc(ts[0]!.first_season)}, decided ${md(Date.parse(ts[0]!.verdict_date))}.` : '';
  return `${ts.length ? `<p>Rival models forecast nightly, unseen; one takes the map only by beating it over a season.${when}</p>
    <ul>${ts.map((t) => `<li><b>${esc(t.name)}</b>${t.report_only ? ' (report only)' : ''}${same ? '' : `: ${esc(tryoutText(t))}`}</li>`).join('')}</ul>` : ''}
    ${drift ? `<p>Drift check, ${esc(l.season)}: ${drift}.</p>` : ''}`;
}

const isScored = (s?: Summary): s is Summary & { miss: number; calendar_miss: number } =>
  !!(s?.scored && s.miss != null && s.calendar_miss != null);

/** Fill every [data-score] card in `root` (the drawer re-renders, so this runs after each render), and add every live
 * season's check (the past ones the file carries, then this one) to every [data-record] line, then show it. A layer
 * the file has not scored this season shows its other checks, named "Record through <last season it holds>". If the
 * file is missing or broken, the lines stay hidden: a record that silently left a season out would read as the whole
 * record. */
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
      const key = el.dataset.record!.replace(/-replay$/, '');
      // A season rebuilt after the fact is named as such and kept out of the pooled clause with real ones.
      const add = (season: number, s: Summary & { miss: number; calendar_miss: number }, rehearsal?: boolean) =>
        checks.push({
          where: `in ${season}`, days: s.miss, usual: s.calendar_miss, season, n: s.scored,
          size: rehearsal ? `rebuilt after the fact, ${stripYears(s.scored)}` : stripYears(s.scored),
          ...(rehearsal ? { rehearsal } : {}),
        });
      let through = Number(el.dataset.through) || 0;
      const past = (Array.isArray(f.seasons) ? f.seasons : [])
        .filter((p) => p && Number.isInteger(p.season) && p.season !== f.season && p.layers?.[key])
        .sort((a, b) => a.season - b.season);
      for (const p of past) {
        const s = p.layers![key]!.summary;
        if (isScored(s)) {
          add(p.season, s, p.rehearsal);
          through = Math.max(through, p.season); // only a season that is in the line
        }
      }
      const s = card(el, 'record')?.summary;
      const scored = isScored(s);
      if (scored) add(f.season, s, f.rehearsal);
      el.textContent = recordLine(checks, scored ? undefined : through || undefined);
      el.hidden = !el.textContent;
    });
    root.querySelectorAll<HTMLElement>('[data-tryouts]').forEach((el) => {
      let body = '';
      try {
        if (f.league && Number.isInteger(f.league.season)) body = tryoutsHtml(f.league, el.dataset.tryouts!.replace(/-replay$/, ''));
      } catch {
        return; // an odd league block just means no tryouts
      }
      if (!body) return;
      el.querySelector('div')!.innerHTML = body;
      el.hidden = false;
    });
    root.querySelectorAll<HTMLElement>('[data-score]').forEach((el) => {
      const c = card(el, 'score');
      if (!c?.summary || !Array.isArray(c.bands)) return;
      el.innerHTML = html(f, c);
      el.hidden = false;
    });
  });
}
