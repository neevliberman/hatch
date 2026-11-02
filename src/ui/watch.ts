const KEY = 'hatch-watch';
/** How many species the watch list holds: a row of chips, not a second catalogue. */
export const WATCH_MAX = 12;

/** The species watched (their ?species= keys, newest first), kept in this browser only. A missing, blocked or mangled
 * value is an empty list: the page never depends on it. */
export function loadWatch(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
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
