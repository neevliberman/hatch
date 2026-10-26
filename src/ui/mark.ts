import { isDark } from '../theme';

const dark = new Map<string, Promise<string>>();

/**
 * A species' sketch mark for the current theme. The marks are drawn on a paper disc in ink, which glares as a white
 * circle on the lamplit page, so in dark mode the disc goes and the ink turns to chalk (the dots' lamplight inversion).
 * Resolves to the plain URL in light mode, or if the file can't be read. (Vite inlines the small marks as data: URLs
 * with single-quoted attributes, so the patterns take either quote.)
 */
export function markFor(url: string): Promise<string> {
  if (!isDark()) return Promise.resolve(url);
  let p = dark.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => r.text())
      .then((svg) => {
        const inverted = svg.replace(/<circle cx=["']256["'] cy=["']256["'] r=["']256["'][^>]*\/>/, '').replaceAll('#2b241c', '#eadfc8');
        return `data:image/svg+xml,${encodeURIComponent(inverted)}`;
      })
      .catch(() => url);
    dark.set(url, p);
  }
  return p;
}
