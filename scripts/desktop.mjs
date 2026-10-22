// Desktop smoke test: laptop to 1440p screens and a narrow window, in Chrome's (Chromium), Firefox's (Gecko) and Safari's
// (WebKit) engines, driven with a mouse and a keyboard.
// Usage: node scripts/desktop.mjs [outDir]   (Firefox needs a display for WebGL: run under xvfb-run on Linux)
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html),
//      ENGINES (comma list, default "chromium,firefox,webkit").
// FAILS (exit 1) on errors, a blank or shrunken Midwest, controls that are covered or off-screen, a broken mouse flow
// (hover card, click to pin, wheel zoom, "why?", drawer) or a broken keyboard flow (Tab order, focus rings, arrows, Space).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots/desktop';
mkdirSync(out, { recursive: true });
const file = pathToFileURL(resolve(process.env.DIST ?? 'dist-single/index.html')).href;
const engines = (process.env.ENGINES ?? 'chromium,firefox,webkit').split(',');

// [engine, width, height]: common laptop and monitor sizes, plus a narrow window that still gets the desktop layout.
const screens = [
  ['chromium', 1280, 720],
  ['chromium', 1920, 1080],
  ['chromium', 2560, 1440],
  ['chromium', 900, 700],
  ['firefox', 1366, 768],
  ['webkit', 1440, 900],
].filter((s) => engines.includes(s[0]));

// The seven states must fill this share of the screen's height, or (on a tall, narrow window, where width binds) of its
// width once scaled by WIDE, the share of the width the states fill when width is what limits the fit.
const MIN_MIDWEST = 0.45;
const WIDE = 0.9;
// Every one of these must be reachable with Tab, in this order, and show a focus ring.
const TAB_ORDER = ['season', 'info-btn', 'why', 'locate', 'share', 't-prev', 't-play', 't-next', 't-range'];
const problems = [];
const browsers = {};
for (const e of new Set(screens.map((s) => s[0]))) {
  browsers[e] = await pw[e].launch(
    e === 'chromium'
      ? { executablePath: process.env.CHROMIUM || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
      : e === 'firefox'
        ? { headless: false, firefoxUserPrefs: { 'webgl.force-enabled': true } } // headless Firefox gets no WebGL; xvfb gives it a display
        : {},
  );
}

// Runs in the page: visible controls that are off-screen, too small, or covered.
const audit = () => {
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
  return { bad, scrolls: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
};

// Bounding box of the coloured hexes in a screenshot, as a share of the screen, plus how many colours the map shows.
// Hex fills are saturated teals, blues and purples; the background, outlines and panel text are grey.
const midwest = (page, png) =>
  page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const seen = new Set();
    for (let y = 0; y < bmp.height; y += 4)
      for (let x = 0; x < bmp.width; x += 4) {
        const i = (y * bmp.width + x) * 4;
        const [r, gr, b] = [d[i], d[i + 1], d[i + 2]];
        seen.add((r >> 4) << 8 | (gr >> 4) << 4 | (b >> 4));
        if (Math.max(r, gr, b) - Math.min(r, gr, b) < 50 || Math.max(r, gr, b) < 60) continue; // skips the pale state outlines too
        // Only pixels drawn by the map, not the panels over it.
        const el = document.elementFromPoint(x / devicePixelRatio, y / devicePixelRatio);
        if (el?.tagName !== 'CANVAS') continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    return { w: Math.max(0, x1 - x0) / bmp.width, h: Math.max(0, y1 - y0) / bmp.height, colours: seen.size };
  }, png.toString('base64'));

const drawerOpen = (page) => page.locator('#drawer.open').count().then((n) => n > 0);

for (const [engine, width, height] of screens) {
  const tag = `${engine} ${width}x${height}`;
  const name = `${engine}-${width}x${height}`;
  const fail = (m) => problems.push(`${tag}: ${m}`);
  const ctx = await browsers[engine].newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && fail(`external request ${r.url()}`));
  page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
  page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
  const shot = (step) => page.screenshot({ path: `${out}/${name}-${step}.png` });
  // A step that throws (a click on a covered control waits, then gives up) fails this screen, not the whole run.
  try {

  // First visit: the About drawer opens by itself; Escape closes it.
  await page.goto(file);
  await page.waitForTimeout(2500);
  await shot('1-first-visit');
  if (!(await drawerOpen(page))) fail('drawer did not open on first visit');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  if (await drawerOpen(page)) fail('Escape did not close the drawer');

  // The map: drawn, big, nothing covered, no page scroll.
  await page.mouse.move(2, height / 2); // park the pointer on the edge so no hover card is open
  await page.waitForTimeout(300);
  const png = await shot('2-map');
  const m = await midwest(page, png);
  if (m.colours < 6) fail('map looks blank');
  else if (Math.max(m.w / WIDE, m.h) < MIN_MIDWEST)
    fail(`the Midwest is drawn only ${Math.round(m.w * 100)}% wide x ${Math.round(m.h * 100)}% tall (need ${MIN_MIDWEST * 100}% of the height or ${Math.round(MIN_MIDWEST * WIDE * 100)}% of the width)`);
  const a = await page.evaluate(audit);
  a.bad.forEach(fail);
  if (a.scrolls) fail('page scrolls');

  // Hover a hex: a card appears and does not sit under the pointer. Hex centre = middle of the coloured box.
  let spot = null;
  for (const [fx, fy] of [[0.5, 0.45], [0.45, 0.4], [0.55, 0.5], [0.4, 0.35], [0.6, 0.55]]) {
    const p = [Math.round(width * fx), Math.round(height * fy)];
    await page.mouse.move(...p, { steps: 4 });
    await page.waitForTimeout(350);
    if (await page.locator('#probe').isVisible()) {
      spot = p;
      break;
    }
  }
  if (!spot) fail(`hovering the map showed no card (tried 5 spots near the middle)`);
  else {
    await shot('3-hover');
    const covers = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('#probe') !== null, spot);
    if (covers) fail('the hover card sits under the pointer');
    // Click pins it: it stays after the pointer leaves; clicking the same spot again lets it go.
    // deck holds a single click back for the double-click window, so wait for the result rather than a fixed time.
    await page.mouse.click(...spot);
    await page.waitForTimeout(600);
    await page.mouse.move(2, height / 2, { steps: 4 });
    await page.waitForTimeout(350);
    if (await page.locator('#probe').isHidden()) fail('clicking the map did not pin the card');
    await page.mouse.click(...spot);
    await page.mouse.move(2, height / 2, { steps: 4 });
    await page.locator('#probe').waitFor({ state: 'hidden', timeout: 2000 })
      .catch(() => fail('clicking the pinned spot again did not let the card go'));
  }

  // Wheel over the map zooms it; the page itself never scrolls.
  const zoom = () => page.evaluate(() => window.__hatch.map.zoom());
  const z0 = await zoom();
  await page.mouse.move(...(spot ?? [width / 2, height / 2]));
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(800);
  await page.mouse.move(2, height / 2);
  await page.waitForTimeout(300);
  await shot('4-zoomed');
  if (!((await zoom()) > z0)) fail('mouse wheel over the map did not zoom it');
  if (await page.evaluate(() => scrollX || scrollY)) fail('the wheel scrolled the page');

  // "why?" opens the drawer, and still visibly lands when the drawer is already open.
  if (await page.locator('#why').isVisible()) {
    await page.locator('#why').click();
    await page.waitForTimeout(600);
    if (!(await drawerOpen(page))) fail('"why?" did not open the drawer');
    await shot('5-why');
    await page.locator('#drawer').evaluate((d) => d.scrollTo(0, d.scrollHeight));
    const y0 = await page.locator('#drawer').evaluate((d) => d.scrollTop);
    const whyReachable = await page.evaluate(() => {
      const b = document.getElementById('why').getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.id === 'why';
    });
    if (!whyReachable) fail('"why?" is covered by the open drawer');
    else {
      await page.locator('#why').click();
      await page.waitForTimeout(800);
      // Something must visibly answer: the drawer scrolls, or a highlighted section shows in view.
      const answered = await page.locator('#drawer').evaluate((d, y) => {
        const v = d.getBoundingClientRect();
        const lit = [...d.querySelectorAll('.flash')].some((el) => {
          const b = el.getBoundingClientRect();
          return b.bottom > v.top && b.top < v.bottom;
        });
        return lit || d.scrollTop !== y;
      }, y0);
      if (!answered) fail('"why?" does nothing visible when the drawer is already open');
    }
    // Wheel over the drawer scrolls the drawer, not the map.
    const box = await page.locator('#drawer').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('#drawer').evaluate((d) => d.scrollTo(0, 0));
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(400);
    const scrollable = await page.locator('#drawer').evaluate((d) => d.scrollHeight > d.clientHeight);
    if (scrollable && !(await page.locator('#drawer').evaluate((d) => d.scrollTop))) fail('the wheel did not scroll the drawer');
    await page.locator('#drawer-close').click();
    await page.waitForTimeout(400);
    if (await drawerOpen(page)) fail('the close button did not close the drawer');
  } else fail('"why?" is not visible');

  // Keyboard, from a fresh load: Tab walks the controls in reading order, each with a visible focus ring.
  await page.goto(file + '?noauto');
  await page.waitForTimeout(1500);
  const order = [];
  for (let i = 0; i < TAB_ORDER.length + 3 && order.length < TAB_ORDER.length; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { id: el.id || el.tagName.toLowerCase(), ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' };
    });
    if (!f) continue;
    if (!TAB_ORDER.includes(f.id)) {
      fail(`Tab stops on ${f.id}, which is not a control`);
      continue;
    }
    order.push(f.id);
    if (!f.ring) fail(`${f.id} shows no focus ring`);
  }
  if (order.join() !== TAB_ORDER.join()) fail(`Tab order is ${order.join(' > ')} (want ${TAB_ORDER.join(' > ')})`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur());
  const d0 = await page.locator('#t-date').textContent();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  if ((await page.locator('#t-date').textContent()) === d0) fail('Right arrow did not step the date');
  const d1 = await page.locator('#t-date').textContent();
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  if ((await page.locator('#t-date').textContent()) === d1) fail('Space did not play');

  // Resize the window: the map refits to what a fresh load at the new size would show.
  await page.setViewportSize({ width: Math.round(width * 0.75), height: Math.round(height * 0.85) });
  await page.waitForTimeout(800);
  await page.mouse.move(2, 200);
  const r = await midwest(page, await shot('6-resized'));
  await page.reload();
  await page.waitForTimeout(1500);
  await page.mouse.move(2, 200);
  const f = await midwest(page, await page.screenshot());
  if (Math.abs(r.h - f.h) > 0.08 || Math.abs(r.w - f.w) > 0.08)
    fail(`after a resize the Midwest is ${Math.round(r.w * 100)}% x ${Math.round(r.h * 100)}%, a fresh load shows ${Math.round(f.w * 100)}% x ${Math.round(f.h * 100)}%`);

  console.log(`${tag}: Midwest ${Math.round(m.w * 100)}% x ${Math.round(m.h * 100)}% of the screen`);
  } catch (e) {
    fail(`stopped: ${e.message.split('\n')[0]}`);
  }
  await ctx.close();
}

// No WebGL (old GPU driver, hardware acceleration off): the page must say so, not show an empty map.
if (engines.includes('chromium')) {
  const b = await pw.chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--disable-webgl', '--disable-webgl2'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(file + '?noauto');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/chromium-no-webgl.png` });
  if (!(await page.locator('#no-webgl').isVisible())) problems.push('no WebGL: the map is blank with no message');
  await b.close();
}

for (const b of Object.values(browsers)) await b.close();
if (problems.length) {
  console.error('DESKTOP FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('DESKTOP OK');
