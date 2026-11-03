// Pan/zoom frame-time probe. Usage: node scripts/perf-pan.mjs [dist-dir]  (serves dist over http, drives Chromium)
// Drags the map for ~2 s, then a wheel zoom, and prints frame-gap percentiles + long tasks. Software GL is slower
// than a real GPU, so read the numbers as before/after, not as absolute.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const dir = resolve(process.argv[2] ?? 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = createServer((q, r) => {
  let p = join(dir, decodeURIComponent(q.url.split('?')[0]));
  if (existsSync(p) && !p.includes('.') ) p = join(p, 'index.html');
  if (!existsSync(p) || p.endsWith('/')) p = join(dir, 'index.html');
  r.setHeader('content-type', types[extname(p)] ?? 'application/octet-stream');
  r.end(readFileSync(p));
}).listen(0);
const port = srv.address().port;
const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W ?? 1366), height: +(process.env.H ?? 768) } });
await page.goto(`http://localhost:${port}/?z=7`);
await page.waitForFunction(() => window.__hatch?.map?.zoom?.() != null && !document.getElementById('loader'), null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  window.__f = []; window.__lt = [];
  let last = performance.now();
  const tick = (t) => { window.__f.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ entryTypes: ['longtask'] });
});
const stats = async (label) => {
  const { f, lt } = await page.evaluate(() => ({ f: window.__f.slice(), lt: window.__lt.slice() }));
  const s = [...f].sort((a, b) => a - b);
  const q = (x) => s[Math.min(s.length - 1, Math.floor(s.length * x))]?.toFixed(1);
  console.log(`${label}: frames=${f.length} p50=${q(0.5)}ms p95=${q(0.95)}ms p99=${q(0.99)}ms max=${q(1)}ms fps~${(1000 / (f.reduce((a, b) => a + b, 0) / f.length)).toFixed(1)} longtasks=${lt.length} (sum ${lt.reduce((a, b) => a + b, 0).toFixed(0)}ms)`);
  await page.evaluate(() => { window.__f = []; window.__lt = []; });
};
await page.evaluate(() => window.__hatch.map.view([-89, 43], 7)); await page.waitForTimeout(2500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start');
const cx = +(process.env.W ?? 1366) / 2, cy = +(process.env.H ?? 768) / 2;
await page.mouse.move(cx, cy); await page.mouse.down();
for (let i = 0; i < +(process.env.N ?? 90); i++) { await page.mouse.move(cx + Math.sin(i / 10) * 200, cy + i * 1.5, { steps: 1 }); await page.waitForTimeout(16); }
await stats('drag (held)');
{ const { profile } = await cdp.send('Profiler.stop'); const self = new Map(); const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = profile.timeDeltas; profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i] / 1000); });
  console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${v.toFixed(0)}ms ${k}`).join('\n')); }
// fast flick then release, watch coast
const z0 = await page.evaluate(() => window.__hatch.map.project([-89, 43]));
for (let i = 0; i < 8; i++) { await page.mouse.move(cx + i * 40, cy, { steps: 1 }); await page.waitForTimeout(16); }
await page.mouse.up();
await page.waitForTimeout(100);
const a = await page.evaluate(() => window.__hatch.map.project([-89, 43]));
await page.waitForTimeout(800);
const b = await page.evaluate(() => window.__hatch.map.project([-89, 43]));
console.log(`after release: moved ${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(1)}px in the next 0.8 s (0 = no momentum)`);
await page.evaluate(() => { window.__f = []; window.__lt = []; });
for (let i = 0; i < 25; i++) { await page.mouse.wheel(0, -60); await page.waitForTimeout(32); }
await page.waitForTimeout(400);
await stats('wheel zoom');
await browser.close(); srv.close();
