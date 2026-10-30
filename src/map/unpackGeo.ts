/**
 * Undo scripts/pack-basemap.mjs. In a packed basemap file every geometry's coordinates are one flat run of whole
 * thousandths of a degree per line or ring, each stored as the step from the point before (x, y, x, y, ...). The steps
 * are small and repeat, so gzip squeezes them to about half of what the plain coordinate pairs take.
 */
const ring = (flat: number[]): number[][] => {
  const out: number[][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < flat.length; i += 2) {
    x += flat[i]!;
    y += flat[i + 1]!;
    out.push([x / 1000, y / 1000]);
  }
  return out;
};

const rings = (a: unknown) => (a as number[][]).map(ring);

function geometry(g: { type: string; coordinates: unknown }) {
  switch (g.type) {
    case 'LineString':
      g.coordinates = ring(g.coordinates as number[]);
      break;
    case 'MultiLineString':
    case 'Polygon':
      g.coordinates = rings(g.coordinates);
      break;
    case 'MultiPolygon':
      g.coordinates = (g.coordinates as number[][][]).map(rings);
      break;
  }
}

/** Rebuild the geometries of a parsed file in place; returns it. Files that are not packed pass through untouched. */
export function unpackGeo<T extends { packed?: number }>(file: T): T {
  if (!file.packed) return file;
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      const r = o as { type?: unknown; coordinates?: unknown };
      if (typeof r.type === 'string' && r.coordinates) geometry(r as { type: string; coordinates: unknown });
      else Object.values(o).forEach(walk);
    }
  };
  walk(file);
  delete file.packed;
  return file;
}
