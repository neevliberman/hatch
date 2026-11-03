// Checks the graphics-card Atlas (src/atlas/gpu.ts) against the plain one (src/atlas/net.ts) in Chromium, and times it.
//   node scripts/atlas-gpu-check.mjs
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';

const entry = `
import { AtlasNet } from './src/atlas/net.ts';
import { AtlasGpu } from './src/atlas/gpu.ts';
window.check = (meta, b64, cells) => {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
  const net = new AtlasNet(meta, raw);
  const gpu = AtlasGpu.create(net);
  if (!gpu) return { error: 'no WebGL2 float targets' };
  const P = net.placeDim;
  const places = new Float32Array(cells.length * P);
  cells.forEach((c, i) => net.placeFeatures(c, places, i * P));
  const ahead = new Float32Array(cells.length).map((_, i) => ((i * 7) % 41) - 20);
  const sp = [0, 4, 1945];
  const out = {};
  for (const [name, a] of [['typical', null], ['ahead', ahead]]) {
    gpu.run(places, 160, a, sp);
    const t0 = performance.now();
    const got = gpu.run(places, 160, a, sp);
    const ms = performance.now() - t0;
    let worst = 0;
    for (let i = 0; i < cells.length; i += 97) {
      const ref = net.logShares(cells[i], 160, a ? a[i] : 0);
      sp.forEach((s, k) => (worst = Math.max(worst, Math.abs(ref[s] - got[k][i]))));
    }
    out[name] = { ms, worst };
  }
  // all(): every species, one place over a season of days (the card's "Out here now"), against net.ts row by row.
  const n = 62;
  const season = new Float32Array(n * P);
  for (let j = 0; j < n; j++) season.set(places.subarray(0, P), j * P);
  const days = Float32Array.from({ length: n }, (_, j) => 60 + 4 * j);
  for (const [name, a] of [['all typical', null], ['all ahead', days.map((_, j) => (j % 9) - 4)]]) {
    const t0 = performance.now();
    const got = gpu.all(season, days, a);
    const ms = performance.now() - t0;
    let worst = 0;
    for (const j of [0, 25, 61]) {
      const ref = net.logShares(cells[0], days[j], a ? a[j] : 0);
      for (let s = 0; s < net.nOut; s++) if (ref[s] > -15) worst = Math.max(worst, Math.abs(ref[s] - got[j * net.nOut + s]));
    }
    out[name] = { ms, worst };
  }
  return out;
};`;
const js = buildSync({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife' }).outputFiles[0].text;
const meta = JSON.parse(readFileSync('public/atlas/model.json', 'utf8'));
const b64 = readFileSync('public/atlas/model.bin').toString('base64');
const cells = JSON.parse(readFileSync('public/atlas/cells.json', 'utf8'));
const { cellToLatLng } = await import('h3-js');
const places = cells.map((c) => { const [lat, lng] = cellToLatLng(c.h); return { lat, lng, dd: c.dd }; });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: js });
const res = await page.evaluate(([m, b, c]) => window.check(m, b, c), [meta, b64, places]);
await browser.close();
console.log(JSON.stringify(res));
if (res.error) process.exit(1);
for (const r of Object.values(res)) if (r.worst > 2e-3) throw new Error('graphics-card network drifts from net.ts');
