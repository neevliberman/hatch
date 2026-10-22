import './style.css';
import { LayerRegistry } from './core/registry';
import { dayOfYear, TimeAxis, type TimeSpec } from './core/timeAxis';
import { createLunaLayer, modeLabel, replayTimeSpec } from './layers/lunaReplay';
import { data, firstBroodCount, TYPICAL, type Mode } from './layers/lunaData';
import { createMap, type ProbeHit } from './map/map';
import { theme } from './map/basemap';
import { mountScrubber } from './ui/scrubber';
import { mountCaveatDrawer } from './ui/caveatDrawer';
import { mountLayerList, mountLegend, showProbe } from './ui/panels';
import { countdownText } from './ui/countdown';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN_DRAWER_KEY = 'hatch.drawerSeen.v1';

function start() {
  const params = new URLSearchParams(location.search);
  const years = data.years.map(String);
  // Default: every year pooled by day of year (one season alone is too sparse to show the wave). ?year=2025 replays one season.
  const asked = params.get('year');
  const initialMode: Mode = asked && years.includes(asked) ? asked : TYPICAL;
  // ?date=06-10 (or 2025-06-10) puts the cursor on that calendar day; default mid-June, when the wave crosses the middle.
  const md = params.get('date')?.match(/(\d{2})-(\d{2})$/);
  const initialDoy = md ? dayOfYear(Date.UTC(2025, Number(md[1]) - 1, Number(md[2]))) : 161;

  const luna = createLunaLayer(initialMode);
  const registry = new LayerRegistry();
  registry.register(luna, replayTimeSpec(initialMode, initialDoy));

  const time = new TimeAxis(registry.activeTime()!);
  let spec: TimeSpec | null = registry.activeTime();

  let hit: ProbeHit | null = null;
  let pinned = false;
  const probeEl = $('probe');
  const updateProbe = () => showProbe(probeEl, registry, hit, time.cursor);

  const padding = () => ({ top: $('top').offsetHeight + $('sub').offsetHeight + 8, bottom: $('bottom').offsetHeight + 8 });
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
    const doy = dayOfYear(time.cursor);
    luna.setMode(picker.value);
    hit = null;
    pinned = false;
    $('season-name').textContent = modeLabel(picker.value);
    registry.setTime(luna.id, replayTimeSpec(picker.value, doy));
  });
  $('season-name').textContent = modeLabel(initialMode);

  mountScrubber($('bar'), time);
  mountLayerList($('layers'), registry);
  mountLegend($('legend'), registry);
  const toggleDrawer = mountCaveatDrawer($('info-btn'), $('drawer'), registry);
  $('why').addEventListener('click', () => toggleDrawer(true));

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
  refresh();
  (window as unknown as { __hatch: unknown }).__hatch = { time, registry, luna };
}

start();
