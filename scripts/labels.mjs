// Place-name smoke test: the first view on a 375 px phone must not be empty of names.
// Usage: node scripts/labels.mjs   (after `npm run build`; serves dist/ on a local port)
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST_DIR (default dist).
// FAILS (exit 1) unless Chicago, Lake Michigan and at least three state names (or codes) show on the first load.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const root = resolve(process.env.DIST_DIR ?? 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = join(root, path);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!f.startsWith(root) || !existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?noauto`);
const names = () => page.evaluate(() => [...document.querySelectorAll('.place')].filter((n) => n.style.display !== 'none').map((n) => n.textContent));
await page.waitForFunction(() => [...document.querySelectorAll('.place')].some((n) => n.style.display !== 'none'), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
const shown = await names();
await browser.close();
server.close();
const states = shown.filter((t) => /^[A-Z]{2,}$/.test(t ?? '')).length;
const problems = [];
for (const want of ['Chicago', 'Lake Michigan']) if (!shown.includes(want)) problems.push(`"${want}" is not on the 375 px first load`);
if (states < 3) problems.push(`only ${states} state names on the 375 px first load`);
console.log('first load names:', shown.join(', '));
if (problems.length) {
  console.error(problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
