import type { SpeciesEntry } from '../species';
import { atlasKey, loadIndex, type AtlasSpecies } from '../atlas/index';
import { nameOf, ORDER_NAMES } from '../atlas/names';
import { CROSS } from './icons';

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
 * The species picker: a header button that opens a search box over a tree of life (insects, then an order, then a
 * family), so finding one of nearly 2,000 species never means scrolling a menu. The hand-built species come first,
 * as "Featured"; every Atlas species is a search away. Analogy: a field guide's index and its table of contents
 * on one page.
 *
 * The Atlas's species list is only fetched when the picker first opens. A species the hand-built list also has (the
 * luna moth) opens its own richer layer: `featured` maps its scientific name to that key.
 */
export function mountSpeciesPicker(
  button: HTMLButtonElement,
  sheet: HTMLElement,
  featured: SpeciesEntry[],
  onPick: (key: string) => void,
): SpeciesPicker {
  const bySci = new Map(featured.filter((e) => e.sci).map((e) => [e.sci!, e.key] as const));
  const keyOf = (s: AtlasSpecies) => bySci.get(s.name) ?? atlasKey(s.name);
  let all: AtlasSpecies[] | null = null;
  let path: Path = {};
  let q = '';

  sheet.innerHTML = `<div class="sp-head"><input id="sp-q" type="search" role="combobox" aria-autocomplete="list" aria-controls="sp-list"
      aria-expanded="true" placeholder="Search insects" autocomplete="off" enterkeyhint="search" aria-label="Search insects">
    <button type="button" class="sp-x icon-btn" aria-label="Close">${CROSS}</button></div>
    <nav class="sp-crumbs" aria-label="Tree of life"></nav>
    <ul id="sp-list" role="listbox" aria-label="Species"></ul>`;
  const input = sheet.querySelector<HTMLInputElement>('#sp-q')!;
  const crumbs = sheet.querySelector<HTMLElement>('.sp-crumbs')!;
  const list = sheet.querySelector<HTMLUListElement>('#sp-list')!;

  const row = (s: AtlasSpecies) =>
    `<li role="option" aria-selected="false"><button type="button" class="sp-row" data-key="${esc(keyOf(s))}">${s.photo
      ? `<img src="${esc(s.photo)}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer">`
      : '<i class="sp-blank"></i>'}<span class="sp-name">${esc(nameOf(s))}${s.common ? `<i>${esc(s.name)}</i>` : ''}</span></button></li>`;
  const group = (label: string, sub: string, data: string) =>
    `<li role="option" aria-selected="false"><button type="button" class="sp-group" ${data}><span class="sp-name">${esc(label)}${sub ? `<i>${esc(sub)}</i>` : ''}</span><span class="sp-n"></span></button></li>`;
  const counted = (html: string, n: number) => html.replace('<span class="sp-n"></span>', `<span class="sp-n">${n.toLocaleString()}</span>`);
  const tally = (xs: AtlasSpecies[], k: 'order' | 'family') => {
    const m = new Map<string, number>();
    for (const s of xs) if (s[k]) m.set(s[k]!, (m.get(s[k]!) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };

  // Search: every word must start a word of the name, Latin name, family or order; best match first, then most seen.
  const search = (text: string) => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (s: AtlasSpecies) => `${s.common ?? ''} ${s.name} ${s.family ?? ''} ${s.order ?? ''} ${ORDER_NAMES[s.order ?? ''] ?? ''}`.toLowerCase();
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
  const featuredRows = () =>
    featured
      .map((e) => {
        const s = all?.find((x) => x.name === e.sci);
        return `<li role="option" aria-selected="false"><button type="button" class="sp-row sp-feat" data-key="${esc(e.key)}">${s?.photo
          ? `<img src="${esc(s.photo)}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer">`
          : '<i class="sp-blank"></i>'}<span class="sp-name">${esc(e.label)}${e.sci ? `<i>${esc(e.sci)}</i>` : ''}</span></button></li>`;
      })
      .join('');
  const render = () => {
    if (!all) {
      list.innerHTML = `<li class="sp-sec">Featured forecasts</li>${featuredRows()}<li class="sp-note">Loading the rest…</li>`;
      crumbs.innerHTML = '';
      return;
    }
    if (q.trim()) {
      const hits = search(q.trim());
      crumbs.innerHTML = `<span>${hits.length ? `${hits.length === 60 ? 'Top 60' : hits.length} matches` : 'No matches'}</span>`;
      list.innerHTML = hits.map(row).join('');
      return;
    }
    const steps = [`<button type="button" data-crumb="">All insects</button>`];
    if (path.order) steps.push(`<button type="button" data-crumb="order">${esc(ORDER_NAMES[path.order] ?? path.order)}</button>`);
    if (path.family) steps.push(`<span>${esc(path.family)}</span>`);
    crumbs.innerHTML = steps.join('<span aria-hidden="true"> › </span>');
    if (!path.order) {
      list.innerHTML =
        `<li class="sp-sec">Featured forecasts</li>${featuredRows()}${all.length ? '<li class="sp-sec">Browse</li>' : ''}` +
        tally(all, 'order').map(([o, n]) => counted(group(ORDER_NAMES[o] ?? o, o, `data-order="${esc(o)}"`), n)).join('');
    } else if (!path.family) {
      const inOrder = all.filter((s) => s.order === path.order);
      list.innerHTML = tally(inOrder, 'family').map(([f, n]) => counted(group(f, '', `data-family="${esc(f)}"`), n)).join('');
    } else {
      list.innerHTML = all.filter((s) => s.family === path.family).sort((a, b) => b.n - a.n).map(row).join('');
    }
  };

  const open = (on: boolean) => {
    sheet.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (!on) return;
    render();
    input.focus();
    if (!all)
      void loadIndex().then((s) => {
        all = s ?? [];
        render();
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
    if (b.dataset.key) {
      open(false);
      button.focus();
      onPick(b.dataset.key);
    } else if (b.dataset.order) (path = { order: b.dataset.order }), render(), list.scrollTo?.(0, 0);
    else if (b.dataset.family) (path = { ...path, family: b.dataset.family }), render(), list.scrollTo?.(0, 0);
    else if (b.dataset.crumb !== undefined) (path = b.dataset.crumb ? { order: path.order } : {}), render();
  });
  // Arrow keys walk the list from the search box; Escape closes.
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      open(false);
      button.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll<HTMLButtonElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(items.length - 1, i + 1)) : i <= 0 ? -1 : i - 1;
    e.preventDefault();
    (next < 0 ? input : items[next])?.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    list.querySelector<HTMLButtonElement>('.sp-row')?.click();
  });
  // A tap outside closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!sheet.hidden && !sheet.contains(e.target as Node) && !button.contains(e.target as Node)) open(false);
  });

  return {
    button,
    show(_key, label) {
      button.querySelector('.sp-face')!.textContent = label;
      button.setAttribute('aria-label', `Species: ${label}. Change species`);
    },
    set disabled(on: boolean) {
      button.disabled = on;
    },
  };
}
