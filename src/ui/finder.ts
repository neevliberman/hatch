import { CITIES } from './explainer';

type Place = { name: string; lat: number; lng: number };
type Label = [string, number, number, number, string, number];

/** Town names to jump to: the basemap's city and town labels (fetched on first open), or the About menu's cities. */
async function loadPlaces(): Promise<Place[]> {
  const fallback = CITIES.map((c) => ({ ...c, name: c.name.replace(/, [A-Z]{2}$/, '') }));
  if (!__BASEMAP__) return fallback;
  try {
    const parts = await Promise.all(
      ['overview', 'detail'].map((n) =>
        fetch(new URL(`basemap/${n}.json`, document.baseURI).href).then((r) => (r.ok ? r.json() : { labels: [] })),
      ),
    );
    // Some names repeat (several Springfields): keep the biggest.
    const best = new Map<string, Label>();
    for (const p of parts)
      for (const l of (p.labels ?? []) as Label[])
        if ((l[4] === 'city' || l[4] === 'town') && !((best.get(l[0])?.[5] ?? -1) >= l[5])) best.set(l[0], l);
    const out = [...best.values()].sort((a, b) => b[5] - a[5]).map(([name, lng, lat]) => ({ name, lat, lng }));
    return out.length ? out : fallback;
  } catch {
    return fallback;
  }
}

/** "Find a town": a round search button that opens a compact name box; picking a match calls `go`. */
export function mountFinder(btn: HTMLButtonElement, form: HTMLFormElement, go: (lat: number, lng: number, name: string) => void) {
  const input = form.querySelector('input')!;
  const list = form.querySelector('datalist')!;
  let places: Promise<Place[]> | null = null;
  const open = (on: boolean) => {
    form.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    if (on) {
      places ??= loadPlaces().then((ps) => {
        list.replaceChildren(...ps.map((p) => Object.assign(document.createElement('option'), { value: p.name })));
        return ps;
      });
      input.value = '';
      input.focus();
    } else btn.focus();
  };
  btn.addEventListener('click', () => open(form.hidden));
  const pick = async (exactOnly: boolean) => {
    const q = input.value.trim().toLowerCase();
    if (!q || !places) return;
    const ps = await places;
    const p =
      ps.find((x) => x.name.toLowerCase() === q) ?? (exactOnly ? undefined : ps.find((x) => x.name.toLowerCase().startsWith(q)));
    if (!p) return;
    open(false);
    go(p.lat, p.lng, p.name);
  };
  // A datalist pick fills the box with an exact name; Enter takes the best prefix match.
  input.addEventListener('input', () => void pick(true));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void pick(false);
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      open(false);
    }
  });
}
