import type { LayerRegistry } from '../core/registry';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** "i" button + panel listing every active layer's caveats(). Honesty is one tap away. */
export function mountCaveatDrawer(btn: HTMLElement, drawer: HTMLElement, registry: LayerRegistry): void {
  const render = () => {
    const cards = registry.activeLayers().map((l) => l.caveats());
    drawer.innerHTML = `
      <div class="drawer-head"><h2>Caveats</h2>
        <button class="icon-btn" id="drawer-close" aria-label="Close caveats">&times;</button></div>
      ${
        cards.length
          ? cards
              .map(
                (c) => `<section class="cav ${c.severity}">
                  ${c.severity === 'synthetic' ? '<div class="badge">SYNTHETIC DATA</div>' : ''}
                  <h3>${esc(c.title)}</h3>
                  <ul>${c.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></section>`,
              )
              .join('')
          : '<p class="muted">No layers are active.</p>'
      }`;
    drawer.querySelector('#drawer-close')!.addEventListener('click', () => toggle(false));
  };

  const toggle = (open: boolean) => {
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
  };

  btn.addEventListener('click', () => toggle(!drawer.classList.contains('open')));
  window.addEventListener('keydown', (e) => e.key === 'Escape' && toggle(false));
  registry.subscribe(render);
  render();
  if (new URLSearchParams(location.search).has('caveats')) toggle(true);
}
