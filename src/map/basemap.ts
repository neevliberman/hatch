import { GeoJsonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { stateCollection } from '../core/grid';
import type { Theme } from '../core/layer';
import { palette } from '../theme';

const P = palette;

export const theme: Theme = {
  bg: P.bg,
  hexEdge: P.hexEdge,
  text: '#2b241c',
};

/**
 * Basemap seam. Today: state outlines drawn from bundled us-atlas data (no network, no tiles).
 * Later: add a PMTiles/MapLibre basemap here (or in map.ts as a MapLibre layer below deck)
 * and keep returning `under` / `over` deck layers for fills and outlines. Nothing else changes.
 */
export function basemapLayers(): { under: Layer[]; over: Layer[] } {
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
  return { under: [under], over: [neighbours, outline] };
}
