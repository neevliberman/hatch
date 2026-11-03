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

/** The calendar a typical year's days of year are dates in (one without 29 Feb), on the card's season line and on
 * this one alike, so the two never drift a day apart in a leap year. */
export const TYPICAL_YEAR = 2025;
/** "May 3" for a day of year: in `year` when the season is that year's, else a typical year. A no-break space keeps
 * it together when the line wraps on a small phone. */
export const dateOf = (doy: number, year: number = TYPICAL_YEAR) =>
  new Date(Date.UTC(year, 0, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(' ', '\u00A0');

/**
 * One line for a place and a species, from today (the real day, not the slider's): "Near Chicago: luna moths in 32
 * days (May 25)" before its season, "out now, peak about Jun 2" in it, and after it the countdown to next
 * year's. Analogy: the arrivals board for one platform.
 */
export function nearLine(place: string, who: string, due: Due, now: number): string {
  const head = `Near ${place === 'you' ? 'you' : place.replace(/, [A-Z]{2}$/, '')}: ${who}`;
  const w = when(due, now);
  if (w.on) return w.peak !== null ? `${head} out now, peak about ${dateOf(w.peak, due.year)}` : `${head} out now`;
  return `${head} in ${plural(w.days)} (${dateOf(w.nextDoy, due.year)})`;
}

/** The same countdown, short enough for a chip: "out now" or "out in 12 days". */
export function dueShort(due: Due, now: number): string {
  const w = when(due, now);
  return w.on ? 'out now' : `out in ${plural(w.days)}`;
}

/** Where a season stands today: in one of its broods (with that brood's peak, if still ahead), or the start of the next
 * brood and the days to wait (after the last, next year's first). */
function when(due: Due, now: number) {
  const y = new Date(now).getUTCFullYear();
  const at = (year: number, doy: number) => Date.UTC(year, 0, Math.round(doy));
  const doy = dayOfYear(now);
  const later = due.year !== undefined && due.year > y; // a season already over this year, counted to next year's
  const broods = due.broods?.length ? due.broods : [due];
  const on = later ? undefined : broods.find((b) => doy >= b.start && doy <= b.end);
  if (on) return { on: true as const, peak: doy < on.peak - 3 ? on.peak : null };
  const ahead = later ? undefined : broods.find((b) => doy < b.start);
  const nextDoy = ahead ? ahead.start : broods[0]!.start;
  const next = ahead ? at(y, ahead.start) : at(later ? due.year! : y + 1, broods[0]!.start);
  return { on: false as const, next, nextDoy, days: Math.max(1, Math.ceil((next - now) / DAY)) };
}
const plural = (days: number) => `${days} day${days === 1 ? '' : 's'}`;
