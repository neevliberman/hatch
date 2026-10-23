import { CITIES } from './explainer';

type Place = { name: string; lat: number; lng: number };
type Label = [string, number, number, number, string, number];

const km2 = (a: Label, b: Label) => ((a[1] - b[1]) * Math.cos((a[2] * Math.PI) / 180)) ** 2 + (a[2] - b[2]) ** 2;

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
    // Both files can carry the same place: one entry per name and spot.
    const seen = new Map<string, Label>();
    for (const p of parts)
      for (const l of (p.labels ?? []) as Label[])
        if (l[4] === 'city' || l[4] === 'town') seen.set(`${l[0]}|${l[1].toFixed(1)}|${l[2].toFixed(1)}`, l);
    const all = [...seen.values()].sort((a, b) => b[5] - a[5]);
    // Some names repeat (several Springfields). The labels carry no state, so name the nearest big city instead.
    const big = all.filter((l) => l[4] === 'city').slice(0, 40);
    const count = new Map<string, number>();
    for (const l of all) count.set(l[0], (count.get(l[0]) ?? 0) + 1);
    const out = all.map((l) => {
      if (count.get(l[0])! < 2) return { name: l[0], lat: l[2], lng: l[1] };
      const near = big.filter((b) => b[0] !== l[0]).reduce((a, b) => (km2(l, b) < km2(l, a) ? b : a));
      return { name: `${l[0]} (near ${near[0]})`, lat: l[2], lng: l[1] };
    });
    return out.length ? out : fallback;
  } catch {
    return fallback;
  }
}

/** "Find a town": a search button that opens a compact name box; picking a match calls `go`. */
export function mountFinder(
  btn: HTMLButtonElement,
  form: HTMLFormElement,
  go: (lat: number, lng: number, name: string) => void,
  say: (text: string) => void,
) {
  const input = form.querySelector('input')!;
  const list = form.querySelector('datalist')!;
  let places: Promise<Place[]> | null = null;
  // A phone keyboard covers the bottom of the page without shrinking it: lift the box above the keyboard.
  const vv = window.visualViewport;
  const lift = () => {
    const hidden = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
    form.style.transform = hidden ? `translateY(${-hidden}px)` : '';
  };
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
      vv?.addEventListener('resize', lift);
      lift();
    } else {
      vv?.removeEventListener('resize', lift);
      form.style.transform = '';
      btn.focus();
    }
  };
  btn.addEventListener('click', () => open(form.hidden));
  const pick = async (exactOnly: boolean) => {
    const typed = input.value;
    const q = typed.trim().toLowerCase();
    if (!q || !places) return;
    const ps = await places;
    if (form.hidden || input.value !== typed) return; // closed or retyped while the names loaded
    const p =
      ps.find((x) => x.name.toLowerCase() === q) ?? (exactOnly ? undefined : ps.find((x) => x.name.toLowerCase().startsWith(q)));
    if (!p) return exactOnly || say(`No town named ${typed.trim()} on this map`);
    open(false);
    go(p.lat, p.lng, p.name.replace(/ \(near .*\)$/, ''));
  };
  // A datalist pick fills the box in one go (no inputType, or a replacement); typing letter by letter waits for Enter,
  // so "Union" does not jump away before "Union City" is finished.
  input.addEventListener('input', (e) => {
    const t = (e as InputEvent).inputType;
    if (!t || t === 'insertReplacementText') void pick(true);
  });
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
