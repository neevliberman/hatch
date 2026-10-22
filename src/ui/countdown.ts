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

/** "Lunas due in ~205 days" off-season, or a note that the season is on. */
export function countdownText(now: number): string {
  const { onset, end, south } = seasonWindow();
  const y = new Date(now).getUTCFullYear();
  const at = (year: number, doy: number) => Date.UTC(year, 0, doy);
  const fmt = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (now >= at(y, onset) && now < at(y, end)) return 'Luna season is on: the first brood is flying somewhere in the Midwest now.';
  const next = now < at(y, onset) ? at(y, onset) : at(y + 1, onset);
  const days = Math.ceil((next - now) / DAY);
  return `Lunas due in ~${days} days (they usually start around ${fmt(next)} in the far south, ${south}°N).`;
}
