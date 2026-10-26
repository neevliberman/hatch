import type { Live } from './liveData';

/** Night activity, from the live file's `activity` block: 0 slow, 1 typical, 2 busy, against that place's own nights
 * in the same week of 2017-2025. Moths only (pipeline/activity: butterflies and fireflies did not pass the test). */
export interface Activity {
  /** UTC ms of each night's date, tonight first. */
  nights: number[];
  /** [lat, lng, class per night (null: no call)]. */
  rows: (number | null)[][];
}

const WORDS = ['slow', 'typical', 'busy'] as const;
const MAX_DEG = 1.6; // farther than this from every forecast point: say nothing

/** The card line for a moth night at (lat, lng), or null when the file has no call for that night and place. */
export function mothNightLine(live: Pick<Live, 'activity'>, lat: number, lng: number, dayMs: number): string | null {
  const a = live.activity;
  if (!a) return null;
  const n = a.nights.indexOf(dayMs);
  if (n < 0) return null;
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  let cls: number | null = null;
  for (const r of a.rows) {
    const d = Math.hypot(r[0]! - lat, (r[1]! - lng) * k);
    if (d < best) {
      best = d;
      cls = r[2 + n] ?? null;
    }
  }
  if (best > MAX_DEG || cls === null || !WORDS[cls]) return null;
  return `Moths ${n === 0 ? 'tonight' : 'that night'}: ${WORDS[cls]}.`;
}

export const MOTH_NIGHT_NOTE =
  'Moth night: from the forecast for warmth, wind and moon, against nights of the same week in 2017-2025. In held-out years, busy nights logged about 1.6x the sightings of slow ones.';

/** Parse the file's block defensively: anything off just means no line. */
export function parseActivity(a: unknown): Activity | undefined {
  const x = a as { nights?: unknown; moth?: unknown } | undefined;
  if (!x || !Array.isArray(x.nights) || !Array.isArray(x.moth)) return undefined;
  const nights = x.nights.map((s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + 'T00:00:00Z') : NaN));
  if (!nights.length || nights.some((t) => !Number.isFinite(t))) return undefined;
  const rows = x.moth.filter((r): r is (number | null)[] => Array.isArray(r) && r.length >= 3 && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  return rows.length ? { nights, rows } : undefined;
}
