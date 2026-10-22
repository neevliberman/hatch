// Mobile smoke test: real phone sizes, touch, both orientations, Safari's engine (WebKit) and Chrome's (Chromium).
// Usage: node scripts/mobile.mjs [outDir]
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html),
//      ENGINES (comma list, default "chromium,webkit").
// FAILS (exit 1) on errors, a map squeezed out by the panels, controls that are covered or off-screen, or a broken
// tap flow (hex card, play, My area, Share, drawer).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots/mobile';
mkdirSync(out, { recursive: true });
const file = pathToFileURL(resolve(process.env.DIST ?? 'dist-single/index.html')).href;
const engines = (process.env.ENGINES ?? 'chromium,webkit').split(',');

// [name, engine, width, height, pixel ratio]; each runs portrait and landscape.
const phones = [
  ['iphone-se', 'webkit', 375, 667, 2],
  ['iphone-15', 'webkit', 393, 852, 3],
  ['pixel-7', 'chromium', 412, 915, 2.625],
  ['small-android', 'chromium', 360, 740, 3],
].filter((p) => engines.includes(p[1]));

const MIN_MAP = 0.3; // share of the screen height the map must keep between the top and bottom panels
const MIN_TARGET = 24; // px, WCAG 2.2 AA target size
const problems = [];
const browsers = {};
for (const e of new Set(phones.map((p) => p[1]))) {
  browsers[e] = await pw[e].launch(
    e === 'chromium'
      ? { executablePath: process.env.CHROMIUM || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
      : {},
  );
}

// Runs in the page: how much map is left, and which visible controls are off-screen, too small, or covered.
const audit = () => {
  const sub = document.querySelector('#top').getBoundingClientRect();
  const bottom = document.querySelector('#bottom').getBoundingClientRect();
  const bad = [];
  for (const el of document.querySelectorAll('#top button, #top select, #bottom button, #bottom input, #bottom a')) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height || el.closest('[hidden]')) continue;
    const name = el.id || el.textContent.trim().slice(0, 24);
    if (b.left < -1 || b.right > innerWidth + 1 || b.top < -1 || b.bottom > innerHeight + 1) bad.push(`${name} is off-screen`);
    else if (Math.min(b.width, b.height) < 24) bad.push(`${name} is only ${Math.round(b.width)}x${Math.round(b.height)}px`);
    else {
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (hit && !el.contains(hit)) bad.push(`${name} is covered by ${hit.id || hit.className || hit.tagName}`);
    }
  }
  return {
    map: (bottom.top - sub.bottom) / innerHeight,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    selectFont: parseFloat(getComputedStyle(document.querySelector('#season')).fontSize),
    bad,
  };
};

const blank = async (page) => {
  const png = await page.screenshot();
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const sub = document.querySelector('#top').getBoundingClientRect().bottom * devicePixelRatio;
    const bot = document.querySelector('#bottom').getBoundingClientRect().top * devicePixelRatio;
    const d = g.getImageData(0, Math.floor(sub), bmp.width, Math.max(1, Math.floor(bot - sub))).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 16) seen.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4));
    return seen.size < 6;
  }, png.toString('base64'));
};

for (const [phone, engine, pw0, ph0, dpr] of phones) {
  for (const orient of ['portrait', 'landscape']) {
    const [width, height] = orient === 'portrait' ? [pw0, ph0] : [ph0, pw0];
    const tag = `${phone} ${orient}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await browsers[engine].newContext({
      viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true,
      geolocation: { latitude: 41.88, longitude: -87.63 }, permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && fail(`external request ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const shot = (step) => page.screenshot({ path: `${out}/${phone}-${orient}-${step}.png` });
    const tap = async (sel) => {
      try {
        await page.locator(sel).tap({ timeout: 3000 });
        return true;
      } catch {
        fail(`could not tap ${sel}`);
        return false;
      }
    };

    // First visit: the map comes first (the About button just glows); the i button opens the drawer, and a tap
    // outside it must close it.
    await page.goto(file);
    await page.waitForTimeout(2500);
    await shot('1-first-visit');
    if (await page.locator('#drawer.open').count()) fail('the drawer covers the map on first visit');
    if (!(await page.locator('#info-btn.hint').count())) fail('the About button does not stand out on first visit');
    await tap('#info-btn');
    await page.waitForTimeout(400);
    if (!(await page.locator('#drawer.open').count())) fail('the i button did not open the drawer');
    // Tap empty map: left of a side drawer, or between the top panels and a bottom sheet.
    const box = await page.locator('#drawer').boundingBox();
    const top = await page.evaluate(() => document.querySelector('#top').getBoundingClientRect().bottom);
    const bottom = box.x > 40 ? (await page.locator('#bottom').boundingBox()).y : box.y;
    await page.touchscreen.tap(box.x > 40 ? box.x / 2 : width / 2, (top + bottom) / 2);
    await page.waitForTimeout(400);
    if (await page.locator('#drawer.open').count()) fail('tapping outside the drawer did not close it');
    if (await page.locator('#probe').isVisible()) fail('the tap that closed the drawer also opened a card');

    const a = await page.evaluate(audit);
    await shot('2-map');
    if (a.map < MIN_MAP) fail(`panels leave only ${Math.round(a.map * 100)}% of the screen for the map (need ${MIN_MAP * 100}%)`);
    if (a.overflowX) fail('page scrolls sideways');
    if (engine === 'webkit' && a.selectFont < 16) fail(`season menu font ${a.selectFont}px: iOS zooms the page when it opens`);
    a.bad.forEach(fail);
    if (await blank(page)) fail('map looks blank');

    // Tap the middle of the map: a card must appear, and the actions must stay reachable.
    const sub = await page.locator('#top').boundingBox();
    const bot = await page.locator('#bottom').boundingBox();
    await page.touchscreen.tap(width / 2, (sub.y + sub.height + bot.y) / 2);
    await page.waitForTimeout(500);
    await shot('3-card');
    if (await page.locator('#probe').isHidden()) fail('tapping the map showed no card');
    const b = await page.evaluate(audit);
    if (b.map < MIN_MAP * 0.75) fail(`with a card open the map keeps only ${Math.round(b.map * 100)}% of the screen`);
    b.bad.forEach((m) => fail(`with a card open, ${m}`));

    const d0 = await page.locator('#t-date').textContent();
    if (await tap('#t-play')) {
      await page.waitForTimeout(1200);
      await tap('#t-play');
      if ((await page.locator('#t-date').textContent()) === d0) fail('play did not move the date');
    }

    if (await tap('#locate')) {
      await page.waitForTimeout(1000);
      if (await page.locator('#probe').isHidden()) fail('"My area" showed no card');
      await shot('4-my-area');
    }

    await page.evaluate(() => {
      window.__shared = null;
      const grab = async (d) => void (window.__shared = typeof d === 'string' ? d : d.url);
      if (navigator.share) navigator.share = grab;
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: grab } });
    });
    if (await tap('#share')) {
      await page.waitForTimeout(300);
      const url = await page.evaluate(() => window.__shared);
      if (!/[?&]date=\d{2}-\d{2}/.test(url ?? '')) fail(`share produced no view link: ${url}`);
    }

    // Pinch the map open (Chromium only: it alone takes raw multi-touch here): the recenter button must appear and work.
    if (engine === 'chromium') {
      if (await page.locator('#recenter').isVisible()) fail('recenter button shows before the map was moved');
      const zoom = () => page.evaluate(() => window.__hatch.map.zoom());
      const z0 = await zoom();
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
      const [cx, cy] = [width / 2, (sub.y + sub.height + bot.y) / 2];
      await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
      for (let i = 1; i <= 10; i++) {
        await touch('touchMove', [[cx - 30 - i * 8, cy], [cx + 30 + i * 8, cy]]);
        await page.waitForTimeout(16);
      }
      await touch('touchEnd', []);
      await page.waitForTimeout(500);
      if (await page.locator('#recenter').isHidden()) fail('pinching the map did not show the recenter button');
      else {
        await shot('5-zoomed');
        (await page.evaluate(audit)).bad.forEach((m) => fail(`zoomed in, ${m}`));
        await tap('#recenter');
        await page.waitForTimeout(400);
        const z1 = await zoom();
        // The refit can land a little further out than the first view (an open card leaves less room), never further in.
        if (await page.locator('#recenter').isVisible() || z1 > z0 + 0.05) fail(`recenter did not bring back the whole Midwest (zoom ${z0} -> ${z1})`);
      }
    }

    if (await tap('#info-btn')) {
      await page.waitForTimeout(400);
      if (!(await page.locator('#drawer.open').count())) fail('the i button did not open the drawer');
      await shot('6-drawer');
      await tap('#drawer-close');
    }
    await ctx.close();
    console.log(`${tag}: map ${Math.round(a.map * 100)}% (with card ${Math.round(b.map * 100)}%)`);
  }
}
for (const b of Object.values(browsers)) await b.close();
if (problems.length) {
  console.error('MOBILE FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('MOBILE OK');
