// Visual smoke test. Usage: node scripts/shoot.mjs [outDir] [prefix]
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html).
// FAILS (exit 1) on any pageerror, console error, external request, or a map whose centre is (nearly) one colour.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots';
const prefix = process.argv[3] ?? 'p2';
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

// Each case: [tag, query]. ?noauto stops the once-per-browser drawer from covering the map.
const cases = [
  ['default', '?noauto'], // all years pooled, mid-June
  ['2025-0610', '?year=2025&date=06-10&noauto'],
  ['typical-0601', '?year=typical&date=06-01&noauto'], // unknown ?year falls back to pooled
  ['2021-0520', '?year=2021&date=05-20&noauto'],
  ['offseason', '?today=2027-01-15'], // drawer auto-opens on a first visit; countdown visible
];

for (const [name, width, height, mobile] of shots) {
  for (const [label, query] of cases) {
    const tag = `${name} ${label}`;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
    const page = await ctx.newPage();
    page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && problems.push(`${tag}: external request ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`${tag}: console error: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${tag}: pageerror: ${e.message}`));
    await page.goto(`${file}${query}`);
    await page.waitForTimeout(2500);
    const png = await page.screenshot({ path: `${out}/${prefix}-${name}-${label}.png` });
    if (label === 'offseason') {
      if (!(await page.locator('#drawer.open').count())) problems.push(`${tag}: drawer did not auto-open on first visit`);
      const cd = await page.locator('#countdown').textContent();
      if (!/Lunas due in ~\d+ days/.test(cd ?? '')) problems.push(`${tag}: no off-season countdown: ${cd}`);
      await ctx.close();
      continue;
    }
    const m = await page.evaluate(measure, png.toString('base64'));
    console.log(`${tag}: centre colours=${m.distinct}, dominant=${(m.dominant * 100).toFixed(0)}%`);
    if (m.distinct < 4 || m.dominant > 0.97) problems.push(`${tag}: map looks blank (single colour): ${JSON.stringify(m)}`);
    if (label === 'default') {
      if (mobile) await page.touchscreen.tap(width * 0.5, height * 0.5);
      else await page.mouse.click(width * 0.5, height * 0.5);
      await page.waitForTimeout(500);
      if (await page.locator('#probe').isHidden()) problems.push(`${tag}: tapping the map showed no probe card`);
      await page.screenshot({ path: `${out}/${prefix}-${name}-${label}-probe.png` });
      await page.click('#info-btn');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${prefix}-${name}-drawer.png` });
    }
    await ctx.close();
  }
  // "My area" with a faked location fix in Chicago: the pinned forecast card must appear.
  {
    const tag = `${name} locate`;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile,
      geolocation: { latitude: 41.88, longitude: -87.63 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${tag}: pageerror: ${e.message}`));
    await page.goto(`${file}?noauto`);
    await page.waitForTimeout(1500);
    await page.click('#locate');
    await page.waitForTimeout(800);
    if (await page.locator('#probe').isHidden()) problems.push(`${tag}: "My area" showed no forecast card`);
    await page.screenshot({ path: `${out}/${prefix}-${name}-locate.png` });
    await ctx.close();
  }
}
await browser.close();
if (problems.length) {
  console.error('SHOOT FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('SHOOT OK');
