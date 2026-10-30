import type { SpeciesEntry } from '../species';
import { atlasKey, json, loadIndex, loadOffSchedule, loadSurprises, offNote, outOn, type AtlasSpecies, type Surprise } from '../atlas/index';
import { nameOf, ORDER_NAMES } from '../atlas/names';
import { CROSS } from './icons';
import type { TNode, TreeData, TreeOfLife } from './treeOfLife';

const offCaption = (year: number) => `${year}: furthest off schedule`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Where the browse stands: every insect, one order, or one family in it. */
type Path = { order?: string; family?: string };

export interface SpeciesPicker {
  /** Show the species on screen in the header button. */
  show(key: string, label: string): void;
  /** The header button, for its sketch mark (--mark) and for hiding it. */
  readonly button: HTMLButtonElement;
  set disabled(on: boolean);
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
  /** The year whose surprises it lists (seen-YEAR.json). */
  surpriseYear: number,
  /** A species picked; `season` when a row asks for one (a surprise opens on its year). */
  onPick: (key: string, season?: string) => void,
  /** The map's day (its day of year, whether it is ATLAS_YEAR's own season, and its words), for the tree's glow. */
  day?: () => { doy: number; year: boolean; label: string },
): SpeciesPicker {
  const bySci = new Map(featured.filter((e) => e.sci).map((e) => [e.sci!, e.key] as const));
  const keyOf = (s: AtlasSpecies) => bySci.get(s.name) ?? atlasKey(s.name);
  let all: AtlasSpecies[] | null = null;
  let odd: Surprise[] = [];
  let off: [number, number][] = [];
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
    <button type="button" class="sp-x icon-btn" aria-label="Close">${CROSS}</button></div>
    <nav class="sp-crumbs" aria-label="Tree of life" aria-live="polite"></nav>
    <ul id="sp-list" aria-label="Species"></ul>
    <ul id="sp-odd" class="sp-strip" aria-label="${surpriseYear} surprises" hidden></ul>
    <ul id="sp-off" class="sp-strip" aria-label="${offCaption(surpriseYear)}" hidden></ul>
    <div class="sp-tree" hidden></div>`;
  const input = sheet.querySelector<HTMLInputElement>('#sp-q')!;
  const crumbs = sheet.querySelector<HTMLElement>('.sp-crumbs')!;
  const list = sheet.querySelector<HTMLUListElement>('#sp-list')!;
  const oddStrip = sheet.querySelector<HTMLUListElement>('#sp-odd')!; // the surprises, as a second strip over the tree
  const offStrip = sheet.querySelector<HTMLUListElement>('#sp-off')!; // the most off-schedule, a third strip
  const treeHost = sheet.querySelector<HTMLElement>('.sp-tree')!;
  const indexOfKey = (key: string) => (all ? all.findIndex((s) => keyOf(s) === key) : -1);
  const pick = (key: string, season?: string) => {
    open(false);
    button.focus();
    refocus = true; // the button is disabled while the species loads, which drops focus: hand it back after
    onPick(key, season);
  };
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
            b.textContent = n.parent ? (n.rank === 'o' ? (ORDER_NAMES[n.label] ?? n.label) : n.label) : 'All insects';
            b.addEventListener('click', () => go(n));
            crumbs.append(b);
          });
        };
        if (!q.trim()) treeCrumbs();
      });
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

  const row = (s: AtlasSpecies) =>
    `<li><button type="button" class="sp-row" data-key="${esc(keyOf(s))}">${s.photo
      ? `<img src="${esc(s.photo)}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer">`
      : '<i class="sp-blank"></i>'}<span class="sp-name">${esc(nameOf(s))}${s.common ? `<i>${esc(s.name)}</i>` : ''}</span></button></li>`;
  const group = (label: string, sub: string, data: string) =>
    `<li><button type="button" class="sp-group" ${data}><span class="sp-name">${esc(label)}${sub ? `<i>${esc(sub)}</i>` : ''}</span><span class="sp-n"></span></button></li>`;
  const counted = (html: string, n: number) => html.replace('<span class="sp-n"></span>', `<span class="sp-n">${n.toLocaleString()}</span>`);
  const tally = (xs: AtlasSpecies[], k: 'order' | 'family') => {
    const m = new Map<string, number>();
    for (const s of xs) if (s[k]) m.set(s[k]!, (m.get(s[k]!) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };

  // Search: every word must start a word of the name, Latin name, family or order; best match first, then most seen.
  const search = (text: string) => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (s: AtlasSpecies) => `${s.common ?? ''} ${s.name} ${s.genus ?? ''} ${s.family ?? ''} ${s.order ?? ''} ${ORDER_NAMES[s.order ?? ''] ?? ''}`.toLowerCase();
    const starts = (h: string, w: string) => h.startsWith(w) || h.includes(` ${w}`) || h.includes(`-${w}`);
    const score = (s: AtlasSpecies) => {
      const h = hay(s);
      if (!words.every((w) => starts(h, w))) return -1;
      const n = nameOf(s).toLowerCase();
      return (n.startsWith(text.toLowerCase()) ? 2 : 0) + (starts(n, words[0]!) ? 1 : 0);
    };
    return all!
      .map((s) => ({ s, k: score(s) }))
      .filter((x) => x.k >= 0)
      .sort((a, b) => b.k - a.k || b.s.n - a.s.n)
      .slice(0, 60)
      .map((x) => x.s);
  };

  // The hand-built species, there at once (the one-file build has no Atlas list at all); photos once the list is in.
  // The year's surprises: photos well over or under what the network expected, or a season well off (seen.py).
  const surprises = () =>
    odd
      .map(({ i, note }) => {
        const s = all?.find((x) => x.i === i);
        return s ? row(s).replace('data-key=', `data-season="${surpriseYear}" data-key=`).replace('</span></button>', `</span><span class="sp-n">${esc(note)}</span></button>`) : '';
      })
      .join('');
  // The most off-schedule species (days early amber, late blue); the same rows as the surprises, one line each.
  const offRows = () =>
    off
      .map(([i, d]) => {
        const s = all?.find((x) => x.i === i);
        const n = `<span class="sp-n sp-${d > 0 ? 'early' : 'late'}">${offNote(d)}</span>`;
        return s ? row(s).replace('data-key=', `data-season="${surpriseYear}" data-key=`).replace('</span></button>', `</span>${n}</button>`) : '';
      })
      .join('');
  const offList = () =>
    off.length && all ? `<li class="sp-sec">${offCaption(surpriseYear)}</li>${offRows()}<li class="sp-note sp-fine">Photo-based: counts iNaturalist photos, not insects.</li>` : '';
  const surpriseRows = () => (odd.length && all ? `<li class="sp-sec">${surpriseYear} surprises</li>${surprises()}` : '');
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
    treeHost.hidden = !tree || !!q.trim();
    sheet.classList.toggle('sp-has-tree', !treeHost.hidden);
    list.classList.toggle('sp-strip', !treeHost.hidden);
    oddStrip.hidden = treeHost.hidden || !odd.length;
    offStrip.hidden = treeHost.hidden || !off.length;
    if (!all) {
      list.innerHTML = `<li class="sp-sec">Featured forecasts</li>${featuredRows()}<li class="sp-note">Loading the rest…</li>`;
      crumbs.innerHTML = '';
      return;
    }
    if (q.trim()) {
      const hits = search(q.trim());
      crumbs.innerHTML = `<span>${hits.length ? hits.length === 1 ? '1 match' : `${hits.length === 60 ? 'Top 60' : hits.length} matches` : 'No matches'}</span>`;
      list.innerHTML = hits.map(row).join('');
      return;
    }
    if (tree) {
      list.innerHTML = featuredRows();
      oddStrip.innerHTML = `<li class="sp-lab">${surpriseYear} surprises</li>${surprises()}`;
      offStrip.innerHTML = `<li class="sp-lab" title="Photo-based: counts iNaturalist photos, not insects.">${offCaption(surpriseYear)}</li>${offRows()}`;
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
        `<li class="sp-sec">Featured forecasts</li>${featuredRows()}${surpriseRows()}${offList()}${all.length ? '<li class="sp-sec">Browse</li>' : ''}` +
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
    render();
    // Touch screens: land on the close button instead, so the keyboard doesn't cover the tree until search is tapped.
    (matchMedia('(pointer: fine)').matches ? input : sheet.querySelector<HTMLElement>('.sp-x')!).focus();
    if (!all)
      void Promise.all([loadIndex(), loadSurprises(surpriseYear), loadOffSchedule(surpriseYear)]).then(([s, u, o]) => {
        odd = u?.list ?? [];
        off = o ?? [];
        if (s) all = s;
        if (s) void loadTree();
        else list.innerHTML = `<li class="sp-sec">Featured forecasts</li>${featuredRows()}<li class="sp-note">Couldn’t load the other insects. Close and try again.</li>`;
        if (s) render();
      });
  };
  button.addEventListener('click', () => open(sheet.hidden));
  sheet.querySelector('.sp-x')!.addEventListener('click', () => (open(false), button.focus()));
  input.addEventListener('input', () => {
    q = input.value;
    render();
  });
  sheet.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.key) pick(b.dataset.key, b.dataset.season);
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
    if (e.target === treeHost.querySelector('canvas')) return; // the tree walks its own branches
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...sheet.querySelectorAll<HTMLButtonElement>('#sp-list button, #sp-odd:not([hidden]) button, #sp-off:not([hidden]) button')];
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
    show(key, label) {
      currentKey = key;
      const i = indexOfKey(key);
      tree?.mark(i >= 0 ? i : null);
      button.querySelector('.sp-face')!.textContent = label;
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
