/**
 * Exo in the map (flag: ?exo). Pin a place, press "Meet a monarch here", and the page dives in: a paper blot spreads
 * from the button over the map, and Exo (public/exo, the sketched monarch, in an iframe) opens on that place's real day.
 * The sun stands where it really stood there that day; dragging it walks through the hours, and the air, cloud and
 * wind follow the hourly record (Open-Meteo, fetched only when Exo opens).
 *
 * Analogy: the map is the atlas, Exo is the magnifying glass. The atlas says where and when; the glass shows what that
 * day was like for one monarch on one milkweed.
 */
import { weather, type Day } from './weather';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const exoEnabled = () => new URLSearchParams(location.search).has('exo');

export interface ExoPanel {
  /** Called each time the probe card is redrawn: adds the button to a pinned card, and follows the date when open. */
  sync(hit: { lngLat: [number, number]; label?: string } | null, ms: number, card: HTMLElement): void;
}

export function mountExo(probeEl: HTMLElement): ExoPanel {
  const root = document.createElement('div');
  root.id = 'exo';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'A monarch at this place');
  root.innerHTML = `<iframe id="exo-frame" title="A sketched monarch living this place's real day"></iframe>
    <button type="button" class="exo-x" aria-label="Back to the map">&times;</button>
    <p class="exo-note" id="exo-note" role="status"></p>`;
  document.body.append(root);
  const frame = root.querySelector<HTMLIFrameElement>('#exo-frame')!;
  const noteEl = root.querySelector<HTMLElement>('#exo-note')!;
  const closeBtn = root.querySelector<HTMLButtonElement>('.exo-x')!;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  let ready = false;
  let day: Day | null = null;
  let spot: { lngLat: [number, number]; label?: string } | null = null;
  let at = 0;
  let lastKey = '';
  let opener: HTMLElement | null = null;

  /** Hand Exo the day: where, when, and the hourly air, cloud and wind. */
  const push = () => {
    if (!ready || !day || !spot) return;
    const [lon, lat] = spot.lngLat;
    const utc0 = day.dayMs - day.utcOffset * 1000;
    // Today: open on the hour it is there now. Any other day: mid-morning, so the warm-up is still ahead.
    const nowH = (Date.now() - utc0) / 36e5;
    const hour = nowH >= 0 && nowH < 24 ? nowH : 10;
    const place = `${spot.label ? `Near ${spot.label}` : 'Here'} · ${fmtDate(at)} · ${day.note.toLowerCase()}`;
    frame.contentWindow?.postMessage(
      { type: 'exo-day', place, lat, lon, utc0, hour, temps: day.temps, cloud: day.cloud, ws: day.wind, wd: day.windFrom },
      location.origin,
    );
  };

  addEventListener('message', (e) => {
    if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.type === 'exo-ready') {
      ready = true;
      push();
    }
  });

  const load = async () => {
    if (!spot) return;
    const [lng, lat] = spot.lngLat;
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${fmtDate(at)}`;
    if (key === lastKey) return;
    lastKey = key;
    noteEl.textContent = 'Reading the weather…';
    const got = await weather(lat, lng, at);
    if (key !== lastKey) return; // the pin or the date moved on
    day = got;
    noteEl.textContent = got ? '' : 'No weather came back for this place and day.';
    push();
  };

  /** The dive: a paper blot grows from (x, y) to cover the map; closing shrinks it back. */
  const blot = (x: number, y: number) => {
    root.style.setProperty('--ox', `${x}px`);
    root.style.setProperty('--oy', `${y}px`);
  };

  const close = () => {
    const done = () => {
      root.hidden = true;
      root.classList.remove('shut');
      frame.src = 'about:blank'; // unloads Exo, which stops its WebGL loop
      ready = false;
      lastKey = '';
      if (opener?.isConnected) opener.focus();
    };
    if (reduce.matches) return done();
    root.classList.remove('open');
    root.classList.add('shut');
    setTimeout(done, 420);
  };
  closeBtn.addEventListener('click', close);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  const open = (x: number, y: number) => {
    if (root.hidden) {
      blot(x, y);
      root.hidden = false;
      frame.src = `${import.meta.env.BASE_URL}exo/index.html?embed=1`;
      requestAnimationFrame(() => root.classList.add('open'));
      closeBtn.focus();
    }
    void load();
  };

  probeEl.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('.exo-open');
    if (!b) return;
    opener = b;
    const r = b.getBoundingClientRect();
    open(r.left + r.width / 2, r.top + r.height / 2);
  });

  return {
    sync(hit, ms, card) {
      if (hit && !card.hidden && !card.querySelector('.exo-open')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'exo-open';
        b.textContent = 'Meet a monarch here';
        card.append(b);
      }
      if (hit) {
        spot = hit;
        at = ms;
        if (!root.hidden) void load();
      } else if (!root.hidden) {
        at = ms; // unpinned: stay at the last place, but follow the date
        void load();
      }
    },
  };
}
