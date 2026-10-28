import type { Due } from '../core/layer';
import { dayOfYear } from '../core/timeAxis';

const KEY = 'hatch-place';
const DAY = 86_400_000;

/** The place "Coming out near you" speaks for: the last town found, or "you" (My area, rounded to about 1 km). */
export interface Place {
  name: string;
  lat: number;
  lng: number;
}

/** Kept in this browser only, like the rest of Hatch's memory: never sent anywhere. */
export function loadPlace(): Place | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Place | null;
    return p && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? p : null;
  } catch {
    return null;
  }
}

export function savePlace(p: Place | null): void {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify({ name: p.name, lat: +p.lat.toFixed(2), lng: +p.lng.toFixed(2) }));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: this visit only */
  }
}

// A no-break space keeps "May 3" together when the line wraps on a small phone.
const fmt = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(' ', '\u00A0');

/**
 * One line for a place and a species, from today (the real day, not the slider's): "Near Chicago: luna moths in 32
 * days (May 25)" before its season, "out now, peak about Jun 2" in it, and after it the countdown to next
 * year's. Analogy: the arrivals board for one platform.
 */
export function nearLine(place: string, who: string, due: Due, now: number): string {
  const y = new Date(now).getUTCFullYear();
  const at = (year: number, doy: number) => Date.UTC(year, 0, Math.round(doy));
  const doy = dayOfYear(now);
  const head = `Near ${place === 'you' ? 'you' : place.replace(/, [A-Z]{2}$/, '')}: ${who}`;
  const later = due.year !== undefined && due.year > y; // a season already over this year, counted to next year's
  if (!later && doy >= due.start && doy <= due.end) return doy < due.peak - 3 ? `${head} out now, peak about ${fmt(at(y, due.peak))}` : `${head} out now`;
  const year = later ? due.year! : doy < due.start ? y : y + 1;
  const next = at(year, due.start);
  const days = Math.max(1, Math.ceil((next - now) / DAY));
  return `${head} in ${days} day${days === 1 ? '' : 's'} (${fmt(next)})`;
}
