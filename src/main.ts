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
import { countdownText } from './ui/countdown';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { GRID_RES } from './core/grid';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN_DRAWER_KEY = 'hatch.drawerSeen.v1';

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
  const updateProbe = () => showProbe(probeEl, registry, hit, time.cursor);

  // Space the panels leave for the Midwest. On a short screen (a phone on its side) they can add up to more than the
  // window, which makes the map fit throw, so shrink both edges to always leave at least 80px of map.
  const padding = () => {
    const top = $('sub').getBoundingClientRect().bottom + 8;
    const bottom = $('bottom').offsetHeight + 8;
    const k = Math.min(1, (window.innerHeight - 80) / (top + bottom));
    return { top: Math.max(0, top * k), bottom: Math.max(0, bottom * k) };
  };
  const map = createMap({
    container: $<HTMLDivElement>('map'),
    registry,
    time,
    padding,
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

  const refresh = () => {
    map.refresh();
    updateProbe();
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
    .map((m) => `<option value="${m}">${m === TYPICAL ? 'All years' : m} (${firstBroodCount(m)})</option>`)
    .join('');
  picker.value = initialMode;
  picker.title = 'Season to replay (first-brood sightings in brackets)';
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
  $('why').addEventListener('click', () => toggleDrawer(true));

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
      if ((e as Error).name !== 'AbortError') say('Could not share: copy the address bar instead');
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
        say(here === first ? 'You are the yellow dot' : 'You are the yellow dot (card shows the nearest land hex)');
      },
      (err) => (done(), say(err.code === err.PERMISSION_DENIED ? 'Location permission was declined' : 'Could not get your location')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });

  // ?today=2027-01-15 fakes the clock, to check the off-season countdown.
  const today = params.get('today');
  $('countdown').textContent = countdownText(today && !Number.isNaN(Date.parse(today)) ? Date.parse(today) : Date.now());

  // The drawer opens by itself once per browser, so the honesty is seen, not just available.
  let seen = true;
  try {
    seen = localStorage.getItem(SEEN_DRAWER_KEY) === '1';
    localStorage.setItem(SEEN_DRAWER_KEY, '1');
  } catch {
    /* storage blocked: skip the auto-open rather than nag every visit */
  }
  if (!seen && !params.has('noauto')) toggleDrawer(true);

  document.documentElement.style.setProperty('--bg', theme.bg);
  map.fit(padding());
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => map.fit(padding()), 150);
  });
  refresh();
  (window as unknown as { __hatch: unknown }).__hatch = { time, registry, luna };
}

start();
