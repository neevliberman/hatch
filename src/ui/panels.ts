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

export function mountLegend(root: HTMLElement, registry: LayerRegistry): void {
  const render = () => {
    root.innerHTML = registry
      .activeLayers()
      .map((l) => {
        const lg = l.legend();
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
        return `<div class="legend-card"><div class="lg-title">${esc(lg.title)}</div>${ramp}${items}
          ${lg.note ? `<div class="lg-note">${esc(lg.note)}</div>` : ''}</div>`;
      })
      .join('');
  };
  registry.subscribe(render);
  render();
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
