import { cellToLatLng, polygonToCells } from 'h3-js';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import states from '../data/midwest-states.json';

export const GRID_RES = 4;

export interface StateProps {
  abbr: string;
  name: string;
  core: boolean;
}
export type StateFeature = Feature<Polygon | MultiPolygon, StateProps>;
export const stateCollection = states as unknown as FeatureCollection<Polygon | MultiPolygon, StateProps>;

export interface Cell {
  id: string;
  lat: number;
  lng: number;
  state: string;
}

/**
 * Cover the seven core states with H3 cells. polygonToCells wants [lat, lng] rings
 * (or pass isGeoJson=true for [lng, lat]); a cell belongs to a polygon if its CENTRE is inside.
 */
export function buildGrid(res = GRID_RES): Cell[] {
  const seen = new Map<string, Cell>();
  for (const f of stateCollection.features) {
    if (!f.properties.core) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      for (const id of polygonToCells(poly, res, true)) {
        if (seen.has(id)) continue;
        const [lat, lng] = cellToLatLng(id);
        seen.set(id, { id, lat, lng, state: f.properties.abbr });
      }
    }
  }
  return [...seen.values()];
}

export const MIDWEST_BOUNDS: [[number, number], [number, number]] = [
  [-97.3, 36.8],
  [-80.4, 49.5],
];
