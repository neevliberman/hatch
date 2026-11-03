import { OTHERS_FEW, OTHERS_MAX, type HatchLayer, type OthersList, type ProbeCard } from '../core/layer';
import type { ProbeHit } from '../map/map';
import type { LayerRegistry } from '../core/registry';
import { CROSS } from './icons';
import { seasonLine } from './sparkline';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Layer list. The label of a synthetic layer is shown prominently with a SYNTHETIC badge. */
export function mountLayerList(root: HTMLElement, registry: LayerRegistry): void {
  const render = () => {
    root.innerHTML = registry
      .all()
      .map((l) => {
        const synthetic = l.caveats().severity === 'synthetic';
        return `<label class="layer ${synthetic ? 'synthetic' : ''}">
          <input type="checkbox" data-id="${esc(l.id)}" ${registry.isActive(l.id) ? 'checked' : ''} />
          <span class="name">${esc(l.title)}</span>
          ${synthetic ? '<span class="badge">SYNTHETIC</span>' : ''}
        </label>`;
      })
      .join('');
  };
  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.id) registry.setActive(el.dataset.id, el.checked);
  });
  registry.subscribe(render);
  render();
  root.hidden = registry.all().length < 2; // one layer: a lone checkbox could only blank the map
}

const FOLD_KEY = 'hatch-legend-folded';

/**
 * Colour key. It can fold to a small "Key" chip, so the map gets its room: it starts open, folds itself after the
 * first tap on the map or press of Play, and remembers that for next time. The chip opens it again.
 */
export function mountLegend(root: HTMLElement, registry: LayerRegistry): { autoFold(): void } {
  // Stored: '1' folded, 'open' opened by hand (never fold it for them again), nothing yet: open until the first tap.
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FOLD_KEY);
  } catch {
    /* storage blocked: start open */
  }
  // A phone on its side has no height to spare: there the key starts as its chip unless the reader opened it.
  let folded = stored === '1' || (stored !== 'open' && matchMedia('(orientation: landscape) and (max-height: 500px)').matches);
  let touched = stored === 'open'; // the reader opened or closed it themselves: stop folding it for them
  const setFolded = (f: boolean, focus = false) => {
    folded = f;
    root.classList.toggle('folded', f);
    try {
      localStorage.setItem(FOLD_KEY, f ? '1' : touched ? 'open' : '0');
    } catch {
      /* not remembered, still works */
    }
    if (focus) root.querySelector<HTMLElement>(f ? '.lg-chip' : '.lg-fold')?.focus();
  };
  const render = () => {
    const layers = registry.activeLayers().map((l) => l.legend());
    const swatches = layers
      .flatMap((lg) => lg.items ?? [])
      .slice(0, 4)
      .map((it) => `<i class="sw ${it.shape}" style="--c:${it.color}"></i>`)
      .join('');
    root.innerHTML =
      layers
        .map((lg, i) => {
          const stops = lg.stops ?? [];
          const ramp = stops.length
            ? `<div class="lg-ramp" style="background:linear-gradient(90deg,${stops.map((s) => s.color).join(',')})"></div>
          <div class="lg-labels"><span>${esc(stops[0]!.label)}</span><span>${esc(stops[stops.length - 1]!.label)}</span></div>`
            : '';
          // The fold button floats at the right end of the first card's first row of swatches: inside the card, over
          // nothing, and the rows below run full width.
          const fold = i === 0 ? `<button type="button" id="key-fold" class="lg-fold" aria-expanded="true" aria-label="Hide the key">${CROSS}</button>` : '';
          const items = lg.items?.length
            ? `<ul class="lg-items">${fold && `<li class="lg-x">${fold}</li>`}${lg.items
                .map((it) => `<li><i class="sw ${it.shape}" style="--c:${it.color}"></i>${esc(it.label)}</li>`)
                .join('')}</ul>`
            : '';
          return `<div class="legend-card"><div class="lg-title">${esc(lg.title)}${items ? '' : fold}</div>${ramp}${items}
          ${lg.note ? `<div class="lg-note">${esc(lg.note)}</div>` : ''}</div>`;
        })
        .join('') +
      (layers.length ? `<button type="button" id="key-chip" class="lg-chip" aria-expanded="false" aria-label="Show the key">${swatches}<span>Key</span></button>` : '');
  };
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.lg-fold, .lg-chip');
    if (!btn) return;
    touched = true;
    // Hand focus to the other button only for a keyboard (a click from Enter or Space has no detail); a tap needs no ring.
    setFolded(btn.classList.contains('lg-fold'), (e as MouseEvent).detail === 0);
  });
  registry.subscribe(render);
  render();
  root.classList.toggle('folded', folded);
  return {
    autoFold() {
      if (!touched && !folded) setFolded(true);
      touched = true; // once per visit
    },
  };
}

/** The list's chip (null: all), kept from card to card; and whether the list is opened out, for this card only. */
let outGroup: string | null = null;
let outOpen = false;
/** The last list drawn, so a chip or the opener redraws it without asking the layer again. */
let outLast: OthersList | null = null;

/** "Out here now": a row of chips to narrow it, then the first few species (or up to OTHERS_MAX, opened out), each
 * a tap away from the map. While it is worked out, its room is kept. */
function othersHtml(o: OthersList): string {
  outLast = o;
  const groups = o.groups ?? [];
  const g = outGroup !== null && groups.includes(outGroup) ? outGroup : null;
  const all = g === null ? o.list : o.list.filter((x) => x.group === g);
  const shown = all.slice(0, outOpen ? OTHERS_MAX : OTHERS_FEW);
  const chip = (v: string | null, label: string) =>
    `<button type="button" class="po-chip" data-group="${esc(v ?? '')}" aria-pressed="${g === v}">${esc(label)}</button>`;
  const chips = groups.length > 1 ? `<div class="po-chips" role="group" aria-label="Show only">${chip(null, 'All')}${groups.map((x) => chip(x, x)).join('')}</div>` : '';
  // A phone shows two rows closed (style.css), a wider screen three: anything past two can be opened out.
  const more = all.length > 2 && !o.pending
    ? `<button type="button" class="po-more" aria-expanded="${outOpen}" aria-controls="po-list">${outOpen ? 'Less' : 'More'}<span aria-hidden="true"> ${outOpen ? '&#9652;' : '&#9662;'}</span></button>`
    : '';
  const rows = o.pending
    ? `<ul class="po-list po-wait" id="po-list" aria-busy="true">${'<li><i></i></li>'.repeat(OTHERS_FEW)}</ul>`
    : `<ul class="po-list${outOpen ? ' open' : ''}" id="po-list">${shown
        .map(
          (x) =>
            `<li data-group="${esc(x.group ?? '')}"><button type="button" data-species="${esc(x.key)}">${x.img ? `<img src="${esc(x.img)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer">` : '<i class="po-blank"></i>'}<span class="po-name">${esc(x.label)}</span><span class="po-note">${esc(x.note)}</span></button></li>`,
        )
        .join('')}</ul>`;
  return `<div class="probe-others${outOpen ? ' open' : ''}"><div class="po-head"><span class="po-title">${esc(o.title)}</span>${chips}${more}</div>${rows}</div>`;
}

/** A way back to the same control after the card is redrawn: by what it is (a species, a chip, the opener), not by
 * where it was, since the list's rows come and go. */
function keyOf(el: Element | null): string | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el.dataset.species) return `[data-species="${CSS.escape(el.dataset.species)}"]`;
  if (el.classList.contains('po-chip')) return `.po-chip[data-group="${CSS.escape(el.dataset.group ?? '')}"]`;
  for (const c of ['po-more', 'probe-close', 'probe-link']) if (el.classList.contains(c)) return `.${c}`;
  if (el.tagName === 'SUMMARY') return 'summary';
  return null;
}

/** A chip or the opener: redraw just the list, from the one last drawn. */
function onOthers(root: HTMLElement, e: Event): void {
  if (e.defaultPrevented) return; // a tap that opened the card under the finger (main.ts) is not a press on it
  const b = (e.target as HTMLElement).closest<HTMLElement>('.po-chip, .po-more');
  const box = b?.closest('.probe-others');
  if (!b || !box || !outLast) return;
  if (b.classList.contains('po-more')) outOpen = !outOpen;
  else outGroup = b.dataset.group || null;
  const sel = keyOf(b);
  const left = box.querySelector('.po-chips')?.scrollLeft ?? 0;
  box.outerHTML = othersHtml(outLast);
  const fresh = root.querySelector('.probe-others');
  const chips = fresh?.querySelector('.po-chips');
  if (chips) chips.scrollLeft = left;
  // Keep focus where it was (a keyboard user's chip or opener).
  if (sel && (root.contains(document.activeElement) || document.activeElement === document.body)) fresh?.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
}

/** Hover/tap probe card: each active layer's answer to "what's here?". A pinned card gets a close button. */
export function showProbe(root: HTMLElement, registry: LayerRegistry, hit: ProbeHit | null, t: number, pinned = false): void {
  const cards = hit
    ? registry
        .activeLayers()
        .filter((l: HatchLayer) => l.probe)
        .map((l) => l.probe!(hit.lngLat, t, hit.picked, pinned))
        .filter((c): c is ProbeCard => c !== null)
    : [];
  if (!cards.length) {
    root.hidden = true;
    return;
  }
  // While the days play the card is rebuilt each tick: keep each "More" open, and keyboard focus, for the same hexagon.
  const key = `${hit!.cell}|${pinned}`;
  const same = root.dataset.key === key;
  root.dataset.key = key;
  if (!same) outOpen = false; // a new place opens with its list short
  if (!root.dataset.others) {
    root.dataset.others = '1';
    root.addEventListener('click', (e) => onOthers(root, e));
  }
  const chipsLeft = same ? (root.querySelector('.po-chips')?.scrollLeft ?? 0) : 0;
  const listTop = same ? (root.querySelector('.po-list')?.scrollTop ?? 0) : 0;
  const opened = same ? [...root.querySelectorAll('details')].map((d) => d.open) : [];
  // Keyboard focus comes back to the same control: found by what it is, else (a control with no key) by its place.
  const focusables = () => [...root.querySelectorAll<HTMLElement>('button, summary, a')];
  const had = same && root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  const focused = had ? (keyOf(had) ?? focusables().indexOf(had)) : null;
  let fold = 0;
  // The × stays the same element across rebuilds: one landing between a press and its release (a playback tick, a late
  // file) would otherwise leave the click on a button no longer in the card, and it would do nothing.
  const oldClose = pinned ? root.querySelector('.probe-close') : null;
  root.innerHTML = (pinned ? '<button type="button" class="probe-close" aria-label="Close this card">&times;</button>' : '') +
    (hit?.label ? `<div class="probe-cell">Near ${esc(hit.label)}</div>` : hit?.note ? `<div class="probe-cell">${esc(hit.note)}</div>` : '') +
    cards
    .map(
      (card) =>
        `<div class="probe-card"><div class="probe-title">${card.swatch ? `<i class="sw hex" aria-hidden="true" style="--c:${esc(card.swatch)}"></i>` : ''}${esc(card.title)}</div>${card.season ? seasonLine(card.season) : ''}${card.lines
          .map((x) => `<div>${esc(x)}</div>`)
          .join('')}${
          card.more?.length
            ? `<details class="probe-more"${opened[fold++] ? ' open' : ''}><summary>More<span class="sr"> about ${esc(card.title)}</span></summary>${card.more.map((x) => `<p>${esc(x)}</p>`).join('')}</details>`
            : ''
        }${
          card.link
            ? `<a class="probe-link" href="${esc(card.link.href)}" target="_blank" rel="noopener noreferrer">${esc(card.link.label)}<span aria-hidden="true"> &#8599;</span><span class="sr"> (opens in a new tab)</span></a>`
            : ''
        }${
          card.others && (card.others.list.length || card.others.pending) ? othersHtml(card.others) : ''
        }${
          card.calendar
            ? `<a class="probe-link" href="${esc(card.calendar.href)}" download="${esc(card.calendar.filename)}">${esc(card.calendar.label)}<span class="sr"> (downloads a calendar file)</span></a>`
            : ''
        }</div>`,
    )
    .join('');
  if (oldClose) root.querySelector('.probe-close')?.replaceWith(oldClose);
  root.hidden = false;
  const chips = root.querySelector('.po-chips');
  if (chips) chips.scrollLeft = chipsLeft;
  const list = root.querySelector('.po-list');
  if (list) list.scrollTop = listTop;
  if (typeof focused === 'string') root.querySelector<HTMLElement>(focused)?.focus();
  else if (focused !== null && focused >= 0) focusables()[focused]?.focus();
}
