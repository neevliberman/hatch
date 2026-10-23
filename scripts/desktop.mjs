// Desktop smoke test: laptop to 1440p screens and a narrow window, in Chrome's (Chromium), Firefox's (Gecko) and Safari's
// (WebKit) engines, driven with a mouse and a keyboard.
// Usage: node scripts/desktop.mjs [outDir]   (Firefox needs a display for WebGL: run under xvfb-run on Linux)
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html),
//      ENGINES (comma list, default "chromium,firefox,webkit").
// FAILS (exit 1) on errors, a blank or shrunken Midwest, controls that are covered or off-screen, a broken mouse flow
// (hover card, click to pin, wheel zoom, "why?", drawer) or a broken keyboard flow (Tab order, focus rings, arrows, Space).
// Then live mode ("This year", public/live/latest.json), which only loads over http: serves dist/ (DIST_DIR) on a local
// port in Chromium, desktop and phone, and fails if the season menu lacks it, picking it errors, the hex card has no
// "Peak likely", hexes go finer when zoomed, the default or stale rules break, or a missing file does anything visible.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
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
const TAB_ORDER = ['season', 'info-btn', 'why', 't-prev', 't-play', 't-next', 't-range', 'locate', 'find', 'share'];
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

  // First visit: the map comes first and the About button glows; i opens the drawer and Escape closes it.
  await page.goto(file);
  await page.waitForTimeout(2500);
  await shot('1-first-visit');
  // Opened from disk there is nothing to fetch, so no live option (and no request: the external-request check above).
  if (await page.locator('#season option[value=live]').count()) fail('the one-file build offers live mode');
  if (await drawerOpen(page)) fail('the drawer covers the map on first visit');
  if (!(await page.locator('#info-btn.hint').count())) fail('the About button does not stand out on first visit');
  await page.locator('#info-btn').click();
  await page.waitForTimeout(400);
  if (!(await drawerOpen(page))) fail('the i button did not open the drawer');
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
  // Under 1000px the colour key can fold, so its fold button (or, folded, its "Key" chip) comes right after About.
  const key = (await page.locator('#key-fold').isVisible()) ? 'key-fold' : (await page.locator('#key-chip').isVisible()) ? 'key-chip' : null;
  const want = key ? [...TAB_ORDER.slice(0, 2), key, ...TAB_ORDER.slice(2)] : TAB_ORDER;
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
  const browser = await pw.chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  // [label, query, served file (null = the stub as built, 404 = none), width, height, phone]
  const cases = [
    ['in-season default', `?noauto&today=${inSeason}`, real, 1440, 900, false],
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
  for (const [label, query, served, width, height, phone] of cases) {
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
    const shotL = (step) => page.screenshot({ path: `${out}/live-${label.replace(/\W+/g, '-')}-${step}.png` });
    try {
      await page.goto(origin + '/' + query);
      await page.waitForTimeout(1500);
      const opts = await page.locator('#season option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
      const value = await page.locator('#season').inputValue();
      const hasLive = opts[0]?.[0] === 'live';
      const wantOption = !['stub hidden', 'no file'].includes(label);
      if (wantOption !== hasLive) fail(hasLive ? 'offers live mode' : `no live option at the top of the season menu (${opts.slice(0, 2).join(' | ')})`);
      if (hasLive && !new RegExp(`^${stub.season} (live|rerun)`).test(opts[0][1])) fail(`live option reads "${opts[0][1]}"`);
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
        continue;
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
        continue;
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
      if (stale !== (label === 'late file')) fail(stale ? 'fresh data marked stale' : 'a late file is not marked stale');
      await page.waitForFunction(() => new URLSearchParams(location.search).get('season') === 'live', null, { timeout: 3000 })
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
      // Scrub past "today": the label says forecast. Then zoom in close: live stays on the big hexagons.
      await page.evaluate(() => window.__hatch.time.step(10));
      await page.waitForTimeout(200);
      if (served !== null && (await page.locator('#t-doy').textContent()) !== 'forecast') fail('a day after "today" is not marked forecast');
      await page.evaluate(() => window.__hatch.map.view([-87.9, 42.0], 8.6));
      await page.waitForTimeout(1200);
      if ((await page.evaluate(() => window.__hatch.luna.res())) !== 4) fail('live mode switched to finer hexagons');
      if (label === 'in-season default') {
        // About panel: the live card and the weather credits.
        await page.locator('#info-btn').click();
        await page.waitForTimeout(500);
        const about = await page.locator('#drawer').textContent();
        if (!/how this forecast is made/.test(about)) fail('the About panel has no live-mode card');
        if (!/Open-Meteo/.test(about)) fail('the credits do not name Open-Meteo');
        await shotL('3-about');
        await page.keyboard.press('Escape');
        // Fireflies have no live season: picking them from live mode lands on all years, and the menu drops live.
        if (await page.locator('#species').isVisible()) {
          await page.locator('#species').selectOption('firefly');
          await page.waitForFunction(() => window.__hatch.current().id !== 'luna-replay', null, { timeout: 8000 }).catch(() => fail('the firefly never loaded'));
          await page.waitForTimeout(500);
          if ((await page.locator('#season').inputValue()) !== 'typical') fail(`firefly from live mode opened on ${await page.locator('#season').inputValue()}`);
          if (await page.locator('#season option[value=live]').count()) fail('the firefly season menu offers live mode');
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
  }
  await browser.close();
  server.close();
} else if (engines.includes('chromium')) problems.push(`live mode not checked: no ${join(distDir, 'live/latest.json')} (run npm run build first)`);

for (const b of Object.values(browsers)) await b.close();
if (problems.length) {
  console.error('DESKTOP FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('DESKTOP OK');
