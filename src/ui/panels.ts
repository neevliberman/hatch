import type { HatchLayer } from '../core/layer';
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
}

export function mountLegend(root: HTMLElement, registry: LayerRegistry): void {
  const render = () => {
    root.innerHTML = registry
      .activeLayers()
      .map((l) => {
        const lg = l.legend();
        const grad = lg.stops.map((s) => s.color).join(',');
        const first = lg.stops[0]?.label ?? '';
        const last = lg.stops[lg.stops.length - 1]?.label ?? '';
        return `<div class="legend-card"><div class="lg-title">${esc(lg.title)}</div>
          <div class="lg-ramp" style="background:linear-gradient(90deg,${grad})"></div>
          <div class="lg-labels"><span>${esc(first)}</span><span>${esc(last)}</span></div>
          ${lg.note ? `<div class="lg-note">${esc(lg.note)}</div>` : ''}</div>`;
      })
      .join('');
  };
  registry.subscribe(render);
  render();
}

/** Hover/tap probe card: the cell id plus each active layer's probe text. */
export function showProbe(
  root: HTMLElement,
  registry: LayerRegistry,
  hit: { cell: string; lngLat: [number, number] } | null,
  t: number,
): void {
  if (!hit) {
    root.hidden = true;
    return;
  }
  const cards = registry
    .activeLayers()
    .filter((l: HatchLayer) => l.probe)
    .map((l) => ({ layer: l, card: l.probe!(hit.lngLat, t) }));
  root.innerHTML = `<div class="probe-cell">cell <code>${esc(hit.cell)}</code></div>${cards
    .map(
      ({ card }) =>
        `<div class="probe-card"><div class="probe-title">${esc(card.title)}</div>${card.lines
          .map((x) => `<div>${esc(x)}</div>`)
          .join('')}</div>`,
    )
    .join('')}`;
  root.hidden = false;
}
