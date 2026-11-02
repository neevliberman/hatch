const KEY = 'hatch-watch';
/** How many species the watch list holds: a row of chips, not a second catalogue. */
export const WATCH_MAX = 12;

/** The species watched (their ?species= keys, newest first), kept in this browser only. A missing or mangled value is
 * an empty list; storage that can't be read (blocked) is null, so a caller keeps the list it has in memory instead of
 * saving over it with nothing. The page never depends on it. */
export function loadWatch(): string[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(v)) return [];
    const keys = v.filter((k): k is string => typeof k === 'string' && /^[a-z0-9-]{1,80}$/.test(k));
    return [...new Set(keys)].slice(0, WATCH_MAX);
  } catch {
    return [];
  }
}

export function saveWatch(keys: readonly string[]): void {
  try {
    if (keys.length) localStorage.setItem(KEY, JSON.stringify(keys));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the list lasts until reload */
  }
}
