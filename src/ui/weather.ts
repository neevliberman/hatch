/**
 * Hourly air temperature for a place and a map date, from Open-Meteo: past days from the archive, near days from the
 * forecast, and a far-future date borrows the same calendar day of a past year (the map's "typical year").
 */
const DAY = 864e5;

export interface Day {
  /** °C, one per hour of the local day. */
  temps: (number | null)[];
  cloud: (number | null)[];
  note: string;
}

function resolve(ms: number, now = Date.now()): { date: string; api: string; note: string } {
  let d = new Date(ms);
  let note = '';
  while (d.getTime() > now + 15 * DAY) {
    d = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()));
    note = `Same day in ${d.getUTCFullYear()}`;
  }
  const near = d.getTime() > now - 6 * DAY;
  return {
    date: d.toISOString().slice(0, 10),
    api: near ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive',
    note: note || (near ? 'Forecast' : 'Recorded'),
  };
}

const cache = new Map<string, Promise<Day | null>>();
export function weather(lat: number, lng: number, ms: number): Promise<Day | null> {
  const r = resolve(ms);
  const key = `${lat.toFixed(2)},${lng.toFixed(2)},${r.date}`;
  let p = cache.get(key);
  if (!p) {
    const url = `${r.api}?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}&hourly=temperature_2m,cloud_cover&start_date=${r.date}&end_date=${r.date}&timezone=auto`;
    p = fetch(url)
      .then((x) => (x.ok ? x.json() : null))
      .then((j) => (j?.hourly ? { temps: j.hourly.temperature_2m, cloud: j.hourly.cloud_cover, note: r.note } : null))
      .catch(() => null)
      .then((d) => {
        if (!d) cache.delete(key); // a failed read (a 429, offline) is tried again next time
        return d;
      });
    cache.set(key, p);
  }
  return p;
}

/** The hour's temperature, blended between the two nearest whole hours. */
export function tempAt(day: Day | null, h: number): number | null {
  if (!day) return null;
  const a = Math.min(23, Math.floor(h));
  const t0 = day.temps[a];
  const t1 = day.temps[Math.min(23, a + 1)];
  if (t0 == null) return null;
  return t1 == null ? t0 : t0 + (t1 - t0) * (h - a);
}
