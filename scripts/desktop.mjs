// Desktop smoke test: laptop to 1440p screens and a narrow window, in Chrome's (Chromium), Firefox's (Gecko) and Safari's
// (WebKit) engines, driven with a mouse and a keyboard.
// Usage: node scripts/desktop.mjs [outDir]   (Firefox needs a display for WebGL: run under xvfb-run on Linux)
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html),
//      ENGINES (comma list, default "chromium,firefox,webkit"), SHARD ("2/3" = the 2nd of 3 equal slices of the sections;
//      unset = all of them, which is what CI's other legs and a local run do).
// FAILS (exit 1) on errors, a blank or shrunken Midwest, controls that are covered or off-screen, a broken mouse flow
// (hover card, click to pin, wheel zoom, "why?", drawer) or a broken keyboard flow (Tab order, focus rings, arrows, Space).
// Then live mode ("This year", public/live/latest.json), which only loads over http: serves dist/ (DIST_DIR) on a local
// port in Chromium, desktop and phone, and fails if the season menu lacks it, picking it errors, the hex card has no
// "Peak likely", hexes go finer when zoomed, the default or stale rules break, or a missing file does anything visible.
// Also over http: the radar replays (load nothing until opened from About, then play at La Crosse or on Lake Erie and
// close cleanly).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { extname, join, normalize, resolve } from 'node:path';
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
const TAB_ORDER = ['season', 'theme-btn', 'info-btn', 'explore', 'why', 't-prev', 't-play', 't-next', 't-range', 'locate', 'find', 'share'];
const chromiumLaunch = { executablePath: process.env.CHROMIUM || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const problems = [];
const browsers = {};
// Independent sections, run by a small pool (two at a time on Chromium-only runs, where a section spends much of its time
// waiting on software-GL frames and a second keeps the cores busy; one at a time otherwise). Each section has its own context and its own `fail`.
const units = [];
// Each worker drives its own browser process: contexts of one browser share its single software-GL process, and two
// pages drawing through it starve each other into load timeouts.
const [shardNo, shardOf] = (process.env.SHARD ?? '1/1').split('/').map(Number);
const runUnits = async (n) => {
  const queue = units.filter((_, i) => i % shardOf === shardNo - 1);
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    const own = i === 0 ? null : await pw.chromium.launch(chromiumLaunch);
    for (let u; (u = queue.shift()); ) await u(own ?? browsers.chromium);
    await own?.close();
  }));
};
for (const e of new Set(screens.map((s) => s[0]))) {
  browsers[e] = await pw[e].launch(
    e === 'chromium'
      ? chromiumLaunch
      : e === 'firefox'
        ? { headless: false, firefoxUserPrefs: { 'webgl.force-enabled': true } } // headless Firefox gets no WebGL; xvfb gives it a display
        : {},
  );
}

// Runs in the page: visible controls that are off-screen, too small, or covered.
const audit = () => {
  const bad = [];
  for (const el of document.querySelectorAll('#top button:not(#explore), #top select, #bottom button, #bottom input, #bottom a')) {
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

const screenUnit = async ([engine, width, height], browser = browsers[engine]) => {
  const tag = `${engine} ${width}x${height}`;
  const name = `${engine}-${width}x${height}`;
  const fail = (m) => problems.push(`${tag}: ${m}`);
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && fail(`external request ${r.url()}`));
  page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
  page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
  const shot = (step) => page.screenshot({ path: `${out}/${name}-${step}.png` });
  // A step that throws (a click on a covered control waits, then gives up) fails this screen, not the whole run.
  try {

  // First visit: the season plays itself up to 10 June, the map comes first and the About button glows; i opens the
  // drawer (and any click lands the opening on 10 June) and Escape closes it.
  await page.goto(file);
  const opened = page.waitForFunction(() => /^(Apr|May)/.test(document.getElementById('t-date')?.textContent ?? ''), null, { timeout: 8000 })
    .then(() => true, () => false);
  await page.waitForTimeout(2500);
  await shot('1-first-visit');
  if (!(await opened)) fail('the season did not play itself on first visit');
  // Opened from disk there is nothing to fetch, so no live option (and no request: the external-request check above).
  if (await page.locator('#season option[value=live]').count()) fail('the one-file build offers live mode');
  if (await drawerOpen(page)) fail('the drawer covers the map on first visit');
  if (!(await page.locator('#info-btn.hint').count())) fail('the About button does not stand out on first visit');
  await page.locator('#info-btn').click();
  await page.waitForTimeout(400);
  if (!(await drawerOpen(page))) fail('the i button did not open the drawer');
  if (!/^Jun 10\b/.test((await page.textContent('#t-date')) ?? '') || (await page.getAttribute('#t-play', 'aria-label'))?.startsWith('Pause'))
    fail(`a click did not land the opening on Jun 10 (shows ${await page.textContent('#t-date')})`);
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
    await page.mouse.click(...spot);
    await page.waitForTimeout(600);
    await page.mouse.move(2, height / 2, { steps: 4 });
    await page.waitForTimeout(350);
    if (await page.locator('#probe').isHidden()) fail('clicking the map did not pin the card');
    await page.mouse.click(...spot);
    await page.mouse.move(2, height / 2, { steps: 4 });
    await page.locator('#probe').waitFor({ state: 'hidden', timeout: 5000 })
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
    // Waits for the scroll to land (a slow software-GL frame can take well over 400 ms) instead of a fixed sleep.
    const scrollable = await page.locator('#drawer').evaluate((d) => d.scrollHeight > d.clientHeight);
    if (scrollable && !(await page.waitForFunction(() => document.getElementById('drawer').scrollTop > 0, null, { timeout: 4000, polling: 100 }).then(() => true, () => false)))
      fail('the wheel did not scroll the drawer');
    await page.locator('#drawer-close').click();
    await page.waitForTimeout(400);
    if (await drawerOpen(page)) fail('the close button did not close the drawer');
  } else fail('"why?" is not visible');

  // Keyboard, from a fresh load: Tab walks the controls in reading order, each with a visible focus ring.
  await page.goto(file + '?noauto');
  await page.waitForTimeout(1500);
  const order = [];
  // Under 1000px the colour key can fold, so its fold button (or, folded, its "Key" chip) comes right after "Explore map with keys".
  const key = (await page.locator('#key-fold').isVisible()) ? 'key-fold' : (await page.locator('#key-chip').isVisible()) ? 'key-chip' : null;
  // Find a town needs the map's town names, so the one-file build leaves it out.
  const tabs = (await page.locator('#find').isVisible()) ? TAB_ORDER : TAB_ORDER.filter((id) => id !== 'find');
  const want = key ? [...tabs.slice(0, 4), key, ...tabs.slice(4)] : tabs;
  for (let i = 0; i < want.length + 3 && order.length < want.length; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      // The slider draws its ring on the thumb (a rectangle round the whole ribbon would be too loud). Chromium does
      // not report a thumb's computed style, so check it is focus-visible and a stylesheet rings its thumb.
      const cs = getComputedStyle(el);
      const thumbRing = () =>
        [...document.styleSheets].some((sh) => [...sh.cssRules].some((r) =>
          r instanceof CSSStyleRule && r.selectorText.includes(':focus-visible::-webkit-slider-thumb') && r.style.boxShadow !== ''));
      const ring = el.type === 'range'
        ? el.matches(':focus-visible') && thumbRing()
        : (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      return { id: el.id || el.tagName.toLowerCase(), ring };
    });
    if (!f) continue;
    if (!want.includes(f.id)) {
      fail(`Tab stops on ${f.id}, which is not a control`);
      continue;
    }
    order.push(f.id);
    if (!f.ring) fail(`${f.id} shows no focus ring`);
  }
  if (order.join() !== want.join()) fail(`Tab order is ${order.join(' > ')} (want ${want.join(' > ')})`);
  // Keyboard path into the map: from "Explore map with keys", arrows pin a hexagon and move it to its neighbours (the
  // card is a live region, so it is announced), Enter pins, the map pans to keep it in view, Escape lets go.
  const cardText = () => page.locator('#probe').innerText();
  const pinnedAt = async () => page.evaluate(() => {
    const p = document.getElementById('probe');
    return p && !p.hidden && p.dataset.key?.endsWith('|true') ? p.dataset.key : null;
  });
  await page.locator('#explore').focus();
  const chip = await page.locator('#explore').boundingBox();
  if (!chip || chip.width < 60 || chip.height < 20) fail('Explore map with keys is not visible when focused');
  else if (chip.y + chip.height > 120) fail('Explore map with keys sits too low to be compact');
  await shot('3b-explore-focus');
  const d2 = await page.locator('#t-date').textContent();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const k1 = await pinnedAt();
  const c1 = await cardText();
  if (!k1) fail('an arrow key on Explore map with keys pinned no hexagon');
  if ((await page.locator('#t-date').textContent()) !== d2) fail('arrow keys on the map explorer also stepped the date');
  if ((await page.locator('#probe').getAttribute('aria-live')) !== 'polite') fail('the hexagon card is not a polite live region');
  if (!(await page.locator('#probe .probe-title').count())) fail('the keyboard-pinned card has no title');
  const seen = new Set([k1]);
  for (const key of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowDown']) {
    const card = await cardText();
    await page.keyboard.press(key);
    await page.waitForTimeout(250);
    // Every step must read differently (a step count and direction lead the card), or a screen reader says nothing new.
    if ((await cardText()) === card) fail(`${key} left the card's words unchanged`);
    const k = await pinnedAt();
    if (!k) fail(`${key} dropped the pinned hexagon`);
    else if (seen.has(k) && key !== 'ArrowLeft' && key !== 'ArrowDown') fail(`${key} did not move to a new hexagon`);
    seen.add(k);
  }
  if (seen.size < 4) fail(`arrow keys visited only ${seen.size} different hexagons`);
  // Home and End belong to this widget while it has focus: they must not jump the time slider.
  const d3 = await page.locator('#t-date').textContent();
  await page.keyboard.press('End');
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(200);
  if ((await page.locator('#t-date').textContent()) !== d3) fail('End or Page Up on the map explorer moved the date');
  // Enter while pinned says so, and keeps the pin.
  const pinnedKey = await pinnedAt();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  if (!/Pinned/.test(await page.locator('#action-msg').innerText())) fail('Enter on a pinned hexagon did not say it is already pinned');
  if ((await pinnedAt()) !== pinnedKey) fail('Enter on a pinned hexagon changed it');
  // Left, then right, comes back to the same hexagon.
  const before = await pinnedAt();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  const left = await pinnedAt();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  if ((await pinnedAt()) !== before || left === before) fail('Left then Right did not return to the same hexagon');
  await shot('3c-explore-pinned');
  if ((await page.evaluate(() => document.activeElement?.id)) !== 'explore') fail('focus left Explore map with keys while arrowing');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await pinnedAt()) fail('Escape did not release the keyboard-pinned hexagon');
  // Enter pins again, starting from the last pinned hexagon.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  if ((await pinnedAt()) !== before) fail('Enter did not pin the last pinned hexagon again');
  // Zoomed in, walking off the edge of the view pans the map to follow.
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__hatch.map.view([-89.4, 43.07], 9));
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const mid0 = await page.evaluate(() => window.__hatch.map.center(window.__hatch.padding()).lngLat);
  // Finer hexagons at this zoom are small steps, and a big screen holds a lot of map: keep walking east until the view
  // has moved (a few dozen presses at most), then let the glide settle.
  let mid1 = mid0;
  for (let i = 0; i < 40 && Math.abs(mid1[0] - mid0[0]) < 0.05; i++) {
    for (let j = 0; j < 5; j++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    mid1 = await page.evaluate(() => window.__hatch.map.center(window.__hatch.padding()).lngLat);
  }
  await page.waitForTimeout(1200);
  if (Math.abs(mid1[0] - mid0[0]) < 0.05) fail('walking off the edge of the view did not pan the map');
  await shot('3d-explore-pan');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur());
  await page.reload();
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.activeElement?.blur());

  // On the focused slider, plain arrows step one day and the slider says the date, not a number.
  const dr = await page.locator('#t-date').textContent();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  if ((await page.locator('#t-date').textContent()) === dr) fail('Right arrow on the slider did not step the date');
  if ((await page.locator('#t-range').getAttribute('aria-valuetext')) !== (await page.locator('#t-date').textContent()))
    fail('the slider does not announce the date');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur());
  const d0 = await page.locator('#t-date').textContent();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  if ((await page.locator('#t-date').textContent()) === d0) fail('Right arrow did not step the date');
  const d1 = await page.locator('#t-date').textContent();
  await page.keyboard.press('Space');
  // Software GL in CI can draw a frame or two a second: give playback a few seconds to move the date.
  const played = await page.waitForFunction((d) => document.querySelector('#t-date')?.textContent !== d, d1, { timeout: 4000 }).then(() => true, () => false);
  await page.keyboard.press('Space');
  if (!played) fail('Space did not play');

  // Resize the window: the map refits to what a fresh load at the new size would show.
  await page.setViewportSize({ width: Math.round(width * 0.75), height: Math.round(height * 0.85) });
  await page.waitForTimeout(800);
  await page.mouse.move(2, 200);
  // On ~2fps CI frames the refit can still be landing: take shots until two in a row agree (a few seconds at most).
  let r = await midwest(page, await page.screenshot());
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(700);
    const again = await midwest(page, await page.screenshot());
    const still = Math.abs(again.w - r.w) < 0.02 && Math.abs(again.h - r.h) < 0.02;
    r = again;
    if (still) break;
  }
  await shot('6-resized');
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
};

// No WebGL (old GPU driver, hardware acceleration off): the page must say so, not show an empty map.
const noWebglUnit = async () => {
  const b = await pw.chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--disable-webgl', '--disable-webgl2'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(file + '?noauto');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/chromium-no-webgl.png` });
  if (!(await page.locator('#no-webgl').isVisible())) problems.push('no WebGL: the map is blank with no message');
  await b.close();
};

// Live mode, over http. The test serves its own copies of latest.json (a real-looking one built from the stub, a late one,
// a missing one) so the default-season and stale rules can be checked on any day; ?today= fakes the clock.
const distDir = resolve(process.env.DIST_DIR ?? 'dist');
if (engines.includes('chromium') && existsSync(join(distDir, 'live/latest.json'))) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let f = join(distDir, path);
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!f.startsWith(distDir) || !existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stub = JSON.parse(readFileSync(join(distDir, 'live/latest.json'), 'utf8'));
  const real = { ...stub, stub: false, backfill: false, as_of: `${stub.season}-06-10`, generated: `${stub.season}-06-11T06:00:00Z` };
  const late = { ...real, generated: `${stub.season}-06-08T06:00:00Z` };
  const placeholder = { ...real, stub: true };
  // The first real night of a season can carry data only to 28 Feb: the whole track is forecast, the map still opens on April.
  const early = { ...real, as_of: `${stub.season}-02-28`, generated: `${stub.season}-03-02T06:00:00Z` };
  const rerun = { ...late, backfill: true }; // rebuilt after the fact: old, but never "stale"
  const inSeason = `${stub.season}-06-11T12:00:00Z`;
  // Every species with a part in the file gets live mode; one without (here the beetle) does not.
  const someSpecies = { ...real, species: Object.fromEntries(Object.entries(real.species ?? {}).filter(([k]) => k !== 'japanese-beetle')) };
  // [label, query, served file (null = the stub as built, 404 = none), width, height, phone]
  const cases = [
    ['in-season default', `?noauto&today=${inSeason}`, someSpecies, 1440, 900, false],
    ['off-season pick', '?noauto&today=2027-01-15', real, 1440, 900, false],
    ['shared link keeps its year', `?year=2021&noauto&today=${inSeason}`, real, 1440, 900, false],
    ['late file', `?noauto&today=${inSeason}`, late, 1440, 900, false],
    ['phone', `?noauto&today=${inSeason}`, real, 390, 844, true],
    ['small phone', `?season=live&noauto&today=${inSeason}&date=06-20`, real, 320, 640, true],
    ['early file', `?noauto&today=${stub.season}-03-02T12:00:00Z`, early, 1280, 720, false],
    ['rerun', `?noauto&today=${inSeason}`, rerun, 1280, 720, false],
    ['stub hidden', `?noauto&today=${inSeason}`, placeholder, 1280, 720, false],
    ['stub on request', '?season=live&noauto', placeholder, 1280, 720, false],
    ['file as built', '?season=live&noauto', null, 1280, 720, false],
    ['no file', `?noauto&today=${inSeason}`, 404, 1280, 720, false],
  ];
  const liveUnit = async ([label, query, served, width, height, phone], browser) => {
    const tag = `live ${label}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    if (served === 404) await page.route('**/live/latest.json', (r) => r.fulfill({ status: 404, body: '' }));
    else if (served) await page.route('**/live/latest.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(served) }));
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && fail(`external request ${r.url()}`));
    // The missing file's 404 is logged by the browser itself; nothing else may be.
    page.on('console', (m) => m.type() === 'error' && !(served === 404 && /404/.test(m.text())) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    let liveFetched = false;
    page.on('request', (r) => /\/live\/latest\.json/.test(r.url()) && (liveFetched = true));
    const shotL = (step) => page.screenshot({ path: `${out}/live-${label.replace(/\W+/g, '-')}-${step}.png` });
    try {
      await page.goto(origin + '/' + query);
      await page.waitForTimeout(1500);
      if (label === 'off-season pick') {
        // Off-season, the live file (the biggest a visit could load) waits until the reader reaches for the season menu.
        if (liveFetched) fail('an off-season first visit downloaded the live file');
        await page.locator('#season').hover();
        await page.waitForTimeout(800);
        if (!liveFetched) fail('reaching for the season menu did not fetch the live file');
      }
      const opts = await page.locator('#season option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
      const value = await page.locator('#season').inputValue();
      const hasLive = opts[0]?.[0] === 'live';
      const wantOption = !['stub hidden', 'no file'].includes(label);
      if (wantOption !== hasLive) fail(hasLive ? 'offers live mode' : `no live option at the top of the season menu (${opts.slice(0, 2).join(' | ')})`);
      if (hasLive && !new RegExp(`^${stub.season}( live)?( \\(|$)`).test(opts[0][1])) fail(`live option reads "${opts[0][1]}"`);
      const wantLive = ['in-season default', 'late file', 'phone', 'small phone', 'early file', 'rerun', 'stub on request', 'file as built'].includes(label);
      if (wantLive !== (value === 'live')) fail(`season menu opened on ${value}`);
      if (label === 'shared link keeps its year' && value !== '2021') fail(`a ?year=2021 link opened on ${value}`);
      if (label === 'off-season pick' && hasLive) {
        await page.locator('#season').selectOption('live');
        await page.waitForTimeout(800);
      }
      if ((await page.locator('#season').inputValue()) !== 'live') {
        if (!(await page.locator('#t-asof').isHidden())) fail('the "as of" badge shows outside live mode');
        await ctx.close();
        return;
      }
      // Live: starts on the last observed day, flags it, says how fresh the data is.
      const asOfDate = new Date(Date.parse((served ?? stub).as_of)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      if (label === 'early file') {
        const wash = await page.locator('#t-fc').evaluate((el) => !el.hidden && getComputedStyle(el.parentElement.parentElement).getPropertyValue('--fc').trim());
        if (wash !== '0') fail(`a file from before April does not make the whole track forecast (${wash})`);
        if (await page.locator('#t-ticks .now.asof-flag').count()) fail('an "as of" flag off the start of the track');
        if (!/^Apr 1,/.test(await page.locator('#t-date').textContent())) fail(`an early file opened on ${await page.locator('#t-date').textContent()}`);
        await shotL('1-map');
        await ctx.close();
        console.log(`${tag}: checked`);
        return;
      }
      if (label === 'small phone') {
        // The date and the badge (stacked here) stay within the buttons' height, so the time bar is no taller than on wider phones.
        const [d, b] = await Promise.all(['.date', '.btns'].map((sel) => page.locator(sel).boundingBox()));
        if (d.height > b.height + 1) fail(`the date and "as of" badge are ${Math.round(d.height)}px tall, taller than the ${Math.round(b.height)}px buttons`);
      }
      if (!/date=/.test(query) && (await page.locator('#t-date').textContent()) !== asOfDate)
        fail(`scrubber opened on ${await page.locator('#t-date').textContent()}, not the as-of day ${asOfDate}`);
      if (!(await page.locator('#t-ticks .now.asof-flag').count())) fail('no "as of" flag on the scrubber');
      const badge = page.locator('#t-asof');
      if (!(await badge.isVisible())) fail('no "as of" badge');
      const stale = (await badge.getAttribute('class')).includes('stale');
      // Amber only when the nightly run is overdue; a frozen or rebuilt file shows its age without it.
      if (stale !== (label === 'late file')) fail(stale ? 'fresh data marked stale' : 'a late file is not marked stale');
      // The address bar follows the view on a throttle; a software-GL page can take seconds per frame, so wait for it.
      await page.waitForFunction(() => new URLSearchParams(location.search).get('season') === 'live', null, { timeout: 10000 })
        .catch(() => fail(`address bar does not keep live mode: ${page.url()}`));
      await page.mouse.move(2, height / 2);
      await shotL('1-map');
      // The hex card, from a tap (phone) or a click (desktop) near the middle of the map.
      let card = null;
      for (const [fx, fy] of [[0.5, 0.45], [0.45, 0.4], [0.55, 0.5], [0.4, 0.35], [0.6, 0.55]]) {
        const p = [Math.round(width * fx), Math.round(height * fy)];
        if (phone) await page.touchscreen.tap(...p);
        else await page.mouse.click(...p);
        await page.waitForTimeout(600);
        if (await page.locator('#probe').isVisible()) {
          card = await page.locator('#probe').textContent();
          if (/Peak likely/.test(card)) break; // the live hex card's one answer line
          if (phone) await page.touchscreen.tap(...p); // a dot's card: let it go and try the next spot
          else await page.mouse.click(...p);
          await page.waitForTimeout(400);
          card = null;
        }
      }
      if (!card) fail('no live hex card with "Peak likely" near the middle of the map');
      else {
        if (!/out by/.test(card) || !/degree-days/.test(card)) fail(`hex card lacks "out by" or "degree-days": ${card}`);
        await shotL('2-card');
      }
      if (phone) {
        const bad = await page.evaluate(audit);
        bad.bad.forEach((m) => fail(`with a live card open, ${m}`));
        if (bad.scrolls) fail('page scrolls');
      }
      // Scrub past "today": the label says forecast. Then zoom in close: live splits into finer hexagons too.
      await page.evaluate(() => window.__hatch.time.step(10));
      await page.waitForTimeout(200);
      if (served !== null && (await page.locator('#t-doy').textContent()) !== 'forecast') fail('a day after "today" is not marked forecast');
      await page.evaluate(() => window.__hatch.map.view([-87.9, 42.0], 8.6));
      await page.waitForFunction(() => window.__hatch.luna.res() > 4, null, { timeout: 8000 }).catch(() => {});
      if ((await page.evaluate(() => window.__hatch.luna.res())) <= 4) fail('live mode stayed on the big hexagons when zoomed in');
      if (label === 'in-season default') {
        // About panel: the live card and the weather credits.
        await page.locator('#info-btn').click();
        await page.waitForTimeout(500);
        const about = await page.locator('#drawer').textContent();
        if (!/how it works/.test(about)) fail('the About panel has no live-mode card');
        if (!/Open-Meteo/.test(about)) fail('the credits do not name Open-Meteo');
        await shotL('3-about');
        // The live scorecard (live/scorecard.json, lazy): a line and a strip table in "How sure is it?".
        if (existsSync(join(distDir, 'live/scorecard.json'))) {
          const sc = page.locator('#drawer [data-score] .sc-line');
          await sc.waitFor({ timeout: 4000 }).catch(() => fail('no live scorecard line in "How sure is it?"'));
          if ((await page.locator('#drawer .sc-tab tbody tr').count()) !== 5) fail('the scorecard table does not have 5 strips');
          await sc.scrollIntoViewIfNeeded().catch(() => {});
          await shotL('4-scorecard');
        }
        await page.keyboard.press('Escape');
        // The firefly has a part in the served file: picking it from live mode stays live, and its menu offers live.
        // The beetle has none: it lands on all years, its menu has no live option, and says why at the top.
        if (await page.locator('#species').isVisible()) {
          await page.locator('#species').selectOption('firefly');
          await page.waitForFunction(() => window.__hatch.current().id === 'firefly-replay', null, { timeout: 8000 }).catch(() => fail('the firefly never loaded'));
          await page.waitForTimeout(800);
          if ((await page.locator('#season').inputValue()) !== 'live') fail(`firefly from live mode opened on ${await page.locator('#season').inputValue()}`);
          if (!(await page.locator('#season option[value=live]').count())) fail('the firefly season menu does not offer live mode');
          // Entering live mode lands on the species' own as-of day (its part of the file can run to another day than luna's).
          const ffAsOf = someSpecies.species?.firefly?.as_of;
          const ffDate = ffAsOf && new Date(Date.parse(ffAsOf)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
          if (ffDate && (await page.locator('#t-date').textContent()) !== ffDate)
            fail(`firefly live mode opened on ${await page.locator('#t-date').textContent()}, not its as-of day ${ffDate}`);
          await page.locator('#species').selectOption('japanese-beetle');
          await page.waitForFunction(() => window.__hatch.current().id === 'japanese-beetle-replay', null, { timeout: 8000 }).catch(() => fail('the beetle never loaded'));
          await page.waitForTimeout(800);
          if ((await page.locator('#season').inputValue()) !== 'typical') fail(`the beetle (no live entry) from live mode opened on ${await page.locator('#season').inputValue()}`);
          if (await page.locator('#season option[value=live]').count()) fail('the beetle season menu offers live mode without a live entry');
          if (!/not for .* yet/.test((await page.locator('#season option[disabled]').first().textContent().catch(() => '')) ?? ''))
            fail('the beetle season menu does not say live mode is not there for it yet');
          await page.locator('#species').selectOption('luna');
          await page.waitForTimeout(500);
          if (!(await page.locator('#season option[value=live]').count())) fail('back on luna, the live option is gone');
        } else fail('no species menu over http');
      }
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // The species menu, from src/species.ts: every species is listed, a ?species= link opens on it, each one loads,
  // names itself in the header and the About panel, keeps the link, and draws a coloured map. Desktop and phones.
  const keyOf = (src) => [...src.matchAll(/key: '([a-z-]+)'/g)].map((m) => m[1]);
  const listed = keyOf(readFileSync('src/species.ts', 'utf8'));
  const speciesCases = [
    ['desktop', 1440, 900, false],
    ['phone', 390, 844, true],
    ['small phone', 320, 640, true],
  ];
  const speciesUnit = async ([label, width, height, phone], browser) => {
    const tag = `species ${label}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && fail(`external request ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const shotS = (step) => page.screenshot({ path: `${out}/species-${label.replace(/\W+/g, '-')}-${step}.png` });
    try {
      await page.goto(origin + '/?species=japanese-beetle&noauto&today=2027-01-15&date=07-05');
      await page.waitForFunction(() => window.__hatch.current().id === 'japanese-beetle-replay', null, { timeout: 30000 })
        .catch(() => fail('a ?species=japanese-beetle link never opened on the beetle'));
      await page.waitForTimeout(1500);
      const keys = await page.locator('#species option').evaluateAll((os) => os.map((o) => o.value));
      if (keys.join() !== listed.join()) fail(`species menu lists ${keys.join(', ')}, src/species.ts has ${listed.join(', ')}`);
      if (!/insect tracking/.test(await page.locator('#tagline').textContent())) fail('the header lost its site-wide subtitle');
      if ((await page.locator('#dots-what').textContent()) !== 'beetles') fail('the dots line does not count beetles');
      if (!new URL(page.url()).searchParams.get('species')?.startsWith('japanese-beetle')) fail(`the link dropped the species: ${page.url()}`);
      const bad = await page.evaluate(audit);
      bad.bad.forEach((m) => fail(m));
      if (bad.scrolls) fail('page scrolls');
      const png = await page.screenshot({ path: `${out}/species-${label.replace(/\W+/g, '-')}-1-map.png` });
      const m = await midwest(page, png);
      if (m.w < 0.3) fail(`the beetle's coloured hexagons span only ${Math.round(m.w * 100)}% of the width`);
      await page.locator('#info-btn').click();
      await page.waitForTimeout(700);
      if (!/Popillia japonica/.test(await page.locator('#drawer').textContent())) fail('the About panel does not describe the Japanese beetle');
      await shotS('2-about');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      // Every other species from the menu, then back: each loads (its own layer id) and is drawn.
      for (const k of listed.filter((k) => k !== 'japanese-beetle')) {
        await page.locator('#species').selectOption(k);
        await page.waitForFunction((k) => /-(replay|front)$/.test(window.__hatch.current().id) && window.__hatch.current().id.startsWith(`${k}-`), k, { timeout: 30000 }).catch(() => fail(`${k} never loaded`));
        // A tracker (monarch, red admiral) has no forecast: the page drops its "Colors: forecast" caveat; the others keep it.
        const tracker = await page.evaluate(() => window.__hatch.current().tracker === true);
        if ((await page.locator('#app.tracker').count()) !== (tracker ? 1 : 0)) fail(`${k}: the page's tracker mode does not match the layer (tracker=${tracker})`);
      }
      await page.waitForTimeout(600);
      await shotS('3-last');
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };

  // Find a town (http only: it reads the map's town names), on a desktop and a phone: the box opens at its button, a
  // name several towns share lists them (forecast states first, each with its state), and picking one pins its card.
  // The About panel's "Or find a town" opens the same box in the panel. Share's "Link copied" shows by its button.
  const findUnit = async ([w, h, phone], browser) => {
    const tag = `find ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    if (!phone) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const shotF = (step) => page.screenshot({ path: `${out}/find-${phone ? 'phone' : 'desktop'}-${step}.png` });
    try {
      await page.goto(origin + '/?noauto&today=2027-01-15');
      await page.waitForTimeout(1500);
      await page.locator('#find').click();
      const [f, b] = await Promise.all(['#finder', '#find'].map((sel) => page.locator(sel).boundingBox()));
      if (!f) fail('the name box did not open');
      else if (Math.hypot(f.x + f.width / 2 - (b.x + b.width / 2), f.y + f.height - b.y) > (phone ? 260 : 200)) fail(`the name box opened far from its button (${Math.round(f.x)},${Math.round(f.y)})`);
      await page.locator('#find-q').fill('Springfield');
      await page.waitForTimeout(600);
      await shotF('1-typing');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const opts = await page.locator('#find-list li').allTextContents();
      if (!/^Springfield, IL/.test(opts[0] ?? '') || opts.length < 2) fail(`"Springfield" + Enter lists ${JSON.stringify(opts)}`);
      if (opts.some((o) => /\(near /.test(o))) fail('a town is told apart by "(near ...)", not its state');
      await page.locator('#find-list li').first().click();
      await page.waitForTimeout(1200);
      if (!/Springfield, IL/.test((await page.locator('#probe').textContent()) ?? '')) fail('picking Springfield, IL showed no card for it');
      await shotF('2-picked');
      await page.locator('#info-btn').click();
      await page.waitForTimeout(500);
      if (!(await page.locator('#drawer [data-find]').isVisible())) fail('the About panel has no "find a town" button');
      else {
        await page.locator('#drawer [data-find]').click();
        if (!(await page.locator('#drawer #finder').isVisible())) fail('the About panel button did not open the name box in the panel');
        await page.locator('#find-q').fill('Cincinnati');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1200);
        if (!/Cincinnati/.test((await page.locator('#drawer .spot-title').textContent()) ?? '')) fail('finding Cincinnati from About did not fill its season');
        await shotF('3-about');
        // A name that is not on the map: the message shows over the panel, by the box.
        await page.locator('#drawer [data-find]').click();
        await page.locator('#find-q').fill('Zzyzx');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const onTop = await page.evaluate(() => {
          const m = document.getElementById('action-msg');
          const r = m.getBoundingClientRect();
          return !!r.width && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === m;
        });
        if (!onTop) fail('"No town named ..." from the About panel is hidden under it');
        // Closing the panel with the box still open sends the box home, closed, and Escape then lets the card go.
        await page.locator('#drawer-close').click();
        await page.waitForTimeout(500);
        const home = await page.evaluate(() => {
          const f = document.getElementById('finder');
          return !!f && f.hidden && f.parentElement?.id === 'bottom' && document.getElementById('find').getAttribute('aria-expanded') === 'false';
        });
        if (!home) fail('closing About left the town box open inside it');
        if (await page.locator('#probe').isVisible()) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          if (await page.locator('#probe').isVisible()) fail('after About closed over the town box, Escape no longer lets the card go');
        }
      }
      await page.keyboard.press('Escape');
      if (!phone) {
        await page.waitForTimeout(1000); // the About panel slides away
        await page.locator('#share').click({ timeout: 60000 });
        await page.waitForTimeout(300);
        const [m, s] = await Promise.all(['#action-msg', '#share'].map((sel) => page.locator(sel).boundingBox()));
        if (!m || !m.height) fail('Share said nothing');
        // Just over the time bar, or over a card docked in that corner.
        else if (m.y + m.height > s.y || s.y - (m.y + m.height) > 300 || m.x + m.width < s.x) fail('"Link copied" is not next to Share');
        await shotF('4-share');
      }
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // The radar replays (src/radar/, http only: their frames are files beside the page). Nothing of one loads until it is
  // opened: About lists every event, its link then fetches that event's code and frames (and no other's), the map glides
  // to the radar and plays, the card gives the local time, "How we know" has the sources, the link names the replay, and
  // × brings the Midwest back. A ?radar= link with reduced motion opens it paused, on a scan with echo.
  // Per event: the radar, its time zone and month, a point on its paper sheet (60 km out, clear of echo) and one well
  // outside it (on the forecast hexagons).
  const RADARS = {
    'karx-2014-07-20': { at: [-91.19, 43.82], when: /\b\d{1,2}:\d\d (am|pm) CDT\b[\s\S]*July 2014/, sheet: [-91.94, 43.82], off: [-93.0, 43.82] },
    'kcle-2019-06-26': { at: [-81.86, 41.41], when: /\b\d{1,2}:\d\d (am|pm) EDT\b[\s\S]*June 2019/, sheet: [-81.86, 40.87], off: [-83.78, 41.41] },
  };
  const ERIE = 'kcle-2019-06-26';
  // A screenshot straight from the browser (CDP): page.screenshot first waits for web fonts and quiet frames, which on
  // software GL with a replay playing can take past its timeout. Saved to `path`; the PNG bytes come back.
  const shotCdp = async (page, path) => {
    const cdp = await page.context().newCDPSession(page);
    const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    await cdp.detach();
    writeFileSync(path, png);
    return png;
  };
  // La Crosse in every case; Lake Erie at the desktop size (from About), then the switch case on the same page. Erie on a
  // phone (upright and on its side, with "How we know" clear of the radar) and from a ?radar= link are mobile.mjs's
  // radar pass; opening paused under reduced motion is the same code for every event (La Crosse's case here).
  // Waits poll for what they wait for (a glide that has settled, the link catching up), never a fixed time.
  // A case marked `keep` hands its page on to the next one (same kind of screen; a phone turned on its side), which
  // starts from it at the whole Midwest with the replay closed instead of loading the page again; the last desktop one
  // goes on to the switch case.
  const radarUnit = async (browser) => {
  let carry = null;
  for (const [label, w, h, phone, reduce, id, keep] of [
    ['phone', 390, 844, true, false, 'karx-2014-07-20', true], ['phone on its side', 852, 393, true, false, 'karx-2014-07-20'],
    ['reduced motion link', 1280, 720, false, true, 'karx-2014-07-20'],
    ['desktop', 1366, 768, false, false, 'karx-2014-07-20', true], ['desktop, Lake Erie', 1366, 768, false, false, ERIE, true],
  ]) {
    const ev = RADARS[id];
    const tag = `radar ${label}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const reused = !!carry && carry.phone === phone && !reduce;
    if (carry && !reused) await carry.ctx.close();
    const { ctx, page, fetched, state } = reused ? carry : await (async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
        reducedMotion: reduce ? 'reduce' : 'no-preference' });
      const page = await ctx.newPage();
      const fetched = [];
      const state = { fail };
      page.on('request', (r) => /radar/i.test(new URL(r.url()).pathname) && fetched.push(new URL(r.url()).pathname));
      page.on('console', (m) => m.type() === 'error' && state.fail(`console error: ${m.text()}`));
      page.on('pageerror', (e) => state.fail(`pageerror: ${e.message}`));
      return { ctx, page, fetched, state, phone };
    })();
    carry = null;
    state.fail = fail;
    fetched.length = 0;
    const shotR = (step) => shotCdp(page, `${out}/radar-${label.replace(/\W+/g, '-')}-${step}.png`);
    const link = page.locator(`#drawer .ex-radar[data-radar="${id}"]`);
    const view = () => page.evaluate(() => ({ zoom: window.__hatch.map.zoom(), fit: window.__hatch.map.moved() === false, c: window.__hatch.map.center(window.__hatch.padding()) }));
    // The glide has come to rest: the same view on two polls in a row.
    const settled = () => page.waitForFunction(() => {
      const c = window.__hatch.map.center(window.__hatch.padding());
      const v = `${window.__hatch.map.zoom()?.toFixed(4)}|${c?.lngLat.map((x) => x.toFixed(5))}`;
      const same = window.__radarView === v;
      window.__radarView = v;
      return same;
    }, null, { timeout: 30000, polling: 200 }).catch(() => fail('the map never came to rest'));
    // The address bar catches up with the page on its own beat: poll for it, then say what it shows if it never does.
    const urlIs = (want) => page.waitForFunction((w) => new URL(location.href).searchParams.get('radar') === w, want, { timeout: 5000, polling: 100 }).catch(() => {});
    try {
      if (reused) {
        // Turned (or the same screen): back at the whole Midwest for this size before anything is opened.
        if (page.viewportSize().width !== w || page.viewportSize().height !== h) await page.setViewportSize({ width: w, height: h });
        await page.waitForFunction(() => window.__hatch.map.moved() === false && Math.abs(window.__hatch.map.zoom() - window.__hatch.map.fitZoom()) < 0.05,
          null, { timeout: 30000, polling: 200 }).catch(() => fail('the page handed on was not at the whole Midwest'));
      } else await page.goto(origin + (reduce ? `/?radar=${id}&noauto&today=2027-01-15` : '/?noauto&today=2027-01-15'));
      if (!reduce) {
        // The page has fetched all it fetches by itself (nothing on the wire for half a second).
        await page.waitForLoadState('networkidle');
        if (fetched.length) fail(`fetched before it was opened: ${fetched.join(', ')}`);
        await page.locator('#info-btn').click();
        // Once the panel has slid in, the whole list of links shows without scrolling (on a phone, at the sheet's middle
        // stop), one for each event. Waited for, so the click never has to scroll a half-arrived panel into view.
        await page.waitForFunction((n) => {
          const all = [...document.querySelectorAll('#drawer .ex-radar')].map((b) => b.getBoundingClientRect());
          return all.length === n && all.every((r) => r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth) &&
            getComputedStyle(document.getElementById('drawer')).transform === 'none';
        }, Object.keys(RADARS).length, { timeout: 30000, polling: 250 }).catch(() => fail('About does not show every radar replay in view'));
        if (!(await link.isVisible())) throw new Error(`About has no link to ${id}`);
        if (fetched.length) fail(`opening About fetched ${fetched.join(', ')}`);
        await link.click();
      }
      await page.waitForSelector('#radar', { timeout: 30000 });
      for (const f of ['meta.json', 'frames.bin.gz']) if (!fetched.some((p) => p.endsWith(`/radar/${id}/${f}`))) fail(`opening it never fetched ${f}`);
      const others = fetched.filter((p) => /\/radar\/[a-z]{4}-\d{4}-\d\d-\d\d\//.test(p) && !p.includes(`/radar/${id}/`));
      if (others.length) fail(`opening it fetched another event too: ${others.join(', ')}`);
      const cap = await page.locator('#radar .rd-cap').innerText();
      if (!ev.when.test(cap) || !/[Mm]ayflies/.test(cap)) fail(`the caption reads "${cap.replace(/\s+/g, ' ')}"`);
      if (!(await page.locator('#dock').isHidden())) fail('the time bar stays up beside the replay');
      await page.waitForFunction(([lng, lat]) => {
        const c = window.__hatch.map.center(window.__hatch.padding());
        return window.__hatch.map.zoom() > window.__hatch.map.fitZoom() + 1 && Math.abs(c.lngLat[0] - lng) < 0.5 && Math.abs(c.lngLat[1] - lat) < 0.6;
      }, ev.at, { timeout: 30000 }).catch(async () => fail(`the map did not go to the radar: ${JSON.stringify(await view())}`));
      await settled();
      // Drawn where it belongs: the radar's paper sheet 60 km from the radar, and the map's own colours well outside it.
      const png = await shotR('1-open');
      const px = await page.evaluate(async ([b64, sheet, off]) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const k = bmp.width / innerWidth;
        const at = (lngLat) => {
          const [x, y] = window.__hatch.map.project(lngLat);
          return [...g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)];
        };
        return { sheet: at(sheet), off: at(off) };
      }, [png.toString('base64'), ev.sheet, ev.off]);
      const paper = ([r, g, b]) => r > 225 && g > 220 && b > 200;
      if (!paper(px.sheet) || paper(px.off)) fail(`no radar sheet at its place (inside ${px.sheet}, outside ${px.off})`);
      const t0 = await page.locator('#radar .rd-time').textContent();
      const moving = await page.waitForFunction((t) => document.querySelector('#radar .rd-time')?.textContent !== t, t0, { timeout: reduce ? 4000 : 30000 })
        .then(() => true, () => false);
      if (moving === reduce) fail(reduce ? 'it plays under reduced motion' : 'the replay does not play');
      if (reduce && !/^Play/.test((await page.locator('#radar .rd-play').getAttribute('aria-label')) ?? '')) fail('under reduced motion it does not open paused');
      await urlIs(id);
      if (new URL(page.url()).searchParams.get('radar') !== id) fail(`the link does not name the replay: ${page.url()}`);
      await page.locator('#radar .rd-i').click();
      if (h <= 500) {
        // A phone on its side: with "How we know" open, the radar moves to the right of the card.
        const clear = await page.waitForFunction((lngLat) => {
          const at = window.__hatch.map.project(lngLat);
          return !!at && at[0] > document.getElementById('radar').getBoundingClientRect().right;
        }, ev.at, { timeout: 30000, polling: 250 }).then(() => true, () => false);
        if (!clear) fail('with "How we know" open, the card covers the radar');
      }
      const more = (await page.locator('#radar .rd-more').innerText()).replace(/\s+/g, ' ');
      for (const want of ['raindrops', 'Stepanian et al. 2020', 'NOAA NEXRAD data (public domain)', '52%', '84%'])
        if (!more.includes(want)) fail(`"How we know" does not say "${want}"`);
      if (/space|8:45/i.test(more + cap)) fail('the copy claims a view from space or an 8:45 pm detection');
      const bad = await page.evaluate(audit);
      bad.bad.forEach((m) => fail(m));
      if (bad.scrolls) fail('page scrolls');
      await shotR('2-how');
      // The keys drive the replay, never the hidden season slider (its day would jump and the link with it).
      const day = new URL(page.url()).searchParams.get('date');
      for (const k of ['End', 'Home', 'PageDown', 'PageUp', 'ArrowRight']) await page.keyboard.press(k);
      await page.waitForTimeout(600);
      if (new URL(page.url()).searchParams.get('date') !== day) fail(`a key moved the hidden season slider: date ${day} -> ${new URL(page.url()).searchParams.get('date')}`);
      await page.locator('#radar .rd-x').click();
      if (await page.locator('#radar').count()) fail('× did not close the replay');
      // Back at the whole-Midwest fit: not just flagged as fitted, but drawn at the fit's zoom once the glide is done.
      await page.waitForFunction(() => window.__hatch.map.moved() === false && Math.abs(window.__hatch.map.zoom() - window.__hatch.map.fitZoom()) < 0.05, null, { timeout: 30000 })
        .catch(async () => fail(`closing it did not bring the Midwest back: ${JSON.stringify(await view())}, fit zoom ${await page.evaluate(() => window.__hatch.map.fitZoom())}`));
      // Open it once more (past the shore zoom, back out, past it again), then close with Escape: a console error fails
      // the run. On a keyboard's screens: a phone has no Escape key, and its first open and × are checked above. Lake
      // Erie opens twice more in the switch case below (on this same page), so Escape is La Crosse's here.
      if (!reduce && !phone && id !== ERIE) {
        await page.locator('#info-btn').click();
        await page.waitForFunction(() => getComputedStyle(document.getElementById('drawer')).transform === 'none', null, { timeout: 30000, polling: 250 });
        await link.click();
        await page.waitForSelector('#radar', { timeout: 30000 });
        await page.waitForFunction(() => window.__hatch.map.zoom() > window.__hatch.map.fitZoom() + 1, null, { timeout: 30000, polling: 250 }).catch(() => fail('reopening did not go back to the radar'));
        await settled();
        await page.keyboard.press('Escape');
        if (await page.locator('#radar').count()) fail('Escape did not close the replay');
        await page.waitForFunction(() => Math.abs(window.__hatch.map.zoom() - window.__hatch.map.fitZoom()) < 0.05, null, { timeout: 30000, polling: 250 })
          .catch(async () => fail(`closing it again did not bring the Midwest back: ${JSON.stringify(await view())}`));
      }
      if (await page.locator('#dock').isHidden()) fail('the time bar did not come back');
      await urlIs(null);
      if (new URL(page.url()).searchParams.has('radar')) fail(`the link still names the replay after closing: ${page.url()}`);
      await shotR('3-closed');
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    if (keep) carry = { ctx, page, fetched, state, phone };
    else await ctx.close();
    console.log(`${tag}: checked`);
  }
  // Switching replays: one open, then the other from About, then ×: back to the whole Midwest, not to the first radar.
  // And two clicked at once (before either loads): only the last opens, and nothing of the other is left on the map.
  {
    const tag = 'radar switch';
    const fail = (m) => problems.push(`${tag}: ${m}`);
    // On the desktop cases' page (the same size, back at the whole Midwest), else a fresh one.
    const reuse = carry && !carry.phone ? carry : null;
    if (reuse) reuse.state.fail = fail;
    else if (carry) await carry.ctx.close();
    const ctx = reuse?.ctx ?? (await browser.newContext({ viewport: { width: 1366, height: 768 } }));
    const page = reuse?.page ?? (await ctx.newPage());
    if (!reuse) {
      page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
      page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    }
    const about = async () => {
      await page.locator('#info-btn').click();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('drawer')).transform === 'none', null, { timeout: 30000, polling: 250 });
    };
    const at = (id) => page.waitForFunction(([id, [lng, lat]]) => {
      const c = window.__hatch.map.center(window.__hatch.padding());
      return new URL(location.href).searchParams.get('radar') === id && window.__hatch.map.zoom() > window.__hatch.map.fitZoom() + 1 &&
        Math.abs(c.lngLat[0] - lng) < 0.5 && Math.abs(c.lngLat[1] - lat) < 0.6;
    }, [id, RADARS[id].at], { timeout: 30000, polling: 250 }).then(() => true, () => false);
    const home = () => page.waitForFunction(() => window.__hatch.map.moved() === false && Math.abs(window.__hatch.map.zoom() - window.__hatch.map.fitZoom()) < 0.05,
      null, { timeout: 30000, polling: 250 }).then(() => true, () => false);
    try {
      if (!reuse) {
        await page.goto(origin + '/?noauto&today=2027-01-15');
        await page.waitForLoadState('networkidle');
      }
      await about();
      await page.locator('#drawer .ex-radar[data-radar="karx-2014-07-20"]').click();
      if (!(await at('karx-2014-07-20'))) fail('the first replay did not open at La Crosse');
      await about();
      await page.locator(`#drawer .ex-radar[data-radar="${ERIE}"]`).click();
      if (!(await at(ERIE))) fail('switching did not go to Lake Erie');
      if ((await page.locator('#radar').count()) !== 1) fail('more than one replay card after switching');
      if (!/EDT/.test(await page.locator('#radar .rd-cap').innerText())) fail('the card after switching is not Lake Erie\'s');
      // At rest at Lake Erie before ×: the same view on two polls in a row.
      await page.waitForFunction(() => {
        const v = `${window.__hatch.map.zoom()?.toFixed(4)}`;
        const same = window.__switchView === v;
        window.__switchView = v;
        return same;
      }, null, { timeout: 30000, polling: 200 }).catch(() => fail('the map never came to rest at Lake Erie'));
      await page.locator('#radar .rd-x').click();
      if (!(await home())) fail(`× after a switch did not bring the Midwest back: zoom ${await page.evaluate(() => window.__hatch.map.zoom())}, fit ${await page.evaluate(() => window.__hatch.map.fitZoom())}`);
      if (await page.locator('#dock').isHidden()) fail('the time bar did not come back after a switch');
      // Both at once: the drawer's buttons stay in the page while it closes, so a second click still lands.
      await about();
      // The first click's frames: once they are in, that load finds it was overtaken.
      const late = page.waitForEvent('requestfinished', { predicate: (r) => r.url().endsWith('/radar/karx-2014-07-20/frames.bin.gz'), timeout: 30000 }).catch(() => null);
      await page.evaluate((ids) => ids.forEach((id) => document.querySelector(`#drawer .ex-radar[data-radar="${id}"]`).click()), ['karx-2014-07-20', ERIE]);
      if (!(await at(ERIE))) fail('of two quick clicks, the last did not open');
      // The first click's load has come back, unpacked its frames (a moment) and found it was overtaken; the page has
      // drawn since. Nothing to poll for here (it must change nothing), so a short grace after its file is in.
      await late;
      await page.waitForTimeout(300);
      if ((await page.locator('#radar').count()) !== 1 || !/EDT/.test(await page.locator('#radar .rd-cap').innerText())) fail('of two quick clicks, the wrong card is left');
      if (!(await page.evaluate(() => document.getElementById('app').classList.contains('radar-on')))) fail('of two quick clicks, the time bar came back over the replay');
      if (!(await at(ERIE))) fail('of two quick clicks, the first one moved the map after the last opened');
      const png = await shotCdp(page, `${out}/radar-switch-race.png`);
      const sheet = await page.evaluate(async ([b64, lngLat]) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const [x, y] = window.__hatch.map.project(lngLat);
        return [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
      }, [png.toString('base64'), RADARS[ERIE].sheet]);
      if (!(sheet[0] > 225 && sheet[1] > 220 && sheet[2] > 200)) fail(`of two quick clicks, the replay's sheet is gone from the map (${sheet})`);
      await page.locator('#radar .rd-x').click();
      if (!(await home())) fail('× after two quick clicks did not bring the Midwest back');
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  }
  };
  const screenFor = (...k) => (b) => screenUnit(screens.find((s) => s.join() === k.join()), b);
  // Longest first, so the second worker is never left holding the last big one.
  units.push(radarUnit, screenFor('chromium', 2560, 1440), screenFor('chromium', 1920, 1080), screenFor('chromium', 1280, 720),
    screenFor('chromium', 900, 700), ...speciesCases.map((c) => (b) => speciesUnit(c, b)),
    ...[[1366, 768, false], [390, 844, true]].map((c) => (b) => findUnit(c, b)), ...cases.map((c) => (b) => liveUnit(c, b)), noWebglUnit,
    ...screens.filter((s) => s[0] !== 'chromium').map((s) => (b) => screenUnit(s, s[0] === 'chromium' ? b : undefined)));
  await runUnits(Object.keys(browsers).length === 1 ? 2 : 1);
  server.close();
} else {
  if (engines.includes('chromium')) problems.push(`live mode not checked: no ${join(distDir, 'live/latest.json')} (run npm run build first)`);
  units.push(...screens.map((s) => (b) => screenUnit(s, s[0] === 'chromium' ? b : undefined)), ...(engines.includes('chromium') ? [noWebglUnit] : []));
  await runUnits(Object.keys(browsers).length === 1 ? 2 : 1);
}

for (const b of Object.values(browsers)) await b.close();
if (problems.length) {
  console.error('DESKTOP FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('DESKTOP OK');
