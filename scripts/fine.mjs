// Zoomed-in smoke test for the finer hexagons (res 5 and 6), which only load over http(s).
// Usage: node scripts/fine.mjs [outDir]   (after `npm run build`; serves dist/ on a local port)
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST_DIR (default dist).
// FAILS (exit 1) on any page or console error, a failed or non-local request, a level that never appears,
// a blank map, or a tap that shows no card.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots/fine';
mkdirSync(out, { recursive: true });
const root = resolve(process.env.DIST_DIR ?? 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = join(root, path);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!f.startsWith(root) || !existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const manifest = JSON.parse(readFileSync(join(root, 'fine/manifest.json'), 'utf8'));
const finest = Math.max(...Object.keys(manifest.levels).map(Number));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const problems = [];

const measure = async (b64) => {
  const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(Math.floor(bmp.width * 0.3), Math.floor(bmp.height * 0.3), Math.floor(bmp.width * 0.4), Math.floor(bmp.height * 0.25)).data;
  const counts = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return { distinct: counts.size, dominant: Math.max(...counts.values()) / (d.length / 4) };
};

// [label, query, lng, lat, zoom, expected res]: lake shores, a city and a river valley, then back out.
const cases = [
  // Dates sit where the season is turning there, so the local differences show as two colours.
  ['chicago-z7', '?year=2021&date=05-22&noauto', -87.9, 42.0, 7.0, 5],
  ['lake-mi-shore-z8.6', '?date=05-28&noauto', -86.05, 42.55, 8.6, 6],
  ['detroit-z9', '?year=2025&date=05-30&noauto', -83.2, 42.4, 9.0, 6],
  ['mississippi-z8.2', '?date=05-24&noauto', -91.2, 43.2, 8.2, 6],
  ['back-out-z5', '?noauto', -88.5, 42.5, 5.0, 4],
];
const shots = [
  ['desktop', 1440, 900, false],
  ['mobile', 390, 844, true],
];

for (const [name, width, height, mobile] of shots) {
  for (const [label, query, lng, lat, zoom, want] of cases) {
    const res = Math.min(want, finest);
    const tag = `${name} ${label}`;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
    const page = await ctx.newPage();
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && problems.push(`${tag}: external request ${r.url()}`));
    page.on('requestfailed', (r) => problems.push(`${tag}: request failed ${r.url()}`));
    page.on('response', (r) => r.status() >= 400 && problems.push(`${tag}: HTTP ${r.status()} ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`${tag}: console error: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${tag}: pageerror: ${e.message}`));
    await page.goto(`${origin}/${query}`);
    await page.waitForTimeout(1200);
    if (label === 'back-out-z5') {
      // Zoom in to the finest level first, then back out: the map must return to the big hexagons.
      await page.evaluate(() => window.__hatch.map.view([-87.9, 42.0], 9));
      await page.waitForFunction(() => window.__hatch.luna.res() > 4, null, { timeout: 8000 }).catch(() => problems.push(`${tag}: never zoomed in`));
    }
    await page.evaluate(([a, b, z]) => window.__hatch.map.view([a, b], z), [lng, lat, zoom]);
    const ok = await page.waitForFunction((r) => window.__hatch.luna.res() === r, res, { timeout: 8000 }).then(() => true, () => false);
    const got = await page.evaluate(() => window.__hatch.luna.res());
    if (!ok) problems.push(`${tag}: expected res ${res}, map shows res ${got}`);
    await page.waitForTimeout(800);
    const png = await page.screenshot({ path: `${out}/${name}-${label}.png` });
    const m = await page.evaluate(measure, png.toString('base64'));
    console.log(`${tag}: res ${got}, centre colours=${m.distinct}, dominant=${(m.dominant * 100).toFixed(0)}%`);
    // Zoomed in close, one hexagon can fill the middle of the screen, so only a single flat colour counts as blank there.
    if (got > 4 ? m.distinct < 2 : m.distinct < 4 || m.dominant > 0.97) problems.push(`${tag}: map looks blank: ${JSON.stringify(m)}`);
    // Tap the middle: the card must show, and say what a small hexagon is when one is on screen.
    if (mobile) await page.touchscreen.tap(width * 0.5, height * 0.45);
    else await page.mouse.click(width * 0.5, height * 0.45);
    await page.waitForTimeout(500);
    if (await page.locator('#probe').isHidden()) problems.push(`${tag}: tapping the map showed no card`);
    else {
      const text = await page.locator('#probe').textContent(); // all lines, even those a hover card hides
      if (got > 4 && !/Small hexagon/.test(text)) problems.push(`${tag}: card does not say it is a small hexagon: ${text}`);
      if (got === 4 && /Small hexagon/.test(text)) problems.push(`${tag}: res-4 card calls itself small`);
    }
    await page.screenshot({ path: `${out}/${name}-${label}-card.png` });
    await ctx.close();
  }
}
await browser.close();
server.close();
if (problems.length) {
  console.error('FINE FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('FINE OK');
