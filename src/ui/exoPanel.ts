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

/** The nearest town or city label on the basemap within ~40 km, for the caption ("Near Peoria"). */
let towns: Promise<[string, number, number][]> | null = null;
async function nearTown(lng: number, lat: number): Promise<string | undefined> {
  towns ??= fetch(new URL('basemap/detail.json', document.baseURI).href)
    .then((r) => (r.ok ? r.json() : { labels: [] }))
    .then((j) => ((j.labels ?? []) as [string, number, number, number, string][]).filter((l) => l[4] === 'city' || l[4] === 'town').map((l) => [l[0], l[1], l[2]] as [string, number, number]))
    .catch(() => []);
  const k = Math.cos((lat * Math.PI) / 180);
  let best: string | undefined;
  let bd = (40 / 111) ** 2;
  for (const [n, x, y] of await towns) {
    const d = ((x - lng) * k) ** 2 + (y - lat) ** 2;
    if (d < bd) [bd, best] = [d, n];
  }
  return best;
}

/** Monarchs people photographed within 50 km, three days either side (iNaturalist, research grade or awaiting ID). */
const seenCache = new Map<string, Promise<number | null>>();
function seenNear(lat: number, lng: number, dayMs: number): { n: Promise<number | null>; href: string } {
  const d = (k: number) => new Date(dayMs + k * 864e5).toISOString().slice(0, 10);
  const q = `taxon_id=48662&lat=${lat.toFixed(2)}&lng=${lng.toFixed(2)}&radius=50&d1=${d(-3)}&d2=${d(3)}&quality_grade=research,needs_id`;
  let n = seenCache.get(q);
  if (!n) {
    n = fetch(`https://api.inaturalist.org/v1/observations?${q}&per_page=0`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (typeof j?.total_results === 'number' ? j.total_results : null))
      .catch(() => null);
    seenCache.set(q, n);
  }
  return { n, href: `https://www.inaturalist.org/observations?${q}` };
}

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
  let place: string | undefined;
  let seen: { n: number | null; href: string } | null = null;
  let opener: HTMLElement | null = null;

  /** Hand Exo the day: where, when, and the hourly air, cloud and wind. */
  const push = () => {
    if (!ready || !day || !spot) return;
    const [lon, lat] = spot.lngLat;
    const utc0 = day.dayMs - day.utcOffset * 1000;
    // Today: open on the hour it is there now. Any other day: mid-morning, so the warm-up is still ahead.
    const nowH = (Date.now() - utc0) / 36e5;
    const hour = nowH >= 0 && nowH < 24 ? nowH : 10;
    const where = `${place ? `Near ${place}` : 'Here'} · ${fmtDate(at)}${day.note === 'Recorded' ? '' : ` · ${day.note.toLowerCase()}`}`;
    frame.contentWindow?.postMessage(
      { type: 'exo-day', place: where, lat, lon, utc0, hour, temps: day.temps, cloud: day.cloud, ws: day.wind, wd: day.windFrom, seen: seen?.n ?? null, seenHref: seen?.href },
      location.origin,
    );
  };

  addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
    if (e.data?.type === 'exo-ready') {
      ready = true;
      push();
    } else if (e.data?.type === 'exo-close') close(); // Escape pressed inside Exo
    else if (e.data?.type === 'exo-live') {
      root.classList.add('live'); // Exo shows this place's day: fade it in
      noteEl.textContent = '';
    }
  });

  const load = async () => {
    if (!spot) return;
    const [lng, lat] = spot.lngLat;
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${fmtDate(at)}`;
    if (key === lastKey) return;
    lastKey = key;
    if (!root.classList.contains('live')) noteEl.textContent = `Reading ${fmtDate(at)}'s weather…`;
    const live = root.classList.contains('live');
    const [got, town] = await Promise.all([weather(lat, lng, at), spot.label ? Promise.resolve(spot.label) : nearTown(lng, lat)]);
    if (key !== lastKey) return; // the pin or the date moved on
    if (!got) {
      // keep showing the day already open; say so only if there is nothing on screen
      noteEl.textContent = live ? '' : 'No weather came back for this place and day.';
      if (live) lastKey = '';
      return;
    }
    day = got;
    place = town;
    const s = seenNear(lat, lng, got.dayMs);
    seen = { n: await s.n, href: s.href };
    if (key !== lastKey) return;
    if (live) noteEl.textContent = '';
    push();
  };

  /** The dive: a paper blot grows from (x, y) to cover the map; closing shrinks it back. */
  const blot = (x: number, y: number) => {
    root.style.setProperty('--ox', `${x}px`);
    root.style.setProperty('--oy', `${y}px`);
  };

  let shutTimer = 0;
  /** Everything else on the page is inert while Exo is open (a real modal: Tab cannot reach the map underneath). */
  const inert = (on: boolean) => {
    for (const el of document.body.children) if (el !== root && el instanceof HTMLElement) el.inert = on;
  };
  const close = () => {
    if (root.hidden || root.classList.contains('shut')) return;
    const done = () => {
      shutTimer = 0;
      inert(false);
      root.hidden = true;
      root.classList.remove('shut', 'live');
      frame.src = 'about:blank'; // unloads Exo, which stops its WebGL loop
      ready = false;
      lastKey = '';
      if (opener?.isConnected) opener.focus();
    };
    if (reduce.matches) return done();
    root.classList.remove('open', 'live');
    root.classList.add('shut');
    shutTimer = window.setTimeout(done, 420);
  };
  closeBtn.addEventListener('click', close);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  const open = (x: number, y: number) => {
    if (shutTimer) {
      // reopened while it was shrinking away: grow it back, keep the loaded Exo
      clearTimeout(shutTimer);
      shutTimer = 0;
      root.classList.remove('shut');
      root.classList.add('open', 'live');
      inert(true);
    }
    if (root.hidden) {
      inert(true);
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
