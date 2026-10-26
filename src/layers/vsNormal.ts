import { TYPICAL } from './replayData';

/** Closer than this, a peak is "about a typical year": the model's own misses are bigger. */
const TYPICAL_WITHIN_DAYS = 2;

/** One plain line comparing a hexagon's forecast peak with the typical year's (both forecasts, so like for like); null if either is missing. */
export function vsNormalLine(peak: number | null | undefined, typicalPeak: number | null | undefined): string | null {
  if (peak == null || typicalPeak == null) return null;
  const d = Math.round(typicalPeak - peak);
  if (Math.abs(d) <= TYPICAL_WITHIN_DAYS) return 'About a typical year.';
  return `About ${Math.abs(d)} days ${d > 0 ? 'earlier' : 'later'} than a typical year.`;
}

/** The typical year's forecast peak (median) for the cell at index `i` of a replay file's forecast. */
export const typicalPeak = (forecast: Record<string, (number | null)[][]>, i: number | undefined): number | null =>
  i === undefined ? null : (forecast[TYPICAL]?.[i]?.[2] ?? null);

/** iCalendar TEXT escaping (RFC 5545 section 3.3.11). */
const escText = (x: string) => x.replace(/[\\;,]/g, '\\$&').replace(/\r?\n/g, '\\n');

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

/** An all-day calendar event covering days `from` to `to` (inclusive, day of year) of `year`, as a downloadable .ics file. */
export function peakCalendar(what: string, id: string, year: number, from: number, to: number) {
  const start = Date.UTC(year, 0, Math.round(from)); // rounded, as the card's own dates are
  const end = Date.UTC(year, 0, Math.round(to) + 1); // DTEND is the day after, for an all-day event
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hatch//EN',
    'BEGIN:VEVENT',
    `UID:${id}-${year}@hatch`,
    `DTSTAMP:${ymd(Date.now())}T000000Z`,
    `DTSTART;VALUE=DATE:${ymd(start)}`,
    `DTEND;VALUE=DATE:${ymd(end)}`,
    `SUMMARY:${escText(what)} busiest days likely`,
    'DESCRIPTION:Hatch forecast: when people tend to see them.',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  return { href: `data:text/calendar;charset=utf-8,${encodeURIComponent(text)}`, filename: `${id}-${year}.ics`, label: 'Add to calendar' };
}
