import { data } from '../layers/lunaData';

const DAY = 86_400_000;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Typical first-brood onset in the southern band and peak in the northern band, as days of year. */
function seasonWindow() {
  const south = data.bands[0]!.label;
  const north = data.bands[data.bands.length - 1]!.label;
  const onset = mean(data.scores.filter((r) => r.band === south).map((r) => r.obs_onset));
  const peak = mean(data.scores.filter((r) => r.band === north).map((r) => r.obs_peak));
  return { onset: Math.round(onset || 135), end: Math.round((peak || 172) + 14), south };
}

/** "Next real season: about Apr 17, 2027" off-season, or a note that the season is on: a short part, then detail phones may hide. */
export function countdownParts(now: number): [string, string] {
  const { onset, end, south } = seasonWindow();
  const y = new Date(now).getUTCFullYear();
  const at = (year: number, doy: number) => Date.UTC(year, 0, doy);
  const fmt = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (now >= at(y, onset) && now < at(y, end)) return ['Luna season is on', '. The first wave is out somewhere in the Midwest right now.'];
  const next = now < at(y, onset) ? at(y, onset) : at(y + 1, onset);
  const days = Math.ceil((next - now) / DAY);
  // The slider shows a past season, so name the real next one by date, not just "in N days".
  return [`Next real season: about ${fmt(next)}, ${new Date(next).getUTCFullYear()}`, `, first in the southern part of the map (${south}°N), ${days} days from now.`];
}
