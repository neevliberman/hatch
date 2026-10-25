import type { ReplayFile } from '../layers/lunaData';

const DAY = 86_400_000;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Typical onset in the southernmost scored band and peak in the northernmost, as days of year. */
function seasonWindow(data: ReplayFile) {
  const scored = data.bands.filter((b) => data.scores.some((r) => r.band === b.label));
  const south = (scored[0] ?? data.bands[0]!).label;
  const north = (scored[scored.length - 1] ?? data.bands[data.bands.length - 1]!).label;
  const onset = mean(data.scores.filter((r) => r.band === south).map((r) => r.obs_onset));
  const peak = mean(data.scores.filter((r) => r.band === north).map((r) => r.obs_peak));
  return { onset: Math.round(onset || 135), end: Math.round((peak || 172) + 14) };
}

/** A species' words for the countdown: the note while its season is on (a short part, then detail phones may hide),
 * and where its season starts. */
export interface SeasonWords {
  on: [string, string];
  where: string;
}

/** "Next real season: about Apr 17, 2027" off-season, or a note that the season is on: a short part, then detail phones may hide. */
export function countdownParts(now: number, file: ReplayFile, words: SeasonWords): [string, string] {
  const { onset, end } = seasonWindow(file);
  const y = new Date(now).getUTCFullYear();
  const at = (year: number, doy: number) => Date.UTC(year, 0, doy);
  const fmt = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (now >= at(y, onset) && now < at(y, end)) return words.on;
  const next = now < at(y, onset) ? at(y, onset) : at(y + 1, onset);
  const days = Math.ceil((next - now) / DAY);
  // The slider shows a past season, so name the real next one by date, not just "in N days".
  return [`Next season: about ${fmt(next)}, ${new Date(next).getUTCFullYear()}`, `, starting in ${words.where} (${days} days).`];
}
