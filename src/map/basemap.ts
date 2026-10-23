import { GeoJsonLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
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
const parts: { overview?: Part; detail?: Part } = {};
const asked = new Set<string>();
let onLoad: () => void = () => {};

export function loadBasemap(zoom: number, loaded: () => void) {
  onLoad = loaded;
  want(zoom);
}

/** Fetch the part a zoom needs (the detail file half a step early, so it is there when you arrive). */
function want(zoom: number) {
  if (!/^https?:$/.test(location.protocol)) return;
  for (const name of zoom >= DETAIL_ZOOM - 0.5 ? ['overview', 'detail'] : ['overview']) {
    if (asked.has(name)) continue;
    asked.add(name);
    fetch(new URL(`basemap/${name}.json`, document.baseURI).href)
      .then((r) => (r.ok ? (r.json() as Promise<Part>) : null))
      .then((p) => {
        if (p?.version !== 1) return;
        parts[name as 'overview' | 'detail'] = p;
        onLoad();
      })
      .catch(() => {});
  }
}

export const basemapLabels = (): Label[] => [...(parts.overview?.labels ?? []), ...(parts.detail?.labels ?? [])];

// Each feature shows from its own zoom: a GPU filter on `z`, so zooming never re-uploads the lines.
const zoomFilter = [new DataFilterExtension({ filterSize: 1 })];
const getZ = (f: Feature) => (f.properties as Props).z;

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
      getLineWidth: 1.2,
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
  return { under: [under], mid: [...detailLayers('overview', zoom), ...detailLayers('detail', zoom)], over: [neighbours, outline] };
}
