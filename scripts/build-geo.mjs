// Build-time: slice the Midwest out of us-atlas (Census 1:10m states) into a small GeoJSON.
// Output is committed so the app never needs the big TopoJSON at runtime.
import { readFileSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';

const topo = JSON.parse(readFileSync('node_modules/us-atlas/states-10m.json', 'utf8'));
const CORE = { '55': 'WI', '17': 'IL', '27': 'MN', '19': 'IA', '26': 'MI', '18': 'IN' };
const NEIGHBOR = { '39': 'OH', '29': 'MO', '38': 'ND', '46': 'SD', '31': 'NE', '21': 'KY' };

const round = (c) => (typeof c[0] === 'number' ? c.map((v) => +v.toFixed(3)) : c.map(round));
const all = feature(topo, topo.objects.states).features;
const features = [];
for (const f of all) {
  const id = String(f.id).padStart(2, '0');
  const abbr = CORE[id] ?? NEIGHBOR[id];
  if (!abbr) continue;
  features.push({
    type: 'Feature',
    properties: { abbr, name: f.properties.name, core: id in CORE },
    geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
  });
}
writeFileSync('src/data/midwest-states.json', JSON.stringify({ type: 'FeatureCollection', features }));
console.log(features.map((f) => f.properties.abbr).join(' '));
