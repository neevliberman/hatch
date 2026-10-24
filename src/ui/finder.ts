import { CITIES } from './explainer';
import { stateCollection } from '../core/grid';

/** A town to jump to. `inside`: in one of the states the map forecasts. `tag`: its state, shown when the name repeats. */
type Place = { name: string; lat: number; lng: number; pop: number; inside: boolean; tag?: string };
type Label = [string, number, number, number, string, number];
/** A town's name as listed: with its state (and a nearby city) when the name repeats. */
const full = (p: Place) => (p.tag ? `${p.name}${p.tag[0] === '(' ? ' ' : ', '}${p.tag}` : p.name);

/** The state a point is in (ray casting over the bundled outlines), or undefined beyond them. */
function stateAt(lng: number, lat: number) {
  const inRing = (r: number[][]) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
      if (yi! > lat !== yj! > lat && lng < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
    }
    return inside;
  };
  return stateCollection.features.find((f) =>
    (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).some((p) => inRing(p[0]!)),
  )?.properties;
}

/** Town names to jump to: the basemap's city and town labels (fetched on first open), or the About panel's cities. */
async function loadPlaces(): Promise<Place[]> {
  let labels: Label[] = [];
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
    labels = [...seen.values()];
  } catch {
    /* offline: the About panel's cities below */
  }
  if (!labels.length) labels = CITIES.map((c, i) => [c.name.replace(/, [A-Z]{2}$/, ''), c.lng, c.lat, 0, 'city', 100 - i]);
  const count = new Map<string, number>();
  for (const l of labels) count.set(l[0], (count.get(l[0]) ?? 0) + 1);
  // Several Springfields: each says its state ("Springfield, IL"); one beyond the outlines keeps a plain name. Two in
  // the same state (Oakwood, OH) also name the nearest big city: "Oakwood, OH (near Dayton)".
  const ps: Place[] = labels.map((l) => {
    const st = stateAt(l[1], l[2]);
    return { name: l[0], lat: l[2], lng: l[1], pop: l[5], inside: !!st?.core, tag: count.get(l[0])! > 1 ? st?.abbr : undefined };
  });
  const twice = new Map<string, number>();
  for (const p of ps) twice.set(full(p), (twice.get(full(p)) ?? 0) + 1);
  const big = labels.filter((l) => l[4] === 'city').sort((a, b) => b[5] - a[5]).slice(0, 60);
  const d = (p: Place, l: Label) => ((p.lng - l[1]) * 0.75) ** 2 + (p.lat - l[2]) ** 2;
  for (const p of ps)
    if (twice.get(full(p))! > 1) {
      const near = big.filter((l) => l[0] !== p.name).sort((a, b) => d(p, a) - d(p, b))[0];
      if (near) p.tag = `${p.tag ?? ''}${p.tag ? ' ' : ''}(near ${near[0]})`;
    }
  return ps.sort((a, b) => Number(b.inside) - Number(a.inside) || b.pop - a.pop);
}


/**
 * "Find a town": a name box that opens beside its button (or inside the About panel, from its own button), with
 * suggestions as you type. Places in the forecast states come first; a name that fits several asks which one.
 */
export function mountFinder(
  btn: HTMLButtonElement,
  form: HTMLFormElement,
  go: (lat: number, lng: number, name: string) => void,
  say: (text: string, from?: Element | null) => void,
) {
  const input = form.querySelector('input')!;
  const list = form.querySelector('ul')!;
  const home = form.parentElement!;
  let places: Promise<Place[]> | null = null;
  let shown: Place[] = [];
  let active = -1;
  let opener: HTMLElement = btn;
  // A phone keyboard covers the bottom of the page without shrinking it: lift the box above the keyboard.
  const vv = window.visualViewport;
  const keyboardUp = () => (vv ? innerHeight - vv.height - vv.offsetTop > 60 : false);
  // Resolves when the visible area has stopped changing for 150 ms (300 ms before the keyboard starts going), or
  // after 800 ms.
  const settled = () =>
    new Promise<void>((done) => {
      let quiet = 0;
      const finish = () => {
        clearTimeout(quiet);
        clearTimeout(cap);
        vv?.removeEventListener('resize', bump);
        done();
      };
      const bump = () => {
        clearTimeout(quiet);
        quiet = window.setTimeout(finish, 150);
      };
      const cap = window.setTimeout(finish, 800);
      vv?.addEventListener('resize', bump);
      quiet = window.setTimeout(finish, 300);
    });
  // Beside its button: above it when the buttons sit in a row (the time bar), to its left when they stand in a column
  // (a phone's floating stack). Lifted over a phone keyboard.
  const place = () => {
    if (form.classList.contains('inline')) return void (list.style.maxHeight = '');
    const b = btn.getBoundingClientRect();
    const box = home.getBoundingClientRect();
    const column = getComputedStyle(btn.parentElement!).flexDirection === 'column';
    form.style.right = `${Math.max(8, (column ? box.right - b.left : box.right - b.right) + (column ? 8 : 0))}px`;
    // In the time bar it sits on the bar's top edge, clear of its text line.
    const top = Math.min(b.top, btn.closest('#dock')?.getBoundingClientRect().top ?? b.top);
    form.style.bottom = `${column ? box.bottom - b.bottom : box.bottom - top + 6}px`;
    // Lifted just enough to clear what a phone keyboard covers (the visual viewport's bottom), no further.
    form.style.transform = '';
    const lift = vv ? Math.max(0, form.getBoundingClientRect().bottom - (vv.offsetTop + vv.height) + 6) : 0;
    form.style.transform = lift ? `translateY(${-lift}px)` : '';
    // The suggestions stack above the box: keep them inside what the keyboard leaves showing, scrolling if need be.
    const row = form.querySelector('.find-row')!.getBoundingClientRect();
    // and below the header (its menus stay usable): the list's top keeps 6 px clear of both.
    const ceiling = Math.max(vv?.offsetTop ?? 0, document.getElementById('top')?.getBoundingClientRect().bottom ?? 0) + 6;
    list.style.maxHeight = `${Math.max(36, row.top - 11 - ceiling)}px`; // 11: the list's gap to the box, the label's padding
  };
  const setActive = (i: number) => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `find-o${i}`), list.children[i]?.scrollIntoView({ block: 'nearest' });
    else input.removeAttribute('aria-activedescendant');
  };
  const showList = (ps: Place[]) => {
    shown = ps;
    list.replaceChildren(
      ...ps.map((p, i) => {
        const li = Object.assign(document.createElement('li'), { id: `find-o${i}`, role: 'option', textContent: full(p) });
        if (!p.inside) li.append(Object.assign(document.createElement('small'), { textContent: ' \u00b7 no forecast here' }));
        return li;
      }),
    );
    list.hidden = !ps.length;
    input.setAttribute('aria-expanded', String(!!ps.length));
    setActive(-1);
  };
  const open = (on: boolean, from: HTMLElement = btn) => {
    form.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    showList([]);
    if (on) {
      opener = from;
      // Opened from the About panel: the box goes in the panel, under its button.
      const inline = from !== btn;
      form.classList.toggle('inline', inline);
      if (inline) from.after(form);
      else if (form.parentElement !== home) home.append(form);
      places ??= loadPlaces();
      input.value = '';
      input.focus();
      if (!inline) vv?.addEventListener('resize', place);
      place();
    } else {
      // Back beside its button: the About panel redraws its contents, which would take the box with them.
      if (form.parentElement !== home) home.append(form);
      vv?.removeEventListener('resize', place);
      form.style.transform = '';
      opener.focus({ preventScroll: true });
    }
  };
  btn.addEventListener('click', () => open(form.hidden || form.classList.contains('inline')));
  const fly = async (p: Place) => {
    const keyboard = keyboardUp();
    open(false);
    // Fly once the phone keyboard has gone: the screen settling under a flight would stop it halfway.
    if (keyboard) await settled();
    if (!form.hidden) return; // opened again for another search meanwhile
    go(p.lat, p.lng, full(p));
  };
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  // Names that start with what was typed (or have a word that does), places in the forecast states first.
  const matches = (ps: Place[], q: string) => ps.filter((p) => norm(full(p)).startsWith(q) || norm(p.name).includes(` ${q}`));
  const suggest = async () => {
    const typed = input.value;
    const q = norm(typed);
    if (!q || !places) return showList([]);
    const ps = await places;
    if (input.value !== typed) return;
    showList(matches(ps, q).slice(0, 6));
  };
  input.addEventListener('input', () => void suggest());
  const pick = async () => {
    if (active >= 0 && shown[active]) return fly(shown[active]!);
    const typed = input.value;
    const q = norm(typed);
    if (!q || !places) return;
    const ps = await places;
    if (form.hidden || input.value !== typed) return; // closed or retyped while the names loaded
    // "Springfield": every Springfield. "Springfield, OH" or a unique name: that one.
    let hits = ps.filter((p) => norm(full(p)) === q || norm(p.name) === q);
    if (!hits.length) hits = matches(ps, q);
    if (!hits.length) return say(`No town named ${typed.trim()} on this map`, opener);
    // A place the map forecasts beats one it doesn't (Springfield, Illinois over Springfield, Missouri).
    const inside = hits.filter((p) => p.inside);
    if (inside.length) hits = inside;
    const exact = hits.filter((p) => norm(p.name) === q || norm(full(p)) === q);
    if (exact.length === 1 || (!exact.length && hits.length === 1)) return fly(exact[0] ?? hits[0]!);
    // Several fit: list them and let the reader choose.
    showList((exact.length ? exact : hits).slice(0, 6));
    setActive(0);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void pick();
  });
  // Pressing an option keeps the focus in the box (no blur), so the click lands.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = (e.target as Element).closest('li');
    const p = li && shown[[...list.children].indexOf(li)];
    if (p) void fly(p);
  });
  form.querySelector('.find-x')!.addEventListener('click', () => open(false));
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      open(false);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
      e.preventDefault();
      setActive((active + (e.key === 'ArrowDown' ? 1 : shown.length - 1 + (active < 0 ? 1 : 0))) % shown.length);
    }
  });
  return {
    open: (from: HTMLElement) => open(true, from),
    /** Close the box if it is open inside the About panel (the panel is closing or redrawing). */
    leave: () => void (!form.hidden && form.classList.contains('inline') && open(false)),
  };
}
