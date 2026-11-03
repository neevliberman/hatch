import type { SpeciesEntry } from '../species';
import { atlasKey, atlasYearInfo, json, loadAtlasYear, loadIndex, loadOffSchedule, loadQuiet, loadSurprises, loadTwins, offNote, outOn, seasonDues, type AtlasSpecies, type Quiet, type Surprise } from '../atlas/index';
import { nameOf, ORDER_NAMES, searchSpecies } from '../atlas/names';
import type { Due } from '../core/layer';
import { CROSS, STAR } from './icons';
import { dueShort } from './near';
import { loadWatch, saveWatch, WATCH_MAX } from './watch';
import type { TNode, TreeData, TreeOfLife } from './treeOfLife';

// While the year is still coming in (year.json so_far), its strips say so.
const soFar = () => (atlasYearInfo.soFar ? ' so far' : '');
const offCaption = (year: number) => `${year}${soFar()}: furthest off schedule`;
const oddCaption = (year: number) => `${year} surprises${soFar()}`;
const quietCaption = (year: number) => `${year}: fewer photos so far`;
// The seen counts are research-grade photos only: a hard-to-name insect's photos can wait months for identifications.
const QUIET_NOTE = 'Photo-based: counts identified iNaturalist photos, not insects. Hard-to-identify species are still gaining IDs.';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Where the browse stands: every insect, one order, or one family in it. */
type Path = { order?: string; family?: string };

export interface SpeciesPicker {
  /** Show the species on screen in the header button. */
  show(key: string, label: string): void;
  /** The header button, for hiding it. */
  readonly button: HTMLButtonElement;
  set disabled(on: boolean);
  /** Pick a random insect from the whole Atlas; resolves once it is chosen. */
  surprise(): Promise<void>;
}

/**
 * The species picker: a header button that opens a search box over a tree of life, so finding one of nearly 2,000
 * species never means scrolling a menu. The tree is a real family tree you can pinch and tap (src/ui/treeOfLife.ts,
 * loaded on first open); if it can't load, a plain list of orders and families stands in. The hand-built species
 * sit on a strip above it, as "Featured", and the year's surprises on a second (seen.py); every Atlas species is a search away, by common or Latin name.
 * Analogy: a field guide's index and its table of contents on one page.
 *
 * The Atlas's species list is only fetched when the picker first opens. A species the hand-built list also has (the
 * luna moth) opens its own richer layer: `featured` maps its scientific name to that key.
 */
export function mountSpeciesPicker(
  button: HTMLButtonElement,
  sheet: HTMLElement,
  featured: SpeciesEntry[],
  /** The year whose surprises it lists (seen-YEAR.json): read once the species list has loaded (ATLAS_YEAR). */
  surpriseYear: () => number,
  /** A species picked; `season` when a row asks for one (a surprise opens on its year). */
  onPick: (key: string, season?: string) => void,
  /** The map's day (its day of year, whether it is ATLAS_YEAR's own season, and its words), for the tree's glow. */
  day?: () => { doy: number; year: boolean; label: string },
  /** The watch list's clock (the page's, so ?today= moves it). */
  /** The watch list's clock (the page's, so ?today= moves it) and, for the species on screen with a saved place, its
   * season there (the same Due as the line under the map, so the two always agree). */
  watching?: { now: () => number; due: (key: string) => Due | null },
): SpeciesPicker {
  const bySci = new Map(featured.filter((e) => e.sci).map((e) => [e.sci!, e.key] as const));
  const keyOf = (s: AtlasSpecies) => bySci.get(s.name) ?? atlasKey(s.name);
  let all: AtlasSpecies[] | null = null;
  let odd: Surprise[] = [];
  let off: [number, number][] = [];
  let quiet: Quiet[] = [];
  let path: Path = {};
  let q = '';
  let refocus = false;
  let tree: TreeOfLife | null = null;
  let treeTried = false;
  let currentKey = featured[0]?.key ?? ''; // the page opens on the first featured species unless a link picks another
  let treeCrumbs: (() => void) | null = null; // redraws the tree's breadcrumb after a search clears

  // A plain list of buttons (Tab or the arrow keys walk it), not a listbox: each row is an action, not a selection.
  sheet.innerHTML = `<div class="sp-head"><input id="sp-q" type="search" aria-controls="sp-list"
      placeholder="Search insects" autocomplete="off" enterkeyhint="search" aria-label="Search insects">
    <button type="button" class="sp-star icon-btn" aria-pressed="false">${STAR}</button>
    <button type="button" class="sp-x icon-btn" aria-label="Close">${CROSS}</button></div>
    <ul id="sp-watch" class="sp-strip" aria-label="Watching" hidden></ul>
    <p id="sp-wnote" class="sp-fine" role="status" hidden></p>
    <nav class="sp-crumbs" aria-label="Tree of life" aria-live="polite"></nav>
    <ul id="sp-list" aria-label="Species"></ul>
    <ul id="sp-twins" class="sp-strip" aria-label="Flies with" hidden></ul>
    <ul id="sp-odd" class="sp-strip" aria-label="${oddCaption(surpriseYear())}" hidden></ul>
    <ul id="sp-off" class="sp-strip" aria-label="${offCaption(surpriseYear())}" hidden></ul>
    <ul id="sp-quiet" class="sp-strip" aria-label="${quietCaption(surpriseYear())}" hidden></ul>
    <div class="sp-tree" hidden></div>`;
  const input = sheet.querySelector<HTMLInputElement>('#sp-q')!;
  const crumbs = sheet.querySelector<HTMLElement>('.sp-crumbs')!;
  const list = sheet.querySelector<HTMLUListElement>('#sp-list')!;
  const oddStrip = sheet.querySelector<HTMLUListElement>('#sp-odd')!; // the surprises, as a second strip over the tree
  const offStrip = sheet.querySelector<HTMLUListElement>('#sp-off')!; // the most off-schedule, a third strip
  const quietStrip = sheet.querySelector<HTMLUListElement>('#sp-quiet')!; // the quietest in photos, a fourth
  // "Flies with": the species whose typical Midwest season best matches the one on the map (pickTwins, season.bin),
  // worked out in the browser when the sheet opens on a new species.
  const twinStrip = sheet.querySelector<HTMLUListElement>('#sp-twins')!;
  let twins: number[] = [];
  let twinsFor = '';
  const treeHost = sheet.querySelector<HTMLElement>('.sp-tree')!;
  const indexOfKey = (key: string) => (all ? all.findIndex((s) => keyOf(s) === key) : -1);

  // The watch list: species starred from the sheet's head, kept in this browser (src/ui/watch.ts). Each shows as a chip
  // with the same one-line countdown as "Coming out near you" (src/ui/near.ts): for the species on the map with a saved
  // place, that place's season (exactly the line's); else the Atlas's typical Midwest season (season.bin, fetched only if
  // something is watched). Both come from one rule (seasonsOf), so the two differ only by place.
  const star = sheet.querySelector<HTMLButtonElement>('.sp-star')!;
  const watchStrip = sheet.querySelector<HTMLUListElement>('#sp-watch')!;
  const watchNote = sheet.querySelector<HTMLElement>('#sp-wnote')!;
  let watched = loadWatch() ?? [];
  let currentLabel = button.querySelector('.sp-face')?.textContent ?? '';
  let curves: Awaited<ReturnType<typeof seasonDues>> = null;
  let curvesTried = false;
  const labelOf = (key: string): string | null => {
    const f = featured.find((e) => e.key === key);
    if (f) return f.label;
    const s = all?.find((x) => keyOf(x) === key);
    return s ? nameOf(s) : key === currentKey ? currentLabel : null;
  };
  const setStar = () => {
    // A toggle: the label names the action and stays put, aria-pressed says whether it is on.
    const text = `Watch ${currentLabel}`;
    star.setAttribute('aria-pressed', String(watched.includes(currentKey)));
    star.setAttribute('aria-label', text);
    star.title = text;
  };
  const renderWatch = () => {
    if (all && watched.some((k) => labelOf(k) === null)) {
      watched = watched.filter((k) => labelOf(k) !== null); // a species the Atlas no longer lists
      saveWatch(watched);
    }
    const now = watching?.now() ?? Date.now();
    const chips = watched.map((k) => {
      const name = labelOf(k);
      if (name === null) return ''; // the Atlas list is not in yet
      const here = watching?.due(k) ?? null;
      const i = here || !curves ? -1 : indexOfKey(k);
      const due = here ?? (i >= 0 ? curves!(all![i]!.i) : null);
      const when = due ? dueShort(due, now) : '';
      const title = due ? (here ? 'Season at your saved place' : 'Typical season across the Midwest') : '';
      return `<li class="sp-chip"><button type="button" class="sp-go" data-key="${esc(k)}"${title ? ` title="${title}"` : ''}><b>${esc(name)}</b><span>${when}</span></button><button type="button" class="sp-wx" data-unwatch="${esc(k)}" aria-label="Stop watching ${esc(name)}">&times;</button></li>`;
    });
    // Nothing watched yet: one line on what the star does, while the tree shows (not over search results or a list still loading).
    const none = !watched.length && !!tree;
    watchStrip.hidden = (!chips.some(Boolean) && !none) || !!q.trim();
    // An async re-render must not drop keyboard focus, whether it was on a chip or on its cross.
    const el = document.activeElement as HTMLElement | null;
    const had = el?.closest('#sp-watch') ? (el.dataset.key ? `.sp-go[data-key="${el.dataset.key}"]` : el.dataset.unwatch ? `.sp-wx[data-unwatch="${el.dataset.unwatch}"]` : '') : '';
    watchStrip.innerHTML = `<li class="sp-lab">Watching</li>${none ? '<li class="sp-none">Tap ☆ to watch.</li>' : chips.join('')}`;
    if (had) watchStrip.querySelector<HTMLElement>(had)?.focus();
    setStar();
    // The typical-season curves are only fetched once something is watched that no saved place speaks for.
    if (all && !curves && !curvesTried && watched.length) {
      curvesTried = true;
      void seasonDues().then((c) => {
        curves = c;
        if (c) renderWatch();
      });
    }
  };
  const toggleWatch = () => {
    watchNote.hidden = true;
    watched = loadWatch() ?? watched; // another tab may have changed it; blocked storage keeps this visit's list
    if (watched.includes(currentKey)) watched = watched.filter((k) => k !== currentKey);
    else if (watched.length >= WATCH_MAX) {
      watchNote.textContent = `Watch list is full (${WATCH_MAX}). Remove one first.`;
      watchNote.hidden = false;
      return;
    } else watched = [currentKey, ...watched];
    saveWatch(watched);
    renderWatch();
  };
  const pick = (key: string, season?: string) => {
    open(false);
    button.focus();
    refocus = true; // the button is disabled while the species loads, which drops focus: hand it back after
    onPick(key, season);
  };
  /** On a phone, once the tree is touched the strips above it fold away and the tree takes their room (style.css);
   * they come back with the whole tree ("All insects") or the next time the sheet opens. */
  const roomy = (on: boolean) => sheet.classList.toggle('sp-tree-only', on);
  /** The tree, once: its data and code load on first open, after the species list. */
  const loadTree = async () => {
    if (treeTried || !all) return;
    treeTried = true;
    const [data, mod] = await Promise.all([json<TreeData>('tree.json'), import('./treeOfLife').catch(() => null)]);
    if (!data || !mod) return;
    try {
      tree = mod.mountTree(treeHost, data, all, (i) => pick(keyOf(all![i]!)), (path: TNode[], go) => {
        treeCrumbs = () => {
          crumbs.innerHTML = '';
          path.forEach((n, i) => {
            if (i) crumbs.insertAdjacentHTML('beforeend', '<span aria-hidden="true"> › </span>');
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = n.parent ? n.name : 'All insects';
            if (n.name !== n.label) b.title = n.label; // the Latin name, for anyone who wants it
            b.addEventListener('click', () => {
              if (!n.parent) roomy(false); // back to the whole tree: the strips come back too
              go(n);
            });
            crumbs.append(b);
          });
          crumbs.scrollLeft = crumbs.scrollWidth; // a long trail shows its end: where the tree is now
        };
        if (!q.trim()) treeCrumbs();
      }, () => roomy(true));
    } catch (e) {
      // tree.json and species.json out of step (a stale cache): the plain list stays.
      console.warn('tree of life', e);
      tree = null;
      treeCrumbs = null;
      treeHost.innerHTML = '';
      return;
    }
    const i = indexOfKey(currentKey);
    tree.mark(i >= 0 ? i : null);
    render();
  };

  // A featured species goes by its own label ("Luna moth", not "North American Luna Moth"), as on the featured strip.
  const featuredLabels = new Map(featured.filter((e) => e.sci).map((e) => [e.sci!, e.label] as const));
  const row = (s: AtlasSpecies) =>
    `<li><button type="button" class="sp-row" data-key="${esc(keyOf(s))}">${s.photo
      ? `<img src="${esc(s.photo)}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer">`
      : '<i class="sp-blank"></i>'}<span class="sp-name">${esc(featuredLabels.get(s.name) ?? nameOf(s))}${s.common ? `<i>${esc(s.name)}</i>` : ''}</span></button></li>`;
  const group = (label: string, sub: string, data: string) =>
    `<li><button type="button" class="sp-group" ${data}><span class="sp-name">${esc(label)}${sub ? `<i>${esc(sub)}</i>` : ''}</span><span class="sp-n"></span></button></li>`;
  const counted = (html: string, n: number) => html.replace('<span class="sp-n"></span>', `<span class="sp-n">${n.toLocaleString()}</span>`);
  const tally = (xs: AtlasSpecies[], k: 'order' | 'family') => {
    const m = new Map<string, number>();
    for (const s of xs) if (s[k]) m.set(s[k]!, (m.get(s[k]!) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };

  // Search (searchSpecies): an exact or whole-word match on the common name, or a featured species, first.
  const search = (text: string) => searchSpecies(all!, text, featuredLabels);

  // The hand-built species, there at once (the one-file build has no Atlas list at all); photos once the list is in.
  // The year's surprises: photos well over or under what the network expected, or a season well off (seen.py).
  const surprises = () =>
    odd
      .map(({ i, note }) => {
        const s = all?.find((x) => x.i === i);
        return s ? row(s).replace('data-key=', `data-season="${surpriseYear()}" data-key=`).replace('</span></button>', `</span><span class="sp-n">${esc(note)}</span></button>`) : '';
      })
      .join('');
  // The most off-schedule species (days early amber, late blue); the same rows as the surprises, one line each.
  const offRows = () =>
    off
      .map(([i, d]) => {
        const s = all?.find((x) => x.i === i);
        const n = `<span class="sp-n sp-${d > 0 ? 'early' : 'late'}">${offNote(d)}</span>`;
        return s ? row(s).replace('data-key=', `data-season="${surpriseYear()}" data-key=`).replace('</span></button>', `</span>${n}</button>`) : '';
      })
      .join('');
  // The species with the fewest photos against expected: "5 of 336" photos seen of those expected (photos, not abundance).
  const quietRows = () =>
    quiet
      .map(({ i, seen, expected }) => {
        const s = all?.find((x) => x.i === i);
        const n = `<span class="sp-n" title="${seen} identified photos so far, ${expected} expected">${seen} of ${expected}</span>`;
        return s ? row(s).replace('data-key=', `data-season="${surpriseYear()}" data-key=`).replace('</span></button>', `</span>${n}</button>`) : '';
      })
      .join('');
  const twinRows = () =>
    twins
      .map((i) => {
        const s = all?.find((x) => x.i === i);
        return s ? row(s) : '';
      })
      .join('');
  const twinList = () => (twins.length && all ? `<li class="sp-sec">Flies with</li>${twinRows()}` : '');
  // The current species' twins, once per species: a re-render when they arrive.
  const findTwins = () => {
    const k = currentKey;
    if (!all || twinsFor === k) return;
    twinsFor = k;
    twins = [];
    const i = indexOfKey(k);
    if (i < 0) return;
    void loadTwins(all, all[i]!.i).then((t) => {
      if (twinsFor !== k) return;
      if (!t) return void (twinsFor = ''); // a failed fetch tries again next time
      twins = t;
      if (!sheet.hidden) render();
    });
  };
  const quietList = () =>
    quiet.length && all ? `<li class="sp-sec">${quietCaption(surpriseYear())}</li>${quietRows()}<li class="sp-note sp-fine">${QUIET_NOTE}</li>` : '';
  const offList = () =>
    off.length && all ? `<li class="sp-sec">${offCaption(surpriseYear())}</li>${offRows()}<li class="sp-note sp-fine">Photo-based: counts iNaturalist photos, not insects.</li>` : '';
  const surpriseRows = () => (odd.length && all ? `<li class="sp-sec">${oddCaption(surpriseYear())}</li>${surprises()}` : '');
  const featuredRows = () =>
    featured
      .map((e) => {
        const s = all?.find((x) => x.name === e.sci);
        return `<li><button type="button" class="sp-row sp-feat" data-key="${esc(e.key)}">${s?.photo
          ? `<img src="${esc(s.photo)}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer">`
          : '<i class="sp-blank"></i>'}<span class="sp-name">${esc(e.label)}${e.sci ? `<i>${esc(e.sci)}</i>` : ''}</span></button></li>`;
      })
      .join('');
  const render = () => {
    findTwins(); // first: a new species clears the last one's twins before the strip's visibility is set
    treeHost.hidden = !tree || !!q.trim();
    sheet.classList.toggle('sp-has-tree', !treeHost.hidden);
    list.classList.toggle('sp-strip', !treeHost.hidden);
    oddStrip.hidden = treeHost.hidden || !odd.length;
    offStrip.hidden = treeHost.hidden || !off.length;
    quietStrip.hidden = treeHost.hidden || !quiet.length;
    twinStrip.hidden = treeHost.hidden || !twins.length;
    renderWatch();
    if (!all) {
      list.innerHTML = `<li class="sp-sec">Featured forecasts</li>${featuredRows()}<li class="sp-note">Loading the rest…</li>`;
      crumbs.innerHTML = '';
      return;
    }
    if (q.trim()) {
      const hits = search(q.trim());
      // No hits: one line in the list (the box's own × clears it), announced through the crumbs' live region.
      crumbs.innerHTML = hits.length ? `<span>${hits.length === 1 ? '1 match' : `${hits.length === 60 ? 'Top 60' : hits.length} matches`}</span>` : '<span class="sr">No matches</span>';
      list.innerHTML = hits.length ? hits.map(row).join('') : '<li class="sp-note sp-none">No matches. Try the Latin name.</li>';
      return;
    }
    if (tree) {
      list.innerHTML = featuredRows();
      twinStrip.innerHTML = `<li class="sp-lab" title="Typical season across the Midwest">Flies with</li>${twinRows()}`;
      oddStrip.innerHTML = `<li class="sp-lab">${oddCaption(surpriseYear())}</li>${surprises()}`;
      offStrip.innerHTML = `<li class="sp-lab" title="Photo-based: counts iNaturalist photos, not insects.">${offCaption(surpriseYear())}</li>${offRows()}`;
      quietStrip.innerHTML = `<li class="sp-lab" title="${QUIET_NOTE}">${quietCaption(surpriseYear())}</li>${quietRows()}`;
      treeCrumbs?.();
      tree.shown();
      glow();
      return;
    }
    const steps = [`<button type="button" data-crumb="">All insects</button>`];
    if (path.order) steps.push(`<button type="button" data-crumb="order">${esc(ORDER_NAMES[path.order] ?? path.order)}</button>`);
    if (path.family) steps.push(`<span>${esc(path.family)}</span>`);
    crumbs.innerHTML = steps.join('<span aria-hidden="true"> › </span>');
    if (!path.order) {
      list.innerHTML =
        `<li class="sp-sec">Featured forecasts</li>${featuredRows()}${twinList()}${surpriseRows()}${offList()}${quietList()}${all.length ? '<li class="sp-sec">Browse</li>' : ''}` +
        tally(all, 'order').map(([o, n]) => counted(group(ORDER_NAMES[o] ?? o, o, `data-order="${esc(o)}"`), n)).join('');
    } else if (!path.family) {
      const inOrder = all.filter((s) => s.order === path.order);
      list.innerHTML = tally(inOrder, 'family').map(([f, n]) => counted(group(f, '', `data-family="${esc(f)}"`), n)).join('');
    } else {
      list.innerHTML = all.filter((s) => s.family === path.family).sort((a, b) => b.n - a.n).map(row).join('');
    }
  };

  // The insects out on the map's day glow round the tree's rim (Atlas season curves: at least a quarter of their best
  // day). Worked out each time the tree shows, as the map's day may have moved.
  let glowKey = '';
  const glow = () => {
    const d = day?.();
    const k = d ? `${d.doy}|${d.year}` : '';
    if (!d || k === glowKey) return;
    glowKey = k;
    void outOn(d.doy, d.year).then((v) => {
      if (!v) glowKey = ''; // a failed fetch tries again next time
      if (!tree || glowKey !== k) return;
      tree.glow(v, d.label);
    });
  };

  const open = (on: boolean) => {
    sheet.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (!on) return;
    watchNote.hidden = true;
    roomy(false);
    render();
    // Touch screens: land on the close button instead, so the keyboard doesn't cover the tree until search is tapped.
    (matchMedia('(pointer: fine)').matches ? input : sheet.querySelector<HTMLElement>('.sp-x')!).focus();
    loadAll();
  };
  /** The Atlas's list and its strips, on first open (and again from "Try again" after a failed load). */
  let fetching = false;
  const loadAll = () => {
    if (all || fetching) return;
    fetching = true;
    void loadAtlasYear().then((y) => Promise.all([loadIndex(), loadSurprises(y), loadOffSchedule(y), loadQuiet(y)])).then(([s, u, o, qu]) => {
      fetching = false;
      oddStrip.setAttribute('aria-label', `${oddCaption(surpriseYear())}`);
      offStrip.setAttribute('aria-label', offCaption(surpriseYear()));
      quietStrip.setAttribute('aria-label', quietCaption(surpriseYear()));
      odd = u?.list ?? [];
      off = o ?? [];
      quiet = qu ?? [];
      if (s) all = s;
      if (s) void loadTree();
      else list.innerHTML = `<li class="sp-sec">Featured forecasts</li>${featuredRows()}<li class="sp-note sp-none">Couldn’t load the other insects. <button type="button" class="sp-act" data-retry>Try again</button></li>`;
      if (s) render();
    });
  };
  button.addEventListener('click', () => open(sheet.hidden));
  sheet.querySelector('.sp-x')!.addEventListener('click', () => (open(false), button.focus()));
  star.addEventListener('click', toggleWatch);
  input.addEventListener('input', () => {
    q = input.value;
    render();
  });
  sheet.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.unwatch) {
      const chip = b.closest('li');
      const next = (chip?.nextElementSibling ?? chip?.previousElementSibling)?.querySelector<HTMLElement>('.sp-go');
      watched = (loadWatch() ?? watched).filter((k) => k !== b.dataset.unwatch);
      saveWatch(watched);
      renderWatch();
      (next ? watchStrip.querySelector<HTMLElement>(`.sp-go[data-key="${next.dataset.key}"]`) : star)?.focus();
    } else if (b.dataset.retry !== undefined) {
      render(); // "Loading the rest…" while it asks again
      input.focus(); // the button has gone with the redraw
      loadAll();
    } else if (b.dataset.key) pick(b.dataset.key, b.dataset.season);
    else if (b.dataset.order) (path = { order: b.dataset.order }), render(), list.scrollTo?.(0, 0);
    else if (b.dataset.family) (path = { ...path, family: b.dataset.family }), render(), list.scrollTo?.(0, 0);
    else if (b.dataset.crumb !== undefined) (path = b.dataset.crumb ? { order: path.order } : {}), render();
  });
  // Arrow keys walk the list from the search box; Escape closes.
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // the page's own Escape would also unpin the card on the map
      open(false);
      button.focus();
      return;
    }
    if (e.key === 'Tab') {
      // The sheet covers the page, so Tab loops inside it instead of walking onto controls hidden behind.
      const tabs = [...sheet.querySelectorAll<HTMLElement>('button, input, select, a[href], summary, canvas[tabindex], [tabindex="0"]')].filter((el) => el.offsetParent !== null);
      const first = tabs[0], last = tabs[tabs.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      return;
    }
    if (e.target === treeHost.querySelector('canvas')) return; // the tree walks its own branches
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...sheet.querySelectorAll<HTMLButtonElement>('#sp-watch:not([hidden]) .sp-go, #sp-list button, #sp-twins:not([hidden]) button, #sp-odd:not([hidden]) button, #sp-off:not([hidden]) button, #sp-quiet:not([hidden]) button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(items.length - 1, i + 1)) : i <= 0 ? -1 : i - 1;
    e.preventDefault();
    (next < 0 ? input : items[next])?.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // The top match, once there are matches: never a featured row standing in while the list loads.
    if (all && q.trim()) list.querySelector<HTMLButtonElement>('.sp-row')?.click();
  });
  // Tabbing out of it closes it, as a tap outside does.
  sheet.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && !sheet.contains(to) && to !== button) open(false);
  });
  // A tap outside closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!sheet.hidden && !sheet.contains(e.target as Node) && !button.contains(e.target as Node)) open(false);
  });

  return {
    button,
    async surprise() {
      const s = all ?? (await loadIndex());
      if (!s?.length) return;
      all = s;
      pick(keyOf(s[Math.floor(Math.random() * s.length)]!));
    },
    show(key, label) {
      currentKey = key;
      currentLabel = label;
      setStar();
      const i = indexOfKey(key);
      tree?.mark(i >= 0 ? i : null);
      // A hyphenated word ("Red-spotted") stays whole when a phone's button wraps the name: lines break between words.
      button.querySelector('.sp-face')!.replaceChildren(...label.split(/( )/).map((w) => {
        if (!w.includes('-')) return w;
        const s = document.createElement('span');
        s.className = 'nb';
        s.textContent = w;
        return s;
      }));
      button.setAttribute('aria-label', `Species: ${label}. Change species`);
    },
    set disabled(on: boolean) {
      button.disabled = on;
      if (!on && refocus) {
        refocus = false;
        if (document.activeElement === document.body) button.focus();
      }
    },
  };
}
