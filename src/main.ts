import './style.css';
import { LayerRegistry } from './core/registry';
import { TimeAxis, type TimeSpec } from './core/timeAxis';
import { createLunaLayer, modeLabel, replayTimeSpec } from './layers/lunaReplay';
import { data, firstBroodCount, TYPICAL, type Mode } from './layers/lunaData';
import { createMap, type ProbeHit } from './map/map';
import { theme } from './map/basemap';
import { mountScrubber } from './ui/scrubber';
import { mountCaveatDrawer } from './ui/caveatDrawer';
import { mountLayerList, mountLegend, showProbe } from './ui/panels';
import { countdownParts } from './ui/countdown';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { GRID_RES } from './core/grid';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN_KEY = 'hatch.seen.v2';

function start() {
  const params = new URLSearchParams(location.search);
  const years = data.years.map(String);
  // Default: every year pooled by day of year (one season alone is too sparse to show the wave). ?year=2025 replays one season.
  const asked = params.get('year');
  const initialMode: Mode = asked && years.includes(asked) ? asked : TYPICAL;
  // ?date=06-10 (or 2025-06-10) puts the cursor on that calendar day; default 10 June, when the wave crosses the middle.
  const md = params.get('date')?.match(/(\d{2})-(\d{2})$/);
  const [month, day] = md ? [Number(md[1]) - 1, Number(md[2])] : [5, 10];

  const luna = createLunaLayer(initialMode);
  const registry = new LayerRegistry();
  registry.register(luna, replayTimeSpec(initialMode, month, day));

  const time = new TimeAxis(registry.activeTime()!);
  let spec: TimeSpec | null = registry.activeTime();

  let hit: ProbeHit | null = null;
  let pinned = false;
  const probeEl = $('probe');
  // With a mouse, the hex card sits next to the pointer, like a tooltip, so hovering visibly does something.
  // Touch screens and "My area" keep it docked above the time bar.
  const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
  // Placing is separate from rebuilding: a pan only moves the card, so a screen reader doesn't re-read it every frame.
  const placeProbe = () => {
    // A pinned card stays on its hex as the map pans or zooms: re-project the hex rather than reuse the click point.
    const px = hover.matches && !probeEl.hidden && hit?.px ? (pinned ? (map.project(hit.lngLat) ?? hit.px) : hit.px) : undefined;
    probeEl.classList.toggle('at-pointer', !!px);
    probeEl.classList.toggle('pinned', !!px && pinned);
    // A card that follows the pointer would make a screen reader read out every hex swept over; announce it once pinned.
    probeEl.setAttribute('aria-live', px && !pinned ? 'off' : 'polite');
    // A pinned hex panned off-screen hides its card until it comes back, rather than leaving it stuck at the edge.
    probeEl.style.visibility = px && (px[0] < 0 || px[1] < 0 || px[0] > window.innerWidth || px[1] > window.innerHeight) ? 'hidden' : '';
    if (!px) return probeEl.style.removeProperty('transform');
    const { width: w, height: h } = probeEl.getBoundingClientRect();
    const x = Math.max(8, px[0] + 16 + w > window.innerWidth - 8 ? px[0] - 16 - w : px[0] + 16);
    const y = Math.max(8, Math.min(px[1] - h / 2, window.innerHeight - h - 8));
    probeEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  // Set once the drawer is mounted: its spot card follows the tapped hex (or My area) and the date.
  let followSpot = (_t: number) => {};
  const updateProbe = () => {
    showProbe(probeEl, registry, hit, time.cursor);
    placeProbe();
    followSpot(time.cursor);
  };

  // Space the panels leave for the Midwest. On a short screen (a phone on its side) they can add up to more than the
  // window, which makes the map fit throw, so shrink both edges to always leave at least 80px of map.
  const phone = window.matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 500px)');
  const padding = () => {
    const top = $('top').getBoundingClientRect().bottom + 8;
    // On wide screens the legend and card sit in the bottom-left corner, beside the map rather than under it.
    const bottom = (phone.matches ? $('bottom').offsetHeight : $('bottom').offsetHeight - $('floats').offsetHeight) + 8;
    const k = Math.min(1, (window.innerHeight - 80) / (top + bottom));
    return { top: Math.max(0, top * k), bottom: Math.max(0, bottom * k) };
  };
  const map = createMap({
    container: $<HTMLDivElement>('map'),
    registry,
    time,
    padding,
    onMove: (moved) => ($('recenter').hidden = !moved),
    onView: () => pinned && placeProbe(),
    onProbe: (h, clicked) => {
      if (clicked) {
        // Tap pins the card; tapping the same thing again (or empty space) unpins it. Hover alone never unpins.
        const same = pinned && h !== null && hit !== null && h.cell === hit.cell && h.picked?.object === hit.picked?.object;
        pinned = h !== null && !same;
        hit = pinned ? h : null;
        map.setMarker(null); // any tap replaces the "My area" pin
      } else if (!pinned) hit = h;
      updateProbe();
    },
  });

  // The map is a canvas, so screen readers get the day's picture in words (read with the map, not announced each frame).
  const srSummary = $('sr-summary');
  const refresh = () => {
    map.refresh();
    updateProbe();
    srSummary.textContent = luna.summary(time.cursor);
  };
  time.subscribe(refresh);
  registry.subscribe(() => {
    const next = registry.activeTime();
    if (next && next !== spec) {
      spec = next;
      time.setSpec(next);
    }
    refresh();
  });

  // Season picker: switching keeps the cursor on the same calendar day.
  const picker = $<HTMLSelectElement>('season');
  picker.innerHTML = [TYPICAL, ...[...years].reverse()]
    .map((m) => `<option value="${m}">${m === TYPICAL ? 'All years' : m} (${firstBroodCount(m).toLocaleString()} moths)</option>`)
    .join('');
  picker.value = initialMode;
  picker.title = 'Season to replay (first-wave moths seen, in brackets)';
  picker.addEventListener('change', () => {
    const now = new Date(time.cursor);
    luna.setMode(picker.value);
    hit = null;
    pinned = false;
    map.setMarker(null);
    $('season-name').textContent = modeLabel(picker.value);
    registry.setTime(luna.id, replayTimeSpec(picker.value, now.getUTCMonth(), now.getUTCDate()));
  });
  $('season-name').textContent = modeLabel(initialMode);

  mountScrubber($('bar'), time);
  mountLayerList($('layers'), registry);
  mountLegend($('legend'), registry);
  const toggleDrawer = mountCaveatDrawer($('info-btn'), $('drawer'), registry);
  followSpot = (t) => toggleDrawer.setSpot(pinned && hit ? hit.lngLat : null, t);
  // "why?" opens the About drawer at the part that says how sure the forecast is (marked data-why), and flashes it,
  // so the tap visibly lands even when the drawer is already open.
  let flashTimer = 0;
  $('why').addEventListener('click', () => {
    toggleDrawer(true);
    const drawer = $('drawer');
    const target = drawer.querySelector<HTMLElement>('[data-why]');
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    // Scroll the drawer itself: scrollIntoView would also nudge the fixed page and leave a gap at the bottom.
    const top = target ? target.getBoundingClientRect().top - drawer.getBoundingClientRect().top + drawer.scrollTop - 12 : 0;
    drawer.scrollTo({ top, behavior });
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true }); // a screen reader lands on the answer, not on the close button
    }
    const flash = target ?? drawer.querySelector<HTMLElement>('.cav') ?? drawer;
    flash.classList.remove('flash');
    void flash.offsetWidth; // restart the animation on a repeat tap
    flash.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => flash.classList.remove('flash'), 1500);
  });

  // Keep the address bar in step with the view, so any link copied or shared reopens the same season and day.
  const viewUrl = () => {
    const q = new URLSearchParams(location.search);
    const d = new Date(time.cursor);
    q.set('date', `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    if (picker.value === TYPICAL) q.delete('year');
    else q.set('year', picker.value);
    q.delete('noauto');
    q.delete('today');
    return `${location.pathname}?${q}`;
  };
  // Throttled, not debounced: playback updates every frame, and the address bar should still keep up.
  let urlTimer = 0;
  const syncUrl = () => {
    if (urlTimer) return;
    urlTimer = window.setTimeout(() => {
      urlTimer = 0;
      history.replaceState(null, '', viewUrl());
    }, 400);
  };
  time.subscribe(syncUrl);
  picker.addEventListener('change', syncUrl);

  const msg = $('action-msg');
  let msgTimer = 0;
  const say = (text: string) => {
    msg.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => (msg.textContent = ''), 6000);
  };

  $('share').addEventListener('click', async () => {
    const url = new URL(viewUrl(), location.href).href;
    try {
      if (navigator.share) await navigator.share({ title: 'Hatch: when luna moths fly', url });
      else {
        await navigator.clipboard.writeText(url);
        say('Link copied');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say('Couldn\u2019t share. Copy the link from the address bar.');
    }
  });

  // "My area": one location fix (never stored or sent anywhere), then the forecast card for that hex, pinned.
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return say('Location is not available in this browser');
    const btn = $<HTMLButtonElement>('locate');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    const done = () => {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    };
    say('Finding you…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        done();
        const you: [number, number] = [coords.longitude, coords.latitude];
        // Lakeshore cities (Chicago, Milwaukee, Cleveland) can sit in a hex whose centre is in the lake, so
        // fall back to the nearest land hex within two rings.
        const ring = gridDisk(latLngToCell(coords.latitude, coords.longitude, GRID_RES), 2)
          .map((c) => {
            const [lat, lng] = cellToLatLng(c);
            return { cell: c, lngLat: [lng, lat] as [number, number], d: (lat - coords.latitude) ** 2 + (lng - coords.longitude) ** 2 };
          })
          .sort((a, b) => a.d - b.d);
        const first = { cell: latLngToCell(coords.latitude, coords.longitude, GRID_RES), lngLat: you };
        const here: ProbeHit | undefined = [first, ...ring].find((h) => luna.probe?.(h.lngLat, time.cursor));
        if (!here) {
          map.setMarker(null);
          say('You are outside the 7 states Hatch covers so far (IL, IN, IA, MI, MN, OH, WI)');
          return;
        }
        hit = here;
        pinned = true;
        map.setMarker(you);
        updateProbe();
        say(here === first ? 'You are the yellow dot' : 'You are the yellow dot (the card shows the nearest hexagon on land)');
      },
      (err) => (done(), say(err.code === err.PERMISSION_DENIED ? 'Location access is off for this site' : 'Could not get your location')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });

  // ?today=2027-01-15 fakes the clock, to check the off-season countdown.
  const today = params.get('today');
  const [short, more] = countdownParts(today && !Number.isNaN(Date.parse(today)) ? Date.parse(today) : Date.now());
  const moreEl = document.createElement('span');
  moreEl.className = 'more';
  moreEl.textContent = more;
  $('countdown').replaceChildren(short, moreEl);

  // First visit: the map comes first. The About button and Play glow briefly to show where the story and the
  // replay are; the panel itself opens only when asked (or with ?caveats).
  let seen = true;
  try {
    seen = localStorage.getItem(SEEN_KEY) === '1';
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage blocked: skip the hint rather than repeat it every visit */
  }
  if (!seen && !params.has('noauto')) for (const id of ['info-btn', 't-play']) $(id).classList.add('hint');
  for (const id of ['info-btn', 't-play']) $(id).addEventListener('click', () => ['info-btn', 't-play'].forEach((x) => $(x).classList.remove('hint')));

  document.documentElement.style.setProperty('--bg', theme.bg);
  map.fit(padding());
  $('recenter').addEventListener('click', () => map.fit(padding()));
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => (map.fit(padding()), placeProbe()), 150);
  });
  refresh();
  (window as unknown as { __hatch: unknown }).__hatch = { time, registry, luna, map };
}

start();
