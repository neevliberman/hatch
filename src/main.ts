import './style.css';
import { LayerRegistry } from './core/registry';
import { TimeAxis } from './core/timeAxis';
import { createDemoLayer, demoTimeSpec } from './layers/demoHeatWave';
import { createMap } from './map/map';
import { theme } from './map/basemap';
import { mountScrubber } from './ui/scrubber';
import { mountCaveatDrawer } from './ui/caveatDrawer';
import { mountLayerList, mountLegend, showProbe } from './ui/panels';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function start() {
  const params = new URLSearchParams(location.search);
  const year = Number(params.get('year')) || new Date().getUTCFullYear();

  const registry = new LayerRegistry();
  registry.register(createDemoLayer(), demoTimeSpec(year));

  // The scrubber range comes from the active layer's registered time spec.
  const time = new TimeAxis(registry.activeTime() ?? demoTimeSpec(year));
  const date = params.get('date'); // e.g. ?date=2026-06-20 (handy for screenshots)
  if (date && !Number.isNaN(Date.parse(date))) time.setCursor(Date.parse(date + 'T00:00:00Z'));
  let specKey = `${time.start}|${time.end}|${time.stepMs}`;

  let hit: Parameters<typeof showProbe>[2] = null;
  let pinned = false;
  const probeEl = $('probe');
  const updateProbe = () => showProbe(probeEl, registry, hit, time.cursor);

  const padding = () => ({ top: $('top').offsetHeight + $('layers').offsetHeight + 8, bottom: $('bar').offsetHeight + 8 });
  const map = createMap({
    container: $<HTMLDivElement>('map'),
    registry,
    time,
    padding,
    onProbe: (h, clicked) => {
      if (clicked) {
        pinned = h !== null && h.cell !== hit?.cell;
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
    const spec = registry.activeTime();
    if (spec && `${spec.start}|${spec.end}|${spec.stepMs}` !== specKey) {
      specKey = `${spec.start}|${spec.end}|${spec.stepMs}`;
      time.setSpec(spec);
    }
    refresh();
  });

  mountScrubber($('bar'), time);
  mountLayerList($('layers'), registry);
  mountLegend($('legend'), registry);
  mountCaveatDrawer($('info-btn'), $('drawer'), registry);

  document.documentElement.style.setProperty('--bg', theme.bg);
  map.fit(padding());
  refresh();
  (window as unknown as { __hatch: unknown }).__hatch = { time, registry };
}

start();
