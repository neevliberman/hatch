import type { HatchLayer, ProbeCard } from '../core/layer';
import type { ProbeHit } from '../map/map';
import type { LayerRegistry } from '../core/registry';
import { CROSS } from './icons';

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

/** Hover/tap probe card: each active layer's answer to "what's here?". A pinned card gets a close button. */
export function showProbe(root: HTMLElement, registry: LayerRegistry, hit: ProbeHit | null, t: number, pinned = false): void {
  const cards = hit
    ? registry
        .activeLayers()
        .filter((l: HatchLayer) => l.probe)
        .map((l) => l.probe!(hit.lngLat, t, hit.picked))
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
  const opened = same ? [...root.querySelectorAll('details')].map((d) => d.open) : [];
  const focusables = () => [...root.querySelectorAll<HTMLElement>('button, summary, a')];
  const focused = same && root.contains(document.activeElement) ? focusables().indexOf(document.activeElement as HTMLElement) : -1;
  let fold = 0;
  root.innerHTML = (pinned ? '<button type="button" class="probe-close" aria-label="Close this card">&times;</button>' : '') +
    (hit?.label ? `<div class="probe-cell">Near ${esc(hit.label)}</div>` : hit?.note ? `<div class="probe-cell">${esc(hit.note)}</div>` : '') +
    cards
    .map(
      (card) =>
        `<div class="probe-card"><div class="probe-title">${card.swatch ? `<i class="sw hex" aria-hidden="true" style="--c:${esc(card.swatch)}"></i>` : ''}${esc(card.title)}</div>${card.lines
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
          card.calendar
            ? `<a class="probe-link" href="${esc(card.calendar.href)}" download="${esc(card.calendar.filename)}">${esc(card.calendar.label)}<span class="sr"> (downloads a calendar file)</span></a>`
            : ''
        }</div>`,
    )
    .join('');
  root.hidden = false;
  if (focused >= 0) focusables()[focused]?.focus();
}
