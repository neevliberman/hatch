import { GeoJsonLayer } from '@deck.gl/layers';
import { DataFilterExtension, FillStyleExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import type { Feature, FeatureCollection } from 'geojson';
import { stateCollection } from '../core/grid';
import type { Theme } from '../core/layer';
import { isDark, onTheme, palette, recoloured } from '../theme';
import { unpackGeo } from './unpackGeo';

const P = palette;

export const theme: Theme = {
  bg: P.bg,
  hexEdge: P.hexEdge,
  text: isDark() ? '#eadfc8' : '#2b241c',
};
onTheme(() => Object.assign(theme, { bg: P.bg, hexEdge: P.hexEdge, text: isDark() ? '#eadfc8' : '#2b241c' }));

/** [text, lng, lat, zoom it shows from, kind, rank (population for towns; bigger names first)]. */
export type Label = [string, number, number, number, 'state' | 'water' | 'park' | 'city' | 'town', number, number?, number?];
type Props = { z: number; great?: number; w?: number; kind?: number };
interface Part {
  version: number;
  water: FeatureCollection;
  rivers: FeatureCollection;
  roads: FeatureCollection;
  green: FeatureCollection;
  labels: Label[];
  /** The sea (kind 0) and land (kind 1) around the forecast states, and the other states' faint lines (kind 2). */
  outside?: FeatureCollection;
  /** Shore hexagons by resolution: [hexagon, forecast neighbour whose colour it takes] (see pipeline/basemap). */
  pads?: Record<string, [string, string][]>;
}

/**
 * Map detail (rivers, lakes, highways, national forests and parks, place names), built by pipeline/basemap from
 * public-domain data into public/basemap/. Two files: the zoomed-out views' share is fetched at start, the rest once
 * you zoom in past DETAIL_ZOOM. Like the finer hexes, only over http(s): the one-file preview has no files beside it.
 */
const DETAIL_ZOOM = 6.5;
/** Woods (USGS land cover) show from here, in their own file: tree marks over the whole-Midwest view would be noise. */
const WOODS_ZOOM = 6;
/** The shore fix (see shore()), its own file for town-scale views. */
const SHORE_ZOOM = 7;
const parts: {
  overview?: Part;
  detail?: Part;
  woods?: { version: number; woods: FeatureCollection };
  shore?: { version: number; sea: Feature; dry: FeatureCollection; wet: FeatureCollection; ink: Feature };
} = {};
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
  if (zoom >= SHORE_ZOOM - 0.5) names.push('shore');
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
        parts[name as keyof typeof parts] = unpackGeo(p);
        queueMicrotask(onLoad);
      })
      // A dropped connection: try again on a later zoom, a few times. A missing or broken file stays given up on
      // (this runs every frame, so retrying it would fetch on every frame).
      .catch((e) => {
        if (e instanceof TypeError && (tries[name] = (tries[name] ?? 0) + 1) < 3) asked.delete(name);
      });
  }
}

/**
 * The hexagons just past the shores and state lines, paired with the forecast neighbour they take their colour from,
 * once the mask that trims them (`outside`, drawn over the hexagons) is loaded: they fill the strip of bare paper a
 * hexagon grid leaves along every edge. Null when not available (the one-file build, or not loaded yet).
 */
export const padsFor = (res: number): [string, string][] | null =>
  (parts.overview?.outside && (res > 4 ? parts.detail : parts.overview)?.pads?.[res]) || null;

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
  if (!__BASEMAP__ || !p || zoom < WOODS_ZOOM) return [];
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

// (The sea layer gets another id when its data changes: deck.gl drew stray triangles when a layer's polygons were swapped
// for others under the same id.)
// The sea's features: the overview's, or from SHORE_ZOOM, once shore.json is in, the ones with the shore land given back
// (see shore() below). The same arrays come back, so deck does not re-tessellate them each frame.
let seaFixed: Feature[] | null = null;
const seaOf = (p: Part, zoom: number): Feature[] =>
  zoom >= SHORE_ZOOM && parts.shore ? (seaFixed ??= [parts.shore.sea]) : seaPlain(p);
let seaOverview: Feature[] | null = null;
const seaPlain = (p: Part): Feature[] =>
  (seaOverview ??= (p.outside?.features ?? []).filter((f) => !(f.properties as Props).kind));
let lakesOverview: Feature[] | null = null;
const lakesOf = (p: Part): Feature[] =>
  (lakesOverview ??= p.water.features.filter((f) => (f.properties as Props).great));
let landLayer: Layer | null = null;

// Over the hexagons: the land around the forecast states (paper, a shade darker), and the sea, so a hexagon poking
// past a shore or a state line is cut off there. The land never changes, so it is built once.
const outside = (p: Part, zoom: number): Layer[] =>
  p.outside
    ? [
        (landLayer ??= new GeoJsonLayer({
          id: 'outside',
          data: p.outside.features.filter((f) => (f.properties as Props).kind),
          filled: true,
          stroked: true,
          getFillColor: P.landOuter,
          getLineColor: (f: Feature) => ((f.properties as Props).kind === 2 ? P.neighbourLine : P.transparent),
          getLineWidth: 1,
          lineWidthUnits: 'pixels',
          pickable: false,
        })),
        new GeoJsonLayer({ id: zoom >= SHORE_ZOOM && parts.shore ? 'outside-sea-fine' : 'outside-sea', data: seaOf(p, zoom), filled: true, stroked: false, getFillColor: P.water,
          pickable: false }),
      ]
    : [];

// Zoomed in, the state outlines' coasts (Census) and the lake shores (Natural Earth) run a little apart, which leaves
// an ink line floating in the lake or a strip beside it. From SHORE_ZOOM the sea and the Great Lakes are drawn again
// over the state lines, so the shore is just where the hexagons meet the water. The Census 1:10m coast is also smoothed
// over a kilometre or so (Chicago's Streeterville and Navy Pier landfill is lake on it). pipeline/basemap gives that
// land back in the lakes and the sea mask, so its hexagons show, and ships the rest in shore.json: the water the 1:10m
// outline keeps dry (`wet`, painted over it) and the state lines without their coast (`ink`), whose old coast would
// cut through the land given back.
// The filtered features are kept, not the layers: deck finalizes a layer once it leaves the layer list (zoomed back
// under SHORE_ZOOM), and handing it the same instance again later fails. Fresh layers on the same data cost nothing.
const shore = (zoom: number): Layer[] => {
  const p = parts.overview;
  if (!__BASEMAP__ || !p?.outside || zoom < SHORE_ZOOM) return [];
  const water = (id: string, features: Feature[]) =>
    // A water-coloured edge as well, over the half of the ink line that lies on the land side of the shore.
    new GeoJsonLayer({ id, data: features, filled: true, stroked: true, getFillColor: P.water, getLineColor: P.water,
      getLineWidth: 2, lineWidthUnits: 'pixels', pickable: false });
  if (!parts.shore) return [water('sea-top', seaOf(p, zoom)), water('lakes-top', lakesOf(p))];
  return [water('sea-top', seaOf(p, zoom)), water('shore-wet', parts.shore.wet.features)];
};

let inkData: Feature[] | null = null;
/** The shore land given back (shore.json), filled like the other land, under the hexagons that now cover it. */
const dryLayer = (zoom: number): Layer[] =>
  __BASEMAP__ && parts.shore && zoom >= SHORE_ZOOM
    ? [new GeoJsonLayer({ id: 'shore-land', data: parts.shore.dry.features, filled: true, stroked: false,
        getFillColor: P.land, pickable: false })]
    : [];
function detailLayers(name: 'overview' | 'detail', zoom: number): Layer[] {
  const p = parts[name];
  if (!__BASEMAP__ || !p) return [];
  const filter = { extensions: zoomFilter, getFilterValue: getZ, filterRange: [-1, zoom + 1e-3] as [number, number], pickable: false };
  return [
    ...(name === 'overview' ? outside(p, zoom) : []),
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
      // From SHORE_ZOOM, once shore.json is in, the Great Lakes (z 0) are left out: the sea mask is cut to the finer
      // shore (see shore()), and their Natural Earth shapes would only cover the land it gives back.
      ...(name === 'overview' && zoom >= SHORE_ZOOM && parts.shore ? { filterRange: [0.5, zoom + 1e-3] as [number, number] } : {}),
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

// The state shapes never change: build their layers once. Fresh arrays as `data` each frame would make deck
// re-tessellate every outline on every playback frame.
let states: { under: Layer; neighbours: Layer; outlineData: Feature[] } | null = null;
const stateLayers = () =>
  (states ??= {
    under: new GeoJsonLayer({
      id: 'states-fill',
      data: stateCollection.features,
      filled: true,
      stroked: false,
      getFillColor: (f) => ((f.properties as { core: boolean }).core ? P.land : P.landOuter),
      pickable: false,
    }),
    neighbours: new GeoJsonLayer({
      id: 'states-outline-faint',
      data: stateCollection.features.filter((f) => !f.properties.core),
      filled: false,
      stroked: true,
      getLineColor: P.neighbourLine,
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      pickable: false,
    }),
    outlineData: stateCollection.features.filter((f) => f.properties.core),
  });

/** The core states' outline: from SHORE_ZOOM, once shore.json is in, the one without its coast (see shore()). A fresh
 *  layer each time, as the other layers that come and go with the zoom. */
const outlineLayer = (zoom: number, data: Feature[]): Layer => {
  const inked = __BASEMAP__ && parts.shore && zoom >= SHORE_ZOOM;
  return new GeoJsonLayer({
    id: inked ? 'states-outline-ink' : 'states-outline',
    data: inked ? (inkData ??= [parts.shore!.ink]) : data,
    filled: false,
    stroked: true,
    getLineColor: P.stateLine,
    getLineWidth: 1.4,
    lineWidthUnits: 'pixels',
    pickable: false,
  });
};

/**
 * Basemap layers around the data: `under` the hexagons (land), `mid` between the hexagons and the sighting dots
 * (the mask round the forecast states, lakes, roads, forests, state lines, rivers: the dots stay on top). The same
 * objects come back until the zoom changes or another part of the basemap arrives, so a playback frame costs nothing.
 *
 * A river along a state line is drawn on the line itself (pipeline/basemap snaps it), so the order is: river casings,
 * then the state lines, then the river ink. A border river reads as one blue river edged in paper, not as a river
 * beside an ink line; a river crossing a state line shows as a blue dot on it.
 */
let built: { key: string; layers: { under: Layer[]; mid: Layer[] } } | null = null;
/** After a light/dark switch: the layers above hold the old colours, so build them again (and again for deck, which
 *  finalizes the old instances once they leave the layer list). */
export const resetBasemap = () => {
  landLayer = null;
  states = null;
  built = null;
};
export function basemapLayers(zoom: number): { under: Layer[]; mid: Layer[] } {
  const key = `${zoom}|${!!parts.overview}|${!!parts.detail}|${!!parts.woods}|${!!parts.shore}`;
  if (built?.key === key) return built.layers;
  want(zoom);
  const { under, neighbours, outlineData } = stateLayers();
  const all = [...detailLayers('overview', zoom), ...detailLayers('detail', zoom)];
  const kind = (re: RegExp) => all.filter((l) => re.test(l.id));
  built = {
    key,
    layers: {
      under: [under, ...dryLayer(zoom)].map(recoloured),
      // The overview's `outside` mask comes first: woods and everything else go over it.
      mid: [...kind(/^outside/), ...woodsLayers(zoom), ...kind(/^(green|water|roads)-/), ...kind(/^rivers-case-/),
        neighbours, outlineLayer(zoom, outlineData), ...shore(zoom), ...kind(/^rivers-(overview|detail)/)].map(recoloured),
    },
  };
  return built.layers;
}
