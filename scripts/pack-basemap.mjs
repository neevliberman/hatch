// Build-time packing of public/basemap/*.json (Vite plugin, normal build only). The files stay as the pipeline wrote
// them; only the copies written to dist/ change. Every geometry's coordinates become one flat run of steps in whole
// thousandths of a degree (see src/map/unpackGeo.ts, which the app uses to rebuild them). The first map frame waits
// for overview.json, so about half the bytes there is about half the wait on a slow connection. The build checks the
// round trip and fails rather than ship anything that differs.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { unpackGeo } from '../src/map/unpackGeo.ts';

const milli = (v) => {
  const m = Math.round(v * 1000);
  if (m / 1000 !== v) throw new Error(`pack-basemap: ${v} has more than 3 decimals`);
  return m;
};
const ring = (pts) => {
  const out = [];
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    const mx = milli(px);
    const my = milli(py);
    out.push(mx - x, my - y);
    x = mx;
    y = my;
  }
  return out;
};

function geometry(g) {
  switch (g.type) {
    case 'LineString':
      g.coordinates = ring(g.coordinates);
      break;
    case 'MultiLineString':
    case 'Polygon':
      g.coordinates = g.coordinates.map(ring);
      break;
    case 'MultiPolygon':
      g.coordinates = g.coordinates.map((p) => p.map(ring));
      break;
    default:
      throw new Error(`pack-basemap: ${g.type} geometry is not handled`);
  }
}

/** A packed copy of one parsed basemap file. */
export function pack(file) {
  const out = JSON.parse(JSON.stringify(file));
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      if (typeof o.type === 'string' && o.coordinates) geometry(o);
      else Object.values(o).forEach(walk);
    }
  };
  walk(out);
  out.packed = 1;
  return out;
}

export default function packBasemap() {
  let dir = '';
  return {
    name: 'hatch-pack-basemap',
    apply: 'build',
    configResolved(c) {
      dir = join(resolve(c.root, c.build.outDir), 'basemap');
    },
    closeBundle() {
      let names;
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.json'));
      } catch {
        return; // the one-file build has no basemap
      }
      for (const n of names) {
        const path = join(dir, n);
        const plain = JSON.parse(readFileSync(path, 'utf8'));
        const packed = pack(plain);
        if (!isDeepStrictEqual(unpackGeo(JSON.parse(JSON.stringify(packed))), plain)) throw new Error(`pack-basemap: round trip changed ${n}`);
        writeFileSync(path, JSON.stringify(packed));
      }
    },
  };
}
