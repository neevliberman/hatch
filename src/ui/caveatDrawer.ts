import type { Explainer } from '../core/layer';
import type { LayerRegistry } from '../core/registry';
import { CITIES, explainerHtml, spotHtml } from './explainer';
import { CROSS } from './icons';
import { warmthHtml } from './warmth';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface Drawer {
  /** Open or close. On a phone held upright it opens as a sheet at its middle stop, or at the tall one with `full`. */
  (open: boolean, full?: boolean): void;
  /** Point the explainer's spot card at a place on day `t`. With none, its example follows `near` (the view's centre),
   * or the layer's default. */
  setSpot(lngLat: [number, number] | null, t: number, name?: string, near?: [number, number]): void;
  /** Called before the panel closes or redraws its contents: anything borrowed into it (the town box) goes home. */
  onLeave(fn: () => void): void;
}

/**
 * "i" button + About panel. A layer with an explainer() gets the visual version (picture strip, a place's season,
 * how good the forecast is, fine print); one without gets its caveats() list. Honesty is one tap away.
 */
export function mountCaveatDrawer(btn: HTMLElement, drawer: HTMLElement, registry: LayerRegistry): Drawer {
  let spot: [number, number] | null = null;
  let spotT = 0;
  let spotName: string | undefined;
  let near: [number, number] | undefined;
  // Nothing picked but the map has moved: the example is the big city nearest the view (within about 200 km) that
  // has a forecast, tried a little inland too, as a lakeshore city's own hexagon can be in the lake.
  const story = (ex: Explainer) => {
    if (spot || !near) return ex.spot(spot, spotT, spotName);
    const [x, y] = near;
    const d = (c: (typeof CITIES)[number]) => ((c.lng - x) * 0.75) ** 2 + (c.lat - y) ** 2;
    for (const c of CITIES.filter((c) => d(c) < 3.5).sort((a, b) => d(a) - d(b)))
      for (const [dx, dy] of [[0, 0], [-0.3, 0], [0.3, 0], [0, -0.3]]) {
        const s = ex.spot([c.lng + dx!, c.lat + dy!], spotT, c.name.replace(/, [A-Z]{2}$/, ''), true);
        if (s) return s;
      }
    return ex.spot(null, spotT);
  };
  const lastSpot = new WeakMap<HTMLElement, string>();
  // Explainers built at the last render, so playback (which calls fillSpots every frame) doesn't rebuild them.
  let explainers = new Map<string, Explainer>();
  const fillSpots = () => {
    for (const [id, ex] of explainers) {
      const el = drawer.querySelector<HTMLElement>(`[data-spot="${CSS.escape(id)}"]`);
      if (!el) continue;
      const html = spotHtml(story(ex));
      if (html === lastSpot.get(el)) continue; // playback calls this every frame; skip unchanged days
      el.innerHTML = html;
      lastSpot.set(el, html);
    }
  };
  let leave = () => {};
  const render = () => {
    leave();
    const layers = registry.activeLayers();
    const credits = layers.flatMap((l) => l.credits?.() ?? []);
    // Where the code lives and where to report a problem: the same for every layer, so it closes the list.
    if (credits.length)
      credits.push(
        { text: 'Code, data and method notes on GitHub', href: 'https://github.com/neevliberman/hatch' },
        { text: 'Report a problem', href: 'https://github.com/neevliberman/hatch/issues' },
      );
    const credit = (c: { text: string; href?: string }) =>
      c.href ? `<a href="${esc(c.href)}" target="_blank" rel="noopener noreferrer">${esc(c.text)}<span class="sr"> (opens in a new tab)</span></a>` : esc(c.text);
    explainers = new Map();
    // A season change re-renders; keep folded sections the way the reader left them.
    const opened = new Set([...drawer.querySelectorAll<HTMLDetailsElement>('details[data-key]')].filter((d) => d.open).map((d) => d.dataset.key));
    // One .sheet holds everything, title bar included, so its ruled paper scrolls with the text (see style.css).
    drawer.innerHTML = `<div class="sheet">
      <div class="drawer-head"><button type="button" class="drawer-grip" aria-label="Show more of this panel"></button><h2>About this map</h2>
        <button class="icon-btn" id="drawer-close" aria-label="Close About this map">${CROSS}</button></div>
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
      ${layers.length ? warmthHtml() : ''}
      ${credits.length ? `<details class="cav credits" data-key="credits"><summary>Credits</summary><ul>${credits.map((c) => `<li>${credit(c)}</li>`).join('')}</ul></details>` : ''}</div>`;
    drawer.querySelector('#drawer-close')!.addEventListener('click', () => toggle(false));
    // The grip is also a button, for a mouse or a keyboard on a narrow window: it swaps the two stops.
    drawer.querySelector('.drawer-grip')!.addEventListener('click', () => toggle(true, !full()));
    drawer.querySelectorAll<HTMLDetailsElement>('details[data-key]').forEach((d) => (d.open = opened.has(d.dataset.key)));
    fillSpots();
    // This season's live scorecard, in its own lazy chunk. Not in the one-file build: no files beside it to fetch.
    if (__BASEMAP__ && drawer.querySelector('[data-score]')) void import('./scorecard').then((m) => m.fillScores(drawer));
  };

  const toggle = (open: boolean, full = false) => {
    const was = drawer.classList.contains('open');
    if (!open) leave();
    if (open) drawer.classList.toggle('full', full);
    drawer.querySelector('.drawer-grip')?.setAttribute('aria-label', full ? 'Show less of this panel' : 'Show more of this panel');
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.inert = !open; // closed drawer: nothing inside is focusable
    if (open && !was) drawer.querySelector<HTMLElement>('#drawer-close')?.focus({ preventScroll: true });
    if (!open && was && drawer.contains(document.activeElement)) btn.focus({ preventScroll: true });
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
  };

  btn.addEventListener('click', () => toggle(!drawer.classList.contains('open')));
  // On a phone held upright the drawer is a bottom sheet with two stops. At the middle one (44%) the map above stays
  // in use: a tapped hexagon fills the spot card. At the tall one (92%) it is for reading, and a tap outside closes
  // it, like a native sheet; that tap stops there (no card pinned underneath). Side panels (desktop, a phone on its
  // side) stay open while you scrub and tap.
  const narrow = window.matchMedia('(max-width: 700px)');
  const sideways = window.matchMedia('(orientation: landscape) and (max-height: 500px)');
  const sheet = () => narrow.matches && !sideways.matches;
  const full = () => drawer.classList.contains('full');
  let swallow = false;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!sheet() || !full() || !drawer.classList.contains('open') || drawer.contains(t) || btn.contains(t) || t.closest?.('#why')) return;
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

  // Drag the sheet between its stops. The title bar always drags: up for the tall stop, down for the middle stop or to
  // close. The text scrolls at both stops, and drags the sheet down only when it is already scrolled to the top (before
  // that, a downward swipe scrolls it back up). It used to drag at the middle stop too, so the same swipe on the text
  // scrolled it at one stop and moved the sheet at the other. A quick flick counts even when it moved only a little.
  let drag: { x0: number; y0: number; t: number; dy: number; v: number; head: boolean; on: boolean } | null = null;
  drawer.addEventListener('touchstart', (e) => {
    if (drag?.on) return; // a second finger mid-drag: keep following the first
    drag = null;
    if (!sheet() || e.touches.length !== 1) return;
    const head = !!(e.target as Element).closest('.drawer-head');
    if (head || drawer.scrollTop <= 0) drag = { x0: e.touches[0]!.clientX, y0: e.touches[0]!.clientY, t: e.timeStamp, dy: 0, v: 0, head, on: false };
  }, { passive: true });
  drawer.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const dy = e.touches[0]!.clientY - drag.y0;
    const dx = e.touches[0]!.clientX - drag.x0;
    if (!drag.on) {
      if (!drag.head && (dy < 0 || drawer.scrollTop > 0)) return void (drag = null); // reading on: let the text scroll
      if (Math.hypot(dx, dy) < 8) return; // a tap with a wobble (say on the close button) stays a tap, and a fingertip's first twitch decides nothing
      // Claim the gesture only now that it is clearly a pull down: cancelling any earlier move (even a 1px jitter at
      // the top of the text) makes Safari drop the whole gesture, so the text would never scroll.
      if (!drag.head && e.cancelable) e.preventDefault();
      drag.on = true;
      drawer.classList.add('dragging');
    }
    e.preventDefault(); // the sheet moves, not the page or the text
    const next = full() ? Math.max(0, dy) : Math.max(dy, -window.innerHeight * 0.48);
    drag.v = (next - drag.dy) / Math.max(1, e.timeStamp - drag.t); // px per ms over the last move, so a late flick counts
    drag.t = e.timeStamp;
    drag.dy = next;
    // Down slides the sheet away; up (from the middle stop) makes it taller.
    drawer.style.transform = next > 0 ? `translateY(${next}px)` : '';
    drawer.style.height = next < 0 ? `${window.innerHeight * 0.44 - next}px` : '';
  }, { passive: false });
  const endDrag = (e: TouchEvent) => {
    if (!drag?.on) return void (drag = null);
    const { dy, v } = drag;
    drag = null;
    // Dropping the inline styles lets the transition carry the sheet from where the finger left it to its stop.
    drawer.classList.remove('dragging');
    drawer.style.transform = drawer.style.height = '';
    if (e.type !== 'touchend') return;
    const h = drawer.offsetHeight;
    if (full()) {
      if (dy > h * 0.6) toggle(false);
      else if (dy > 60 || (v > 0.6 && dy > 20)) toggle(true);
    } else if (dy < -60 || (v < -0.4 && dy < -20)) toggle(true, true);
    else if (dy > h * 0.25 || (v > 0.6 && dy > 30)) toggle(false);
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
    onLeave: (fn: () => void) => void (leave = fn),
    setSpot(lngLat: [number, number] | null, t: number, name?: string, view?: [number, number]) {
      const moved = String(lngLat) !== String(spot);
      spot = lngLat;
      spotT = t;
      spotName = name;
      near = view;
      fillSpots();
      // A hexagon tapped above the middle-stop sheet: bring its spot card up into the part of the sheet showing.
      const card = drawer.querySelector<HTMLElement>('.ex-spot');
      if (moved && lngLat && card && sheet() && !full() && drawer.classList.contains('open')) {
        const head = drawer.querySelector<HTMLElement>('.drawer-head')?.offsetHeight ?? 0;
        const top = card.getBoundingClientRect().top - drawer.getBoundingClientRect().top + drawer.scrollTop - head - 8;
        drawer.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    },
  });
}
