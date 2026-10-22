import type { Explainer } from '../core/layer';
import type { LayerRegistry } from '../core/registry';
import { explainerHtml, spotHtml } from './explainer';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface Drawer {
  (open: boolean): void;
  /** Point the explainer's spot card at a place (null = the layer's default) on day `t`. */
  setSpot(lngLat: [number, number] | null, t: number): void;
}

/**
 * "i" button + About panel. A layer with an explainer() gets the visual version (picture strip, a place's season,
 * how good the forecast is, fine print); one without gets its caveats() list. Honesty is one tap away.
 */
export function mountCaveatDrawer(btn: HTMLElement, drawer: HTMLElement, registry: LayerRegistry): Drawer {
  let spot: [number, number] | null = null;
  let spotT = 0;
  const lastSpot = new WeakMap<HTMLElement, string>();
  // Explainers built at the last render, so playback (which calls fillSpots every frame) doesn't rebuild them.
  let explainers = new Map<string, Explainer>();
  const fillSpots = () => {
    for (const [id, ex] of explainers) {
      const el = drawer.querySelector<HTMLElement>(`[data-spot="${CSS.escape(id)}"]`);
      if (!el) continue;
      const html = spotHtml(ex.spot(spot, spotT));
      if (html === lastSpot.get(el)) continue; // playback calls this every frame; skip unchanged days
      el.innerHTML = html;
      lastSpot.set(el, html);
    }
  };
  const render = () => {
    const layers = registry.activeLayers();
    const credits = layers.flatMap((l) => l.credits?.() ?? []);
    explainers = new Map();
    // A season change re-renders; keep folded sections the way the reader left them.
    const opened = new Set([...drawer.querySelectorAll<HTMLDetailsElement>('details[data-key]')].filter((d) => d.open).map((d) => d.dataset.key));
    drawer.innerHTML = `
      <div class="drawer-head"><h2>About this map</h2>
        <button class="icon-btn" id="drawer-close" aria-label="Close About this map">&times;</button></div>
      ${
        layers.length
          ? layers
              .map((l) => {
                const c = l.caveats();
                const ex = c.severity === 'synthetic' ? undefined : l.explainer?.();
                if (ex) {
                  explainers.set(l.id, ex);
                  return explainerHtml(l.id, ex, c);
                }
                return `<section class="cav ${c.severity}" data-why>
                  ${c.severity === 'synthetic' ? '<div class="badge">SYNTHETIC DATA</div>' : ''}
                  <h3>${esc(c.title)}</h3>
                  <ul>${c.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></section>`;
              })
              .join('')
          : '<p class="muted">No layers are active.</p>'
      }
      ${credits.length ? `<details class="cav credits" data-key="credits"><summary>Credits</summary><ul>${credits.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}`;
    drawer.querySelector('#drawer-close')!.addEventListener('click', () => toggle(false));
    drawer.querySelectorAll<HTMLDetailsElement>('details[data-key]').forEach((d) => (d.open = opened.has(d.dataset.key)));
    fillSpots();
  };

  const toggle = (open: boolean) => {
    const was = drawer.classList.contains('open');
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.inert = !open; // closed drawer: nothing inside is focusable
    if (open && !was) drawer.querySelector<HTMLElement>('#drawer-close')?.focus({ preventScroll: true });
    if (!open && was && drawer.contains(document.activeElement)) btn.focus({ preventScroll: true });
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
  };

  btn.addEventListener('click', () => toggle(!drawer.classList.contains('open')));
  // On a phone the drawer covers most of the screen, so a tap outside it closes it, like a native sheet. That tap
  // stops there (no card pinned underneath). Desktop keeps the side panel open while you scrub.
  const phone = window.matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 500px)');
  let swallow = false;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!phone.matches || !drawer.classList.contains('open') || drawer.contains(t) || btn.contains(t) || t.closest?.('#why')) return;
    toggle(false);
    swallow = true;
    setTimeout(() => (swallow = false), 600); // a tap that never becomes a click must not eat the next real one
    e.stopPropagation();
    e.preventDefault();
  }, true);
  // A tap also sends the mouse events a mouse would (the move shows the hex card as a hover), so swallow those too.
  for (const type of ['pointermove', 'pointerup', 'mousemove', 'mousedown', 'mouseup', 'click'] as const)
    document.addEventListener(type, (e) => {
      if (!swallow) return;
      e.stopPropagation();
      e.preventDefault();
      if (type === 'click') swallow = false;
    }, true);
  window.addEventListener('keydown', (e) => e.key === 'Escape' && toggle(false));
  registry.subscribe(render);
  render();
  drawer.inert = true;
  if (new URLSearchParams(location.search).has('caveats')) toggle(true);
  return Object.assign(toggle, {
    setSpot(lngLat: [number, number] | null, t: number) {
      spot = lngLat;
      spotT = t;
      fillSpots();
    },
  });
}
