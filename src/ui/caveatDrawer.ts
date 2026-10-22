import type { LayerRegistry } from '../core/registry';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** "i" button + panel listing every active layer's caveats(). Honesty is one tap away. Returns a toggle. */
export function mountCaveatDrawer(btn: HTMLElement, drawer: HTMLElement, registry: LayerRegistry): (open: boolean) => void {
  const render = () => {
    const cards = registry.activeLayers().map((l) => l.caveats());
    const credits = registry.activeLayers().flatMap((l) => l.credits?.() ?? []);
    drawer.innerHTML = `
      <div class="drawer-head"><h2>About this map</h2>
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
      }
      ${credits.length ? `<section class="cav credits"><h3>Credits</h3><ul>${credits.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>` : ''}`;
    drawer.querySelector('#drawer-close')!.addEventListener('click', () => toggle(false));
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
  window.addEventListener('keydown', (e) => e.key === 'Escape' && toggle(false));
  registry.subscribe(render);
  render();
  drawer.inert = true;
  if (new URLSearchParams(location.search).has('caveats')) toggle(true);
  return toggle;
}
