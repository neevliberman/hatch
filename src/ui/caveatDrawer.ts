import type { Explainer } from '../core/layer';
import type { LayerRegistry } from '../core/registry';
import { explainerHtml, spotHtml } from './explainer';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface Drawer {
  (open: boolean): void;
  /** Point the explainer's spot card at a place (null = the layer's default) on day `t`. */
  setSpot(lngLat: [number, number] | null, t: number, name?: string): void;
}

/**
 * "i" button + About panel. A layer with an explainer() gets the visual version (picture strip, a place's season,
 * how good the forecast is, fine print); one without gets its caveats() list. Honesty is one tap away.
 */
export function mountCaveatDrawer(btn: HTMLElement, drawer: HTMLElement, registry: LayerRegistry): Drawer {
  let spot: [number, number] | null = null;
  let spotT = 0;
  let spotName: string | undefined;
  const lastSpot = new WeakMap<HTMLElement, string>();
  // Explainers built at the last render, so playback (which calls fillSpots every frame) doesn't rebuild them.
  let explainers = new Map<string, Explainer>();
  const fillSpots = () => {
    for (const [id, ex] of explainers) {
      const el = drawer.querySelector<HTMLElement>(`[data-spot="${CSS.escape(id)}"]`);
      if (!el) continue;
      const html = spotHtml(ex.spot(spot, spotT, spotName));
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
      <div class="drawer-head"><span class="drawer-grip" aria-hidden="true"></span><h2>About this map</h2>
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

  // On a phone in portrait the drawer is a bottom sheet: drag it down to close, like a native sheet. The title bar
  // always drags; the text drags only once it is scrolled to the top (before that, a downward swipe scrolls it back up).
  const narrow = window.matchMedia('(max-width: 700px)');
  const sideways = window.matchMedia('(orientation: landscape) and (max-height: 500px)'); // there it is a side panel
  let drag: { y0: number; t: number; dy: number; v: number; head: boolean; on: boolean } | null = null;
  drawer.addEventListener('touchstart', (e) => {
    if (drag?.on) return; // a second finger mid-drag: keep following the first
    drag = null;
    if (!narrow.matches || sideways.matches || e.touches.length !== 1) return;
    const head = !!(e.target as Element).closest('.drawer-head');
    if (head || drawer.scrollTop <= 0) drag = { y0: e.touches[0]!.clientY, t: e.timeStamp, dy: 0, v: 0, head, on: false };
  }, { passive: true });
  drawer.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const dy = e.touches[0]!.clientY - drag.y0;
    if (!drag.on) {
      if (!drag.head && (dy < 0 || drawer.scrollTop > 0)) return void (drag = null); // reading on: let the text scroll
      // At the top a pull down has nothing to scroll, so claim it now: once the browser starts a pan it stops letting us cancel moves.
      if (!drag.head && e.cancelable) e.preventDefault();
      if (dy < 8) return; // a tap with a wobble (say on the close button) stays a tap
      drag.on = true;
      drawer.classList.add('dragging');
    }
    e.preventDefault(); // the sheet moves, not the page or the text
    const next = Math.max(0, dy);
    drag.v = (next - drag.dy) / Math.max(1, e.timeStamp - drag.t); // px per ms over the last move, so a late flick counts
    drag.t = e.timeStamp;
    drag.dy = next;
    drawer.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: false });
  const endDrag = (e: TouchEvent) => {
    if (!drag?.on) return void (drag = null);
    const { dy, v } = drag;
    drag = null;
    // Dropping the inline transform lets the transition carry the sheet from where the finger left it: shut, or back up.
    drawer.classList.remove('dragging');
    drawer.style.transform = '';
    const flick = v > 0.6;
    if (e.type === 'touchend' && (dy > drawer.offsetHeight * 0.25 || (flick && dy > 40))) toggle(false);
  };
  drawer.addEventListener('touchend', endDrag);
  drawer.addEventListener('touchcancel', endDrag);
  // A hairline under the sticky title bar once text scrolls beneath it.
  drawer.addEventListener('scroll', () => drawer.classList.toggle('scrolled', drawer.scrollTop > 0), { passive: true });
  registry.subscribe(render);
  render();
  drawer.inert = true;
  if (new URLSearchParams(location.search).has('caveats')) toggle(true);
  return Object.assign(toggle, {
    setSpot(lngLat: [number, number] | null, t: number, name?: string) {
      spot = lngLat;
      spotT = t;
      spotName = name;
      fillSpots();
    },
  });
}
