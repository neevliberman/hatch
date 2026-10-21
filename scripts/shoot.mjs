// Visual smoke test. Usage: node scripts/shoot.mjs [outDir] [prefix]
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html).
// FAILS (exit 1) on any pageerror, console error, external request, or a map whose centre is (nearly) one colour.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots';
const prefix = process.argv[3] ?? 'p0';
const file = pathToFileURL(resolve(process.env.DIST ?? 'dist-single/index.html')).href;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const problems = [];
const shots = [
  ['desktop', 1440, 900, false],
  ['mobile', 390, 844, true],
];

// Runs in the page: decode the PNG and measure how varied the middle of the map is.
const measure = async (b64) => {
  const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const x0 = Math.floor(bmp.width * 0.3), y0 = Math.floor(bmp.height * 0.3);
  const w = Math.floor(bmp.width * 0.4), h = Math.floor(bmp.height * 0.25);
  const d = g.getImageData(x0, y0, w, h).data;
  const counts = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = d.length / 4;
  return { distinct: counts.size, dominant: Math.max(...counts.values()) / total };
};

for (const [name, width, height, mobile] of shots) {
  for (const date of ['2026-04-20', '2026-07-05']) {
    const tag = `${name} ${date}`;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
    const page = await ctx.newPage();
    page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && problems.push(`${tag}: external request ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`${tag}: console error: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${tag}: pageerror: ${e.message}`));
    await page.goto(`${file}?date=${date}`);
    await page.waitForTimeout(2500);
    const png = await page.screenshot({ path: `${out}/${prefix}-${name}-${date}.png` });
    const m = await page.evaluate(measure, png.toString('base64'));
    console.log(`${tag}: centre colours=${m.distinct}, dominant=${(m.dominant * 100).toFixed(0)}%`);
    if (m.distinct < 4 || m.dominant > 0.97) problems.push(`${tag}: map looks blank (single colour): ${JSON.stringify(m)}`);
    if (date === '2026-07-05') {
      await page.mouse.move(width * 0.5, height * 0.42);
      if (mobile) await page.touchscreen.tap(width * 0.5, height * 0.42);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${prefix}-${name}-${date}-probe.png` });
      await page.click('#info-btn');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${prefix}-${name}-caveats.png` });
    }
    await ctx.close();
  }
}
await browser.close();
if (problems.length) {
  console.error('SHOOT FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('SHOOT OK');
