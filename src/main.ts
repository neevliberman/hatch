import './style.css';
import { buildGrid, GRID_RES } from './core/grid';
import { LayerRegistry } from './core/registry';
import { TimeAxis } from './core/timeAxis';
import { createDemoLayer } from './layers/demoHeatWave';
import { createMap } from './map/map';
import { theme } from './map/basemap';
import { mountScrubber } from './ui/scrubber';
import { mountCaveatDrawer } from './ui/caveatDrawer';
import { mountLayerList, mountLegend, showProbe } from './ui/panels';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function start() {
  const params = new URLSearchParams(location.search);
  const year = Number(params.get('year')) || new Date().getUTCFullYear();
  const time = new TimeAxis(year);
  const date = params.get('date'); // e.g. ?date=2026-06-20 (handy for screenshots)
  if (date && !Number.isNaN(Date.parse(date))) time.setCursor(Date.parse(date + 'T00:00:00Z'));

  const registry = new LayerRegistry();
  const grid = buildGrid(GRID_RES);
  const demo = createDemoLayer(year);
  registry.register(demo);
  await demo.load({ cells: grid.map((c) => c.id), res: GRID_RES, t0: time.start, t1: time.end });

  let probeCell: string | null = null;
  let pinned = false;
  const probeEl = $('probe');
  const updateProbe = () => showProbe(probeEl, registry, probeCell, time.cursor);

  const padding = () => ({ top: $('top').offsetHeight + $('layers').offsetHeight + 8, bottom: $('bar').offsetHeight + 8 });
  const map = createMap({
    container: $<HTMLDivElement>('map'),
    registry,
    time,
    padding,
    onProbe: (cell, isClick) => {
      if (isClick) {
        pinned = cell !== null && cell !== probeCell ? true : false;
        probeCell = pinned ? cell : null;
      } else if (!pinned) probeCell = cell;
      updateProbe();
    },
  });

  const refresh = () => {
    map.refresh();
    updateProbe();
  };
  time.subscribe(refresh);
  registry.subscribe(refresh);

  mountScrubber($('bar'), time);
  mountLayerList($('layers'), registry);
  mountLegend($('legend'), registry);
  mountCaveatDrawer($('info-btn'), $('drawer'), registry);

  document.documentElement.style.setProperty('--bg', theme.bg);
  map.fit(padding());
  refresh();
  (window as unknown as { __emergence: unknown }).__emergence = { time, registry, grid };
}

start();
