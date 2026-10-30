/**
 * Exo in the map (flag: ?exo). Pin a place, press "Meet a monarch here", and a sketched monarch (public/exo, its own
 * page in an iframe) lives that place's real air temperature on the map's date. The hour slider walks one day;
 * Exo's own temperature slider is hidden and this panel drives it.
 *
 * Analogy: the map is a weather station and Exo is the thermometer's pet. The map says where and when; Exo shows
 * what that day feels like to a monarch. Weather comes from Open-Meteo, fetched only when the panel opens.
 */
const DAY = 864e5;
const HOURS = [5, 21] as const;

interface Day {
  temps: (number | null)[];
  cloud: (number | null)[];
  note: string;
}

/** Which weather source answers for a map date: past days from the archive, near days from the forecast, and a far
 * future date borrows the same calendar day of a past year (the map's "typical year"). */
function resolve(ms: number, now = Date.now()): { date: string; api: string; note: string } {
  let d = new Date(ms);
  let note = '';
  while (d.getTime() > now + 15 * DAY) {
    d = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()));
    note = `Same day in ${d.getUTCFullYear()}`;
  }
  const near = d.getTime() > now - 6 * DAY;
  return {
    date: d.toISOString().slice(0, 10),
    api: near ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive',
    note: note || (near ? 'Forecast' : 'Recorded'),
  };
}

const cache = new Map<string, Promise<Day | null>>();
function weather(lat: number, lng: number, ms: number): Promise<Day | null> {
  const r = resolve(ms);
  const key = `${lat.toFixed(2)},${lng.toFixed(2)},${r.date}`;
  let p = cache.get(key);
  if (!p) {
    const url = `${r.api}?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}&hourly=temperature_2m,cloud_cover&start_date=${r.date}&end_date=${r.date}&timezone=auto`;
    p = fetch(url)
      .then((x) => (x.ok ? x.json() : null))
      .then((j) => (j?.hourly ? { temps: j.hourly.temperature_2m, cloud: j.hourly.cloud_cover, note: r.note } : null))
      .catch(() => null)
      .then((d) => {
        if (!d) cache.delete(key); // a failed read (a 429, offline) is tried again next time
        return d;
      });
    cache.set(key, p);
  }
  return p;
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const hourLabel = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;

export const exoEnabled = () => new URLSearchParams(location.search).has('exo');

export interface ExoPanel {
  /** Called each time the probe card is redrawn: adds the button to a pinned card, and follows the date when open. */
  sync(hit: { lngLat: [number, number]; label?: string } | null, ms: number, card: HTMLElement): void;
}

export function mountExo(probeEl: HTMLElement): ExoPanel {
  const root = document.createElement('aside');
  root.id = 'exo';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'A monarch at this place');
  root.innerHTML = `<div class="exo-head"><span id="exo-title"></span><button type="button" class="exo-x" aria-label="Close the monarch">&times;</button></div>
    <iframe id="exo-frame" title="A sketched monarch living this place's air temperature" loading="lazy"></iframe>
    <div class="exo-bar"><button type="button" id="exo-play" aria-label="Pause the day" aria-pressed="true"></button>
    <input id="exo-hour" type="range" min="${HOURS[0]}" max="${HOURS[1]}" step="0.25" value="13" aria-label="Hour of the day">
    <output id="exo-read" aria-live="off"></output></div>
    <div class="exo-note" id="exo-note"></div>`;
  document.body.append(root);
  const frame = root.querySelector<HTMLIFrameElement>('#exo-frame')!;
  const hourEl = root.querySelector<HTMLInputElement>('#exo-hour')!;
  const playBtn = root.querySelector<HTMLButtonElement>('#exo-play')!;
  const readEl = root.querySelector<HTMLOutputElement>('#exo-read')!;
  const noteEl = root.querySelector<HTMLElement>('#exo-note')!;
  const titleEl = root.querySelector<HTMLElement>('#exo-title')!;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  let ready = false;
  let day: Day | null = null;
  let spot: { lngLat: [number, number]; label?: string } | null = null;
  let at = 0;
  let playing = !reduce.matches;
  let raf = 0;
  let lastKey = '';

  /** The hour's temperature, blended between the two nearest whole hours so the slider stays smooth. */
  const tempAt = (h: number): number | null => {
    if (!day) return null;
    const a = Math.floor(h);
    const f = h - a;
    const t0 = day.temps[a];
    const t1 = day.temps[Math.min(23, a + 1)];
    if (t0 == null) return null;
    return t1 == null ? t0 : t0 + (t1 - t0) * f;
  };

  const push = () => {
    const h = +hourEl.value;
    const t = tempAt(h);
    const cl = day?.cloud[Math.round(h)] ?? 0;
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    readEl.textContent = t == null
      ? 'No weather for this day'
      : `${hourLabel(hh)}${mm ? `:${String(mm).padStart(2, '0')}` : ''} · ${t.toFixed(0)} °C · ${Math.round((t * 9) / 5 + 32)} °F${cl >= 70 ? ' · cloudy' : ''}`;
    if (t != null && ready) frame.contentWindow?.postMessage({ type: 'exo-air', t, cloudy: cl >= 70 }, location.origin);
  };

  const setPlay = (on: boolean) => {
    playing = on;
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.setAttribute('aria-label', on ? 'Pause the day' : 'Play the day');
    playBtn.textContent = on ? '❚❚' : '▶';
    cancelAnimationFrame(raf);
    if (!on) return;
    let prev = performance.now();
    const tick = (now: number) => {
      // One hour per second; loop from dawn to dusk.
      let h = +hourEl.value + ((now - prev) / 1000) * 1;
      prev = now;
      if (h > HOURS[1]) h = HOURS[0];
      hourEl.value = String(h);
      push();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  playBtn.addEventListener('click', () => setPlay(!playing));
  hourEl.addEventListener('input', () => {
    setPlay(false);
    push();
  });

  addEventListener('message', (e) => {
    if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.type === 'exo-ready') {
      ready = true;
      push();
    }
  });

  let opener: HTMLElement | null = null;
  const close = () => {
    root.hidden = true;
    opener?.isConnected ? opener.focus() : null;
    cancelAnimationFrame(raf);
    frame.src = 'about:blank'; // unloads Exo, which stops its WebGL loop
    ready = false;
    lastKey = '';
  };
  root.querySelector('.exo-x')!.addEventListener('click', close);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  const load = async () => {
    if (!spot) return;
    const [lng, lat] = spot.lngLat;
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${fmtDate(at)}`;
    if (key === lastKey) return;
    lastKey = key;
    titleEl.textContent = `${spot.label ? `Near ${spot.label}` : 'Here'} · ${fmtDate(at)}`;
    noteEl.textContent = 'Reading the weather…';
    const got = await weather(lat, lng, at);
    if (key !== lastKey) return; // the pin or the date moved on
    day = got;
    noteEl.textContent = got
      ? `${got.note} air temperature from Open-Meteo. Exo is a monarch sketch: how warm the day is decides if it can fly.`
      : 'No weather came back for this place and day.';
    push();
  };

  const open = () => {
    if (root.hidden) {
      root.hidden = false;
      if (!frame.src || frame.src === 'about:blank' || frame.src.endsWith('/about:blank')) frame.src = `${import.meta.env.BASE_URL}exo/index.html?embed=1`;
      setPlay(playing);
      root.querySelector<HTMLElement>('.exo-x')!.focus();
    }
    void load();
  };

  probeEl.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.exo-open')) {
      opener = probeEl.querySelector('.exo-open');
      open();
    }
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
