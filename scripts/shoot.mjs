// Visual check: node scripts/shoot.mjs [outDir]
// Needs `playwright` resolvable (global/NODE_PATH) and a Chromium (set CHROMIUM=/path if not default).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots';
const file = pathToFileURL(resolve('dist-single/index.html')).href;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const external = [];
const shots = [
  ['desktop', 1440, 900, false],
  ['mobile', 390, 844, true],
];
for (const [name, width, height, mobile] of shots) {
  for (const date of ['2026-04-20', '2026-07-05']) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
    const page = await ctx.newPage();
    page.on('request', (r) => !r.url().startsWith('file:') && !r.url().startsWith('data:') && external.push(r.url()));
    page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`[${name} ${m.type()}]`, m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${file}?date=${date}`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/m0-${name}-${date}.png` });
    if (date === '2026-07-05') {
      await page.mouse.move(width * 0.5, height * 0.42);
      if (mobile) await page.touchscreen.tap(width * 0.5, height * 0.42);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/m0-${name}-${date}-probe.png` });
      await page.click('#info-btn');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/m0-${name}-caveats.png` });
    }
    await ctx.close();
  }
}
await browser.close();
console.log('external requests:', external.length ? external : 'none');
