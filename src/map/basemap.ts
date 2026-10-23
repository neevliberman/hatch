import { GeoJsonLayer } from '@deck.gl/layers';
import { DataFilterExtension, FillStyleExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import type { Feature, FeatureCollection } from 'geojson';
import { stateCollection } from '../core/grid';
import type { Theme } from '../core/layer';
import { palette } from '../theme';

const P = palette;

export const theme: Theme = {
  bg: P.bg,
  hexEdge: P.hexEdge,
  text: '#2b241c',
};

/** [text, lng, lat, zoom it shows from, kind, rank (population for towns; bigger names first)]. */
export type Label = [string, number, number, number, 'state' | 'water' | 'park' | 'city' | 'town', number];
type Props = { z: number; great?: number; w?: number };
interface Part {
  version: number;
  water: FeatureCollection;
  rivers: FeatureCollection;
  roads: FeatureCollection;
  green: FeatureCollection;
  labels: Label[];
}

/**
 * Map detail (rivers, lakes, highways, national forests and parks, place names), built by pipeline/basemap from
 * public-domain data into public/basemap/. Two files: the zoomed-out views' share is fetched at start, the rest once
 * you zoom in past DETAIL_ZOOM. Like the finer hexes, only over http(s): the one-file preview has no files beside it.
 */
const DETAIL_ZOOM = 6.5;
/** Woods (USGS land cover) show from here, in their own file: tree marks over the whole-Midwest view would be noise. */
const WOODS_ZOOM = 6;
const parts: { overview?: Part; detail?: Part; woods?: { version: number; woods: FeatureCollection } } = {};
const asked = new Set<string>();
const tries: Record<string, number> = {};
let onLoad: () => void = () => {};

export function loadBasemap(zoom: number, loaded: () => void) {
  onLoad = loaded;
  want(zoom);
}

/** Fetch the part a zoom needs (the detail file half a step early, so it is there when you arrive). */
function want(zoom: number) {
  if (!/^https?:$/.test(location.protocol)) return;
  const names = ['overview'];
  if (zoom >= WOODS_ZOOM - 0.5) names.push('woods');
  if (zoom >= DETAIL_ZOOM - 0.5) names.push('detail');
  for (const name of names) {
    if (asked.has(name)) continue;
    asked.add(name);
    fetch(new URL(`basemap/${name}.json`, document.baseURI).href)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((p) => {
        if (p?.version !== 1) return;
        parts[name as keyof typeof parts] = p;
        queueMicrotask(onLoad);
      })
      // A dropped connection: try again on a later zoom, a few times. A missing or broken file stays given up on
      // (this runs every frame, so retrying it would fetch on every frame).
      .catch((e) => {
        if (e instanceof TypeError && (tries[name] = (tries[name] ?? 0) + 1) < 3) asked.delete(name);
      });
  }
}

export const basemapLabels = (): Label[] => [...(parts.overview?.labels ?? []), ...(parts.detail?.labels ?? [])];

// Each feature shows from its own zoom: a GPU filter on `z`, so zooming never re-uploads the lines.
const zoomFilter = [new DataFilterExtension({ filterSize: 1 })];
const getZ = (f: Feature) => (f.properties as Props).z;

// Woods are drawn the way a map marks them: little trees scattered over the ground, not a fill that would hide
// the forecast colour underneath. A 40 px tile with two trees, offset so the rows don't line up.
const TREE_MAPPING = { trees: { x: 0, y: 0, width: 40, height: 40 } };
let treeAtlas: HTMLCanvasElement | null = null;
const trees = () => {
  if (treeAtlas) return treeAtlas;
  const c = Object.assign(document.createElement('canvas'), { width: 40, height: 40 });
  const g = c.getContext('2d')!;
  g.fillStyle = g.strokeStyle = '#fff'; // a mask: the colour comes from getFillColor
  g.lineWidth = 1.4;
  for (const [x, y] of [[10, 10], [30, 30]] as const) {
    g.beginPath();
    g.arc(x, y - 1.5, 3, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(x, y + 1);
    g.lineTo(x, y + 4.5);
    g.stroke();
  }
  return (treeAtlas = c);
};

function woodsLayers(zoom: number): Layer[] {
  const p = parts.woods;
  if (!p || zoom < WOODS_ZOOM) return [];
  return [
    new GeoJsonLayer({
      id: 'woods',
      data: p.woods,
      filled: true,
      stroked: false,
      getFillColor: P.trees,
      pickable: false,
      extensions: [new FillStyleExtension({ pattern: true })],
      fillPatternAtlas: trees(),
      fillPatternMapping: TREE_MAPPING,
      fillPatternMask: true,
      getFillPattern: () => 'trees',
      fillPatternSizeUnits: 'pixels',
      getFillPatternScale: 1,
    }),
  ];
}

function detailLayers(name: 'overview' | 'detail', zoom: number): Layer[] {
  const p = parts[name];
  if (!p) return [];
  const filter = { extensions: zoomFilter, getFilterValue: getZ, filterRange: [-1, zoom + 1e-3] as [number, number], pickable: false };
  return [
    // National forests and parks: an ink outline in leaf green, no fill, so the forecast colours stay readable.
    new GeoJsonLayer({
      id: `green-${name}`,
      data: p.green,
      filled: false,
      stroked: true,
      getLineColor: P.forest,
      getLineWidth: 1.6,
      lineWidthUnits: 'pixels',
      ...filter,
    }),
    // Lakes are drawn over the hexagons in the water colour, so a shore hexagon stops at the shore.
    new GeoJsonLayer({
      id: `water-${name}`,
      data: p.water,
      filled: true,
      stroked: true,
      getFillColor: P.water,
      getLineColor: (f: Feature) => ((f.properties as Props).great ? P.transparent : P.riverInk),
      getLineWidth: 0.8,
      lineWidthUnits: 'pixels',
      ...filter,
    }),
    new GeoJsonLayer({
      id: `roads-${name}`,
      data: p.roads,
      stroked: true,
      getLineColor: P.road,
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      ...filter,
    }),
    // Rivers: a paper casing under a blue ink line, so they read on the dark peak green and the pale stages alike.
    new GeoJsonLayer({
      id: `rivers-case-${name}`,
      data: p.rivers,
      stroked: true,
      getLineColor: P.riverCase,
      getLineWidth: (f: Feature) => ((f.properties as Props).w ?? 1) + 2,
      lineWidthUnits: 'pixels',
      lineCapRounded: true,
      lineJointRounded: true,
      ...filter,
    }),
    new GeoJsonLayer({
      id: `rivers-${name}`,
      data: p.rivers,
      stroked: true,
      getLineColor: P.riverInk,
      getLineWidth: (f: Feature) => (f.properties as Props).w ?? 1,
      lineWidthUnits: 'pixels',
      lineCapRounded: true,
      lineJointRounded: true,
      ...filter,
    }),
  ];
}

/**
 * Basemap layers around the data: `under` the hexagons (land), `mid` between the hexagons and the sighting dots
 * (lakes, rivers, roads, forests: the dots stay on top), `over` everything (state lines).
 */
export function basemapLayers(zoom: number): { under: Layer[]; mid: Layer[]; over: Layer[] } {
  want(zoom);
  const core = stateCollection.features.filter((f) => f.properties.core);
  const under = new GeoJsonLayer({
    id: 'states-fill',
    data: stateCollection.features,
    filled: true,
    stroked: false,
    getFillColor: (f) => ((f.properties as { core: boolean }).core ? P.land : P.landOuter),
    pickable: false,
  });
  const neighbours = new GeoJsonLayer({
    id: 'states-outline-faint',
    data: stateCollection.features.filter((f) => !f.properties.core),
    filled: false,
    stroked: true,
    getLineColor: P.neighbourLine,
    getLineWidth: 1,
    lineWidthUnits: 'pixels',
    pickable: false,
  });
  const outline = new GeoJsonLayer({
    id: 'states-outline',
    data: core,
    filled: false,
    stroked: true,
    getLineColor: P.stateLine,
    getLineWidth: 1.4,
    lineWidthUnits: 'pixels',
    pickable: false,
  });
  return {
    under: [under],
    mid: [...woodsLayers(zoom), ...detailLayers('overview', zoom), ...detailLayers('detail', zoom)],
    over: [neighbours, outline],
  };
}
