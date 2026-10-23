import type { HatchLayer, ProbeCard } from '../core/layer';
import type { ProbeHit } from '../map/map';
import type { LayerRegistry } from '../core/registry';

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
 * Colour key. On narrow screens (under 1000px, where it sits over the map) it can fold to a one-line "Key" chip:
 * it starts open, folds itself after the first tap on the map or press of Play, and remembers that for next time.
 * Wide screens always show it; the folded class does nothing there.
 */
export function mountLegend(root: HTMLElement, registry: LayerRegistry): { autoFold(): void } {
  // Stored: '1' folded, 'open' opened by hand (never fold it for them again), nothing yet: open until the first tap.
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FOLD_KEY);
  } catch {
    /* storage blocked: start open */
  }
  let folded = stored === '1';
  let touched = stored === 'open'; // the reader opened or closed it themselves: stop folding it for them
  const narrow = window.matchMedia('(max-width: 999px)');
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
          const items = lg.items?.length
            ? `<ul class="lg-items">${lg.items
                .map((it) => `<li><i class="sw ${it.shape}" style="--c:${it.color}"></i>${esc(it.label)}</li>`)
                .join('')}</ul>`
            : '';
          const fold = i === 0 ? '<button type="button" id="key-fold" class="lg-fold" aria-expanded="true" aria-label="Hide the colour key">&times;</button>' : '';
          return `<div class="legend-card">${fold}<div class="lg-title">${esc(lg.title)}</div>${ramp}${items}
          ${lg.note ? `<div class="lg-note">${esc(lg.note)}</div>` : ''}</div>`;
        })
        .join('') +
      (layers.length ? `<button type="button" id="key-chip" class="lg-chip" aria-expanded="false" aria-label="Show the colour key">${swatches}<span>Key</span></button>` : '');
  };
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.lg-fold, .lg-chip');
    if (!btn) return;
    touched = true;
    setFolded(btn.classList.contains('lg-fold'), true);
  });
  registry.subscribe(render);
  render();
  root.classList.toggle('folded', folded);
  return {
    autoFold() {
      if (!narrow.matches) return; // wide screens always show the key; don't fold it behind their back for later
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
  root.innerHTML = (pinned ? '<button type="button" class="probe-close" aria-label="Close this card">&times;</button>' : '') +
    (hit?.label ? `<div class="probe-cell">Near ${esc(hit.label)}</div>` : '') +
    cards
    .map(
      (card) =>
        `<div class="probe-card"><div class="probe-title">${esc(card.title)}</div>${card.lines
          .map((x) => `<div>${esc(x)}</div>`)
          .join('')}${
          card.link
            ? `<a class="probe-link" href="${esc(card.link.href)}" target="_blank" rel="noopener noreferrer">${esc(card.link.label)}<span aria-hidden="true"> &#8599;</span><span class="sr"> (opens in a new tab)</span></a>`
            : ''
        }</div>`,
    )
    .join('');
  root.hidden = false;
}
