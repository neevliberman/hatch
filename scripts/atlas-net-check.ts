// Checks the browser port of the Atlas network (src/atlas/net.ts) against torch's numbers on the same f16 weights.
//   node --experimental-strip-types scripts/atlas-net-check.ts
// Regenerate the fixture after a new export: python3 pipeline/atlas/net_reference.py > scripts/atlas-net.fixture.json
import { readFileSync } from 'node:fs';
import { AtlasNet, type ModelMeta } from '../src/atlas/net.ts';

const meta = JSON.parse(readFileSync('public/atlas/model.json', 'utf8')) as ModelMeta;
const buf = readFileSync('public/atlas/model.bin');
const net = new AtlasNet(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const cases = JSON.parse(readFileSync('scripts/atlas-net.fixture.json', 'utf8')) as {
  lat: number; lng: number; dd: number; day: number; ahead: number; top: [number, number][];
}[];

let worst = 0;
for (const c of cases) {
  const t0 = performance.now();
  const got = net.logShares({ lat: c.lat, lng: c.lng, dd: c.dd }, c.day, c.ahead);
  const ms = performance.now() - t0;
  for (const [i, want] of c.top) worst = Math.max(worst, Math.abs(got[i]! - want));
  const best = got.indexOf(Math.max(...got));
  console.log(`${c.lat},${c.lng} day ${c.day}: top ${best} (torch ${c.top[0]![0]}), ${ms.toFixed(1)} ms`);
  if (best !== c.top[0]![0]) throw new Error('top species differs from torch');
}
console.log(`worst log-share gap ${worst.toExponential(2)}`);
if (worst > 1e-3) throw new Error('browser network drifts from torch');
