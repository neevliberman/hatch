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
// Also over http: the radar replays (load nothing until opened from About, then play at La Crosse, the Quad Cities or on Lake Erie and
// close cleanly), and My area's card: one sparkline of the season there, whose dates are the only ones it and the line
// under the map give (ONLY=near). And the card's "Out here now": ranked by nearness to each species' best day there,
// chips that narrow it, short on a phone (ONLY=out). And an Atlas species' track record in "How sure?" (ONLY=track).
// And an early or late chip: opens where its slid 2026 season peaks, with the slide as a bracket on the time bar and
// plain words on the card (ONLY=earlylate). And Share's link reopening the pinned card (ONLY=sharepin). And a radar
// replay's map on the Giant Mayfly, then × putting back the view under it (ONLY=radarmayfly). And the tree of life's English
// group names, its second tap zooming in, and its strips folding away on a phone (ONLY=tree).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { extname, join, normalize, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
/** Picks a species from the header's picker (src/ui/speciesPicker.ts), as a reader would: open it, tap its row. */
/** The Atlas's species photos (src/ui/speciesPicker.ts, its cards): linked from iNaturalist's open-data bucket,
 * never copied, so these are the only outside requests a page may make. */
const PHOTOS = /^https:\/\/(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org)\/photos\//;
const pickSpecies = async (page, key) => {
  await page.locator('#species').click();
  await page.locator(`#sp-list [data-key="${key}"]`).first().click();
};

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
// A section's `w` is its rough cost in seconds on a CI runner with two sections running at once (from the timestamps of
// desktop-smoke runs 41637536187 and 41648610818, the slower of the two where both ran, and 41710698039 for the radar,
// watch, near, track, early/late, share pin, atlas, band, evict and live rerun / late file sections); one without counts
// as a minute.
const runUnits = async (n) => {
  // Longest first, each to whichever of all the shards' workers (n a shard) is free soonest, so every shard ends at about
  // the same time (round robin left one shard with both ~7-minute "watch" sections and twice another's work). Every
  // shard works the same split out, and each section lands in exactly one of them.
  const workers = Array.from({ length: shardOf * n }, (_, k) => ({ shard: Math.floor(k / n) + 1, at: 0 }));
  const shards = Array.from({ length: shardOf }, () => []);
  for (const [u, i] of units.map((u, i) => [u, i]).sort(([a, i], [b, j]) => (b.w ?? 60) - (a.w ?? 60) || i - j)) {
    const w = workers.reduce((a, b) => (b.at < a.at ? b : a));
    w.at += u.w ?? 60;
    shards[w.shard - 1].push(u);
  }
  const all = shards.flat();
  if (all.length !== units.length || new Set(all).size !== units.length || units.some((u) => !all.includes(u))) throw new Error('the shards do not cover every section exactly once');
  const queue = shards[shardNo - 1];
  if (shardOf > 1) {
    const est = Math.max(...workers.filter((w) => w.shard === shardNo).map((w) => w.at));
    console.log(`shard ${shardNo}/${shardOf}: ${queue.length} of ${units.length} sections, ~${Math.round(est / 60)} min: ${queue.map((u) => u.label ?? '?').join(', ')}`);
  }
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

// The UI 4 rise-ins (style.css) translate the species sheet, the town box, a docked hex card and the short notes by a
// few px for up to 180 ms. Every section but ONLY=motion turns just those off, so a place or overlap it measures is
// never a mid-animation one. (Not reduced motion as a whole: that would also stop the camera glides, playback and
// radar replays these sections test.)
const STILL_UI = '#species-sheet, #finder, #probe, #action-msg { animation: none !important; }';
const settledContext = async (browser, opts) => {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((css) => {
    const add = () => document.head.append(Object.assign(document.createElement('style'), { textContent: css }));
    if (document.head) add();
    else document.addEventListener('DOMContentLoaded', add);
  }, STILL_UI);
  return ctx;
};

// The screen point of the spot on the map's cells in a box [w, s, e, n] farthest (in pixels) from the lit photo
// dots: a tap on a dot opens that photo's card instead of the place's.
const clearSpotOn = (page, box) => page.evaluate(([w, s, e, n]) => {
  const h = window.__hatch;
  const lit = h.current().points(h.time.cursor).map((p) => h.map.project(p));
  let best = null;
  for (let lng = w; lng <= e; lng += 0.25)
    for (let lat = s; lat <= n; lat += 0.25) {
      if (h.current().cellAt([lng, lat]) === null) continue;
      const [x, y] = h.map.project([lng, lat]);
      const gap = Math.min(Infinity, ...lit.map(([a, b]) => Math.hypot(a - x, b - y)));
      if (!best || gap > best.gap) best = { gap, x, y };
    }
  return [best.x, best.y];
}, box);

const drawerOpen = (page) => page.locator('#drawer.open').count().then((n) => n > 0);

const screenUnit = async ([engine, width, height], browser = browsers[engine]) => {
  const tag = `${engine} ${width}x${height}`;
  const name = `${engine}-${width}x${height}`;
  const fail = (m) => problems.push(`${tag}: ${m}`);
  const ctx = await settledContext(browser, { viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && fail(`external request ${r.url()}`));
  page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
  page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
  const shot = (step) => page.screenshot({ path: `${out}/${name}-${step}.png` });
  // A step that throws (a click on a covered control waits, then gives up) fails this screen, not the whole run.
  try {

  // First visit: the season plays itself up to 10 June, the map comes first and the About button glows; i opens the
  // drawer (and any click lands the opening on 10 June) and Escape closes it.
  // Timed in the page, by a poll that starts before the app does: a check run from here waits on animation frames,
  // which a software-drawn 2560x1440 map on a busy machine holds back for seconds, so it timed out after the date had
  // long since moved. The page notes when the date first reads April or May (the opening's first day) and when the
  // season then moves on from it by itself, both against its own clock.
  await page.addInitScript(() => {
    let first = null;
    const look = () => {
      const t = document.getElementById('t-date')?.textContent ?? '';
      const at = window.__hatch?.time?.cursor;
      if (first === null && at != null && /^(Apr|May)/.test(t)) {
        first = at;
        window.__autoplayAt = performance.now();
      }
      if (first != null && at > first) return void (window.__autoplayMovedAt = performance.now());
      setTimeout(look, 25);
    };
    look();
  });
  await page.goto(file);
  // The same budget as before, on the page's clock: the opening's first day shows within 8 s of the page loading. The
  // wait here is longer and polls on a timer, so a starved page is judged by its own clock, not by when it got to answer.
  const noted = (key) => page.waitForFunction((k) => window[k] != null, key, { timeout: 30000, polling: 100 }).then(() => true, () => false);
  const budget = (await noted('__autoplayAt'))
    ? await page.evaluate(() => window.__autoplayAt - performance.getEntriesByType('navigation')[0].loadEventEnd) : null;
  // And then it really plays: the season moves on from that first day before anything is touched (it plays to 10 June
  // in about 4 s once the map's first frame is up).
  const moved = budget != null && (await noted('__autoplayMovedAt'));
  await shot('1-first-visit');
  if (budget == null || budget > 8000) fail(`the season did not play itself on first visit (its first day showed ${budget == null ? 'never' : `${Math.round(budget)} ms after load`})`);
  else if (!moved) fail('the season did not play itself on first visit (it showed its first day but never moved on)');
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
  // The fresh load can still be drawing its first frames on a slow CI runner (a 54% x 20% sliver seen in webkit):
  // the same wait as above, shots until two in a row agree.
  let f = await midwest(page, await page.screenshot());
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(700);
    const again = await midwest(page, await page.screenshot());
    const still = Math.abs(again.w - f.w) < 0.02 && Math.abs(again.h - f.h) < 0.02;
    f = again;
    if (still) break;
  }
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
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let f = join(distDir, path);
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!f.startsWith(distDir) || !existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
  });
  // Node closes an idle kept-alive socket after 5 s; a browser reusing it at that moment gets ERR_CONNECTION_RESET, and on
  // a slow runner that dropped a file now and then (the Atlas's 2026 photos). Keep idle sockets open longer than a test.
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 121000;
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
    const ctx = await settledContext(browser, { viewport: { width, height }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    if (served === 404) await page.route('**/live/latest.json', (r) => r.fulfill({ status: 404, body: '' }));
    else if (served) await page.route('**/live/latest.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(served) }));
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && !PHOTOS.test(r.url()) && fail(`external request ${r.url()}`));
    // The missing file's 404 is logged by the browser itself; nothing else may be.
    page.on('console', (m) => m.type() === 'error' && !(served === 404 && /404/.test(m.text())) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    let liveFetched = false;
    page.on('request', (r) => /\/live\/latest\.json/.test(r.url()) && (liveFetched = true));
    // A screenshot waits for a frame, and a software-GL frame can take 10-25 s on a busy runner (rerun timed out at 30 s).
    const shotL = (step) => page.screenshot({ path: `${out}/live-${label.replace(/\W+/g, '-')}-${step}.png`, timeout: 60000 });
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
      // Past 30 September the nightly runs have stopped for the year: it says the season is over, never an age that
      // reads as a broken feed. In season it says how fresh the data is.
      const said = (await badge.textContent()) ?? '';
      if (label === 'off-season pick') {
        if (said !== 'season over') fail(`off-season the badge reads "${said}", not "season over"`);
        if (!/season ended Sep 30/.test((await badge.getAttribute('title')) ?? '')) fail(`off-season the badge's title reads "${await badge.getAttribute('title')}"`);
      } else if (query.includes(inSeason) && /season over|days old/.test(said)) fail(`in season the badge reads "${said}"`);
      // A feed that is late in season keeps its warning.
      if (label === 'late file' && !/stale/.test(said)) fail(`a late file's badge reads "${said}", with no stale warning`);
      // The address bar follows the view on a throttle; a software-GL page can take seconds per frame, so wait for it.
      await page.waitForFunction(() => new URLSearchParams(location.search).get('season') === 'live', null, { timeout: 10000, polling: 250 })
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
      await page.waitForFunction(() => window.__hatch.luna.res() > 4, null, { timeout: 60000 }).catch(() => {});
      if ((await page.evaluate(() => window.__hatch.luna.res())) <= 4) fail('live mode stayed on the big hexagons when zoomed in');
      if (label === 'in-season default') {
        // About panel: the live card and the weather credits.
        await page.locator('#info-btn').click({ timeout: 90000 });
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
        // Back out to the whole Midwest first. Zoomed in, each species switch redraws the fine hexagons, and on software GL
        // (CI) one frame can take 10-25 s; a click waits for two frames, so the picker's rows timed out at 30 s.
        await page.evaluate(() => window.__hatch.map.fit(window.__hatch.padding()));
        await page.waitForFunction(() => window.__hatch.luna.res() <= 4, null, { timeout: 60000 }).catch(() => fail('live mode stayed on the fine hexagons after zooming out'));
        // The firefly has a part in the served file: picking it from live mode stays live, and its menu offers live.
        // The beetle has none: it lands on all years, its menu has no live option, and says why at the top.
        if (await page.locator('#species').isVisible()) {
          await pickSpecies(page, 'firefly');
          await page.waitForFunction(() => window.__hatch.current().id === 'firefly-replay', null, { timeout: 60000 }).catch(() => fail('the firefly never loaded'));
          await page.waitForTimeout(800);
          if ((await page.locator('#season').inputValue()) !== 'live') fail(`firefly from live mode opened on ${await page.locator('#season').inputValue()}`);
          if (!(await page.locator('#season option[value=live]').count())) fail('the firefly season menu does not offer live mode');
          // Entering live mode lands on the species' own as-of day (its part of the file can run to another day than luna's).
          const ffAsOf = someSpecies.species?.firefly?.as_of;
          const ffDate = ffAsOf && new Date(Date.parse(ffAsOf)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
          if (ffDate && (await page.locator('#t-date').textContent()) !== ffDate)
            fail(`firefly live mode opened on ${await page.locator('#t-date').textContent()}, not its as-of day ${ffDate}`);
          await pickSpecies(page, 'japanese-beetle');
          await page.waitForFunction(() => window.__hatch.current().id === 'japanese-beetle-replay', null, { timeout: 60000 }).catch(() => fail('the beetle never loaded'));
          await page.waitForTimeout(800);
          if ((await page.locator('#season').inputValue()) !== 'typical') fail(`the beetle (no live entry) from live mode opened on ${await page.locator('#season').inputValue()}`);
          if (await page.locator('#season option[value=live]').count()) fail('the beetle season menu offers live mode without a live entry');
          if (!/not for .* yet/.test((await page.locator('#season option[disabled]').first().textContent().catch(() => '')) ?? ''))
            fail('the beetle season menu does not say live mode is not there for it yet');
          await pickSpecies(page, 'luna');
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
    const ctx = await settledContext(browser, { viewport: { width, height }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && !PHOTOS.test(r.url()) && fail(`external request ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const shotS = (step) => page.screenshot({ path: `${out}/species-${label.replace(/\W+/g, '-')}-${step}.png` });
    try {
      await page.goto(origin + '/?species=japanese-beetle&noauto&today=2027-01-15&date=07-05');
      await page.waitForFunction(() => window.__hatch.current().id === 'japanese-beetle-replay', null, { timeout: 30000 })
        .catch(() => fail('a ?species=japanese-beetle link never opened on the beetle'));
      await page.waitForTimeout(1500);
      await page.locator('#species').click();
      const keys = await page.locator('#sp-list .sp-feat').evaluateAll((bs) => bs.map((b) => b.dataset.key));
      await page.keyboard.press('Escape');
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
        await pickSpecies(page, k);
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

  // The Living Atlas (src/atlas/), over http in Chromium: a ?species= link to any Atlas species draws its field and
  // its photos as dots, the network in the page matches PyTorch's numbers (scripts/atlas-net.fixture.json) and the
  // graphics card matches the plain network, the picker finds a species by name and opens it, the season menu offers 2026, and a pinned card's
  // "out here now" switches species.
  const atlasFixture = JSON.parse(readFileSync('scripts/atlas-net.fixture.json', 'utf8'));
  const atlasUnit = async (browser) => {
    const tag = 'atlas';
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && !PHOTOS.test(r.url()) && fail(`external request ${r.url()}`));
    // A species photo can fail to load (offline, or iNaturalist slow): the page shows a blank square, which is fine.
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    // A record for the visual review, not a check: software GL in CI can keep the page busy past the screenshot's
    // timeout while the network fills the map, which must not fail the checks around it.
    const shotA = (step) => page.screenshot({ path: `${out}/atlas-${step}.png`, timeout: 60000 })
      .catch((e) => console.log(`atlas-${step} screenshot skipped: ${e.message.split('\n')[0]}`));
    const isOn = (id) => page.waitForFunction((id) => window.__hatch.current().id === id, id, { timeout: 30000 }).then(() => true, () => false);
    const clearSpot = (box) => clearSpotOn(page, box);
    try {
      await page.goto(origin + '/?species=papilio-glaucus&noauto&date=08-01');
      if (!(await isOn('papilio-glaucus-atlas'))) fail('a ?species=papilio-glaucus link never opened the Atlas swallowtail');
      await page.waitForTimeout(4000);
      const drawn = await page.evaluate(() => {
        const h = window.__hatch;
        const hex = h.current().render({ t: h.time.cursor, zoom: 5, theme: { bg: '#000', hexEdge: [0, 0, 0, 0], text: '#000' } }).find((l) => /-forecast-r4$/.test(l.id));
        return hex ? hex.props.data.filter((d) => hex.props.getFillColor(d)[3] > 0).length : 0;
      });
      if (drawn < 300) fail(`only ${drawn} coloured cells on 1 August`);
      // Its real photos as dots (dots/<i>.bin): a typical year's 1 August has hundreds of tiger swallowtails lit.
      const lit = await page.waitForFunction(() => window.__hatch.current().points(window.__hatch.time.cursor).length, null, { timeout: 10000 })
        .then((h) => h.jsonValue(), () => 0);
      if (lit < 50) fail(`only ${lit} photo dots lit on 1 August`);
      await shotA('1-field');
      const net = await page.evaluate(async (cases) => {
        const a = await window.__hatch.atlas();
        let worst = 0;
        for (const c of cases) {
          const got = a.net.logShares(c, c.day, c.ahead);
          for (const [i, want] of c.top) worst = Math.max(worst, Math.abs(got[i] - want));
        }
        let gpu = null;
        if (a.gpu) {
          const n = 40;
          const P = a.net.placeDim;
          const ahead = Float32Array.from({ length: n }, (_, k) => (k % 9) * 3 - 12);
          const [got] = a.gpu.run(a.places.subarray(0, n * P), 175, ahead, [3]);
          gpu = 0;
          for (let k = 0; k < n; k++) gpu = Math.max(gpu, Math.abs(got[k] - a.net.logShares(a.cells[k], 175, ahead[k])[3]));
        }
        return { worst, gpu };
      }, atlasFixture);
      console.log(`${tag}: network vs PyTorch ${net.worst.toExponential(1)}, graphics card vs network ${net.gpu?.toExponential(1) ?? 'no WebGL2 floats'}`);
      if (!(net.worst < 1e-3)) fail(`the page's network is off PyTorch's by ${net.worst}`);
      if (net.gpu !== null && !(net.gpu < 2e-3)) fail(`the graphics-card network is off the plain one by ${net.gpu}`);
      // Find one by name.
      await page.locator('#species').click();
      await page.locator('#sp-q').fill('black swallow');
      await page.locator('#sp-list [data-key="papilio-polyxenes"]').waitFor({ timeout: 10000 }).catch(() => fail('searching "black swallow" did not list the black swallowtail'));
      await shotA('2-search');
      await page.locator('#sp-list [data-key="papilio-polyxenes"]').click();
      if (!(await isOn('papilio-polyxenes-atlas'))) fail('picking the black swallowtail did not open it');
      // As long as isOn's: software GL in CI can keep the page busy drawing the new field past the address bar's timer.
      await page.waitForFunction(() => new URL(location.href).searchParams.get('species') === 'papilio-polyxenes', null, { timeout: 30000, polling: 250 })
        .catch(() => fail(`the link dropped the species: ${page.url()}`));
      if ((await page.locator('#app.atlas').count()) !== 1) fail('the page is not in Atlas mode (its caveat line)');
      // The tree of life (src/ui/treeOfLife.ts): it draws, the arrow keys climb from the whole tree into the biggest
      // branch down to one species, and its card's button opens that species.
      await page.locator('#species').click();
      await page.locator('#sp-q').fill('');
      const canvas = page.locator('.tol-canvas');
      await canvas.waitFor({ timeout: 10000 }).catch(() => fail('the tree of life never showed'));
      // The branches grow in: wait for the whole tree rather than a fixed time.
      await page.waitForFunction(() => Number(document.querySelector('.tol-canvas')?.getAttribute('data-branches')) > 1500, null, { timeout: 8000, polling: 200 }).catch(() => {});
      const branches = Number(await canvas.getAttribute('data-branches'));
      if (!(branches > 1500)) fail(`the tree of life drew ${branches} branches, not the whole tree`);
      // In season: the tips out on the map's day glow, and a note counts them (any number, the day may be winter).
      await page.waitForFunction(() => document.querySelector('.tol-canvas')?.hasAttribute('data-out'), null, { timeout: 8000, polling: 200 })
        .catch(() => fail('the tree never marked which species are out'));
      if (!/^[\d,]+ out on \w+ \d+$/.test((await page.locator('.tol-out').textContent()) ?? '') || !(await page.locator('.tol-out').isVisible()))
        fail(`the tree's in-season note reads "${await page.locator('.tol-out').textContent()}"`);
      await shotA('2b-tree');
      await canvas.focus();
      let steps = 0;
      while ((await page.locator('.tol-go').textContent()) !== 'Show on map' && steps++ < 14) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(150);
      }
      const crumbs = await page.locator('.sp-crumbs button').count();
      if (crumbs < 3) fail(`climbing the tree left only ${crumbs} breadcrumb steps`);
      const title = await page.locator('.tol-card b').textContent();
      await shotA('2c-tree-species');
      await page.locator('.tol-go').click();
      await page.waitForFunction((t) => document.querySelector('#species')?.getAttribute('aria-label')?.includes(t), title, { timeout: 30000 })
        .catch(() => fail(`"Show on map" for ${title} did not switch to it`));
      // The year's surprises, a second strip over the tree: one opens on 2026, the year it surprised.
      await page.locator('#species').click();
      const odd = page.locator('#sp-odd [data-season="2026"]').first();
      await odd.waitFor({ timeout: 10000 }).catch(() => fail('the species picker shows no 2026 surprises'));
      await shotA('2d-surprises');
      // No periodical cicada (a brood's off-year) and no near-zero shortfall (seen.py surprises): none of Magicicada.
      const oddKeys = await page.locator('#sp-odd [data-key]').evaluateAll((els) => els.map((e) => e.dataset.key));
      if (oddKeys.some((k) => k.startsWith('magicicada-'))) fail(`the 2026 surprises list a periodical cicada: ${oddKeys.join(', ')}`);
      const oddKey = await odd.getAttribute('data-key');
      await odd.click();
      if (!(await isOn(`${oddKey}-atlas`))) fail(`the first 2026 surprise (${oddKey}) did not open`);
      await page.waitForFunction(() => window.__hatch.current().mode() === '2026', null, { timeout: 25000, polling: 250 })
        .catch(() => fail('a 2026 surprise did not open on 2026'));
      // 2026, with its real warmth.
      if (!(await page.locator('#season option[value="2026"]').count())) fail('the season menu does not offer 2026');
      else {
        await page.locator('#season').selectOption('2026');
        await page.waitForFunction(() => window.__hatch.current().mode() === '2026', null, { timeout: 25000 }).catch(() => fail('2026 never took'));
      }
      // Warm the spring: +3 °F reruns the season (a spring bug comes out sooner), the link keeps it, a ?warm= link
      // reopens it, and closing it puts spring back as it was.
      const ink = () => page.evaluate(() => {
        const h = window.__hatch;
        const hex = h.current().render({ t: h.time.cursor, zoom: 5, theme: { bg: '#000', hexEdge: [0, 0, 0, 0], text: '#000' } }).find((l) => /-forecast-r4$/.test(l.id));
        return hex ? hex.props.data.reduce((a, d) => a + Math.max(0, hex.props.getFillColor(d)[3] - 90), 0) : 0;
      });
      await page.goto(origin + '/?species=poecilocapsus-lineatus&noauto&date=05-20');
      await isOn('poecilocapsus-lineatus-atlas');
      await page.waitForTimeout(3000);
      const before = await ink();
      await page.locator('#warm').click();
      await page.locator('#warm-in').fill('3');
      await page.locator('#warm-in').dispatchEvent('input');
      await page.waitForFunction(() => /earlier/.test(document.getElementById('warm-out').textContent), null, { timeout: 90000 })
        .catch(async () => fail(`+3 °F never said "earlier": "${await page.locator('#warm-out').textContent()}"`));
      await page.waitForTimeout(3000);
      const after = await ink();
      if (!(after > before * 1.04)) fail(`+3 °F did not bring the four-lined plant bug out sooner on 20 May (ink ${before} -> ${after})`);
      await shotA('4-warm');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('warm') === '3', null, { timeout: 5000, polling: 250 })
        .catch(() => fail(`the link dropped the warmth: ${page.url()}`));
      await page.goto(origin + '/?species=poecilocapsus-lineatus&noauto&date=05-20&warm=-2');
      await isOn('poecilocapsus-lineatus-atlas');
      await page.waitForFunction(() => /later/.test(document.getElementById('warm-out').textContent), null, { timeout: 30000 })
        .catch(() => fail('a ?warm=-2 link did not open spring 2 °F cooler'));
      await page.locator('#warm-row .warm-x').click();
      if ((await page.locator('#warm-in').inputValue()) !== '0' || !(await page.locator('#warm-row').isHidden())) fail('closing the slider left spring warmed');
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('warm'), null, { timeout: 5000, polling: 250 })
        .catch(() => fail('closing the slider left ?warm= in the link'));
      // Expected vs seen: 2026 draws the photos seen against the ones expected on the time bar, and the card says how
      // the year went (spotted lanternflies: far more than expected, still spreading west).
      await page.goto(origin + '/?species=lycorma-delicatula&noauto&year=2026&date=09-10');
      await isOn('lycorma-delicatula-atlas');
      // The year's photo counts land while the first field is worked out, which holds the page's one thread for seconds
      // a step on software GL: on a busy runner they can draw 20 s+ after the request (they did, and failed at 20 s).
      await page.locator('#bar .ribbon .seen-only').waitFor({ state: 'attached', timeout: 60000 })
        .catch(() => fail('2026 drew no photos seen on the time bar'));
      if (!(await page.locator('#strip .vs-note').isVisible())) fail('the time bar draws expected vs seen with no key saying which is which');
      const ohio = await clearSpot([-84.5, 39.5, -81, 41.5]);
      await page.mouse.click(ohio[0], ohio[1]);
      await page.waitForFunction(() => /Across the map in 2026: \d+(\.\d)?× as many photos as expected/.test(document.getElementById('probe').textContent), null, { timeout: 10000 })
        .catch(async () => fail(`the 2026 card does not say how the year went: "${await page.locator('#probe').innerText()}"`));
      await shotA('5-seen');
      // A pinned card names others out here; one tap switches to it.
      await page.goto(origin + '/?species=papilio-glaucus&noauto&date=08-01');
      await isOn('papilio-glaucus-atlas');
      await page.waitForTimeout(3000);
      const at = await clearSpot([-89.5, 40.5, -87.75, 42]);
      await page.mouse.click(at[0], at[1]);
      const other = page.locator('#probe .probe-others [data-species]').first();
      await other.waitFor({ timeout: 60000 }).catch(() => fail('the pinned card lists no "out here now"'));
      await shotA('3-card');
      const want = await other.getAttribute('data-species');
      await other.click();
      await page.waitForFunction((k) => window.__hatch.current().id.startsWith(`${k}-`) || (k === 'danaus-plexippus' && window.__hatch.current().id.startsWith('monarch-')), want, { timeout: 30000 })
        .catch(() => fail(`tapping ${want} on the card did not switch to it`));
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
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
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
      // "Coming out near you": the town found gets a countdown line (15 January: luna's season is months off), kept
      // for the next visit; its cross forgets it.
      const near = async () => ((await page.locator('#near').isVisible()) ? await page.locator('#near-go').textContent() : null);
      if (!/^Near Springfield: luna moths in \d+ days \(\w+\u00A0\d+\)$/.test((await near()) ?? '')) fail(`after finding Springfield the near line reads ${JSON.stringify(await near())}`);
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
      // The last town found is kept for the next visit, and speaks for whichever species is on screen; its cross forgets it.
      await page.goto(origin + '/?noauto&today=2027-01-15&species=papilio-glaucus');
      // (Luna's line shows first, while the swallowtail loads.)
      await page.waitForFunction(() => /Swallowtails/.test(document.getElementById('near-go').textContent), null, { timeout: 30000, polling: 250 }).catch(() => {});
      if (!/^Near Cincinnati: Eastern Tiger Swallowtails in \d+ days/.test((await near()) ?? '')) fail(`on the next visit, the swallowtail's near line reads ${JSON.stringify(await near())}`);
      await page.locator('#near-x').click();
      if ((await page.locator('#near').isVisible()) || (await page.evaluate(() => localStorage.getItem('hatch-place')))) fail('the near line\'s cross did not forget the place');
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
  // Per event: the radar, and its time zone and month.
  const RADARS = {
    'karx-2014-07-20': { at: [-91.19, 43.82], when: /\b\d{1,2}:\d\d (am|pm) CDT\b[\s\S]*July 2014/ },
    'kdvn-2012-06-23': { at: [-90.58, 41.61], when: /\b\d{1,2}:\d\d (am|pm) CDT\b[\s\S]*June 2012/ },
    'kcle-2019-06-26': { at: [-81.86, 41.41], when: /\b\d{1,2}:\d\d (am|pm) EDT\b[\s\S]*June 2019/ },
  };
  const ERIE = 'kcle-2019-06-26';
  const QC = 'kdvn-2012-06-23';
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
    ['desktop', 1366, 768, false, false, 'karx-2014-07-20', true], ['desktop, Lake Erie', 1366, 768, false, false, ERIE, true], ['desktop, Quad Cities', 1366, 768, false, false, QC, true],
  ]) {
    const ev = RADARS[id];
    const tag = `radar ${label}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const reused = !!carry && carry.phone === phone && !reduce;
    if (carry && !reused) await carry.ctx.close();
    const { ctx, page, fetched, state } = reused ? carry : await (async () => {
      const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
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
      }, ev.at, { timeout: 30000, polling: 300 }).catch(async () => fail(`the map did not go to the radar: ${JSON.stringify(await view())}`));
      await settled();
      // Drawn: the echo, its range rings and the dish (no paper sheet by day: the Giant Mayfly's field shows through,
      // dimmed). The species that was on screen is not part of the replay, so its hexagons are out of sight (map.ts); the
      // Giant Mayfly's field is the map's now (ONLY=radarmayfly). The frames arrive on their own beat, which can lag the
      // glide on a runner with software GL.
      const hexesDrawn = () => page.evaluate(() => window.__hatch.map.drawn().filter((id) => /-(forecast|unseen)-r\d/.test(id) && !id.startsWith('hexagenia-limbata-')));
      const radarDrawn = () => page.waitForFunction(() => ['radar-frame', 'radar-rings', 'radar-site'].every((id) => window.__hatch.map.drawn().includes(id)),
        null, { timeout: 30000, polling: 400 }).then(() => true, () => false);
      if (!(await radarDrawn())) fail(`the radar is not drawn: ${(await page.evaluate(() => window.__hatch.map.drawn())).filter((id) => id.startsWith('radar')).join(', ')}`);
      await shotR('1-open');
      const under = await hexesDrawn();
      if (under.length) fail(`forecast hexagons drawn under the replay: ${under.join(', ')}`);
      // Nor is the replay that species' season: the season menu steps aside while it is up.
      if (await page.locator('#season').isVisible()) fail('the season menu stays up over the replay');
      // The title stays plain (no species sketch beside it; a phone gives its room to the species' name, as always).
      if ((!phone && !(await page.locator('.brand').isVisible())) || (await page.locator('.brand .mark').isVisible())) fail('over the replay the title is missing or still wears the species sketch');
      const t0 = await page.locator('#radar .rd-time').textContent();
      const moving = await page.waitForFunction((t) => document.querySelector('#radar .rd-time')?.textContent !== t, t0, { timeout: reduce ? 4000 : 30000, polling: 250 })
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
      // Night (src/radar/night.ts): the button turns on the dark sky and simulated dots, the caveat shows, the link follows, the
      // zoom may go in past town scale. It stays on through ×, which must still bring the Midwest back.
      if (!reduce && !phone) {
        await page.locator('#radar .rd-night').click();
        await page.waitForFunction(() => document.querySelector('#radar .rd-night')?.getAttribute('aria-pressed') === 'true', null, { timeout: 30000, polling: 300 }).catch(() => fail('Night did not turn on'));
        if (!(await page.locator('#radar .rd-sim').isVisible())) fail('Night does not say its dots are simulated');
        if (!(await page.locator('#radar .rd-spark').isVisible())) fail('Night shows no echo line');
        await page.waitForFunction(() => new URL(location.href).searchParams.get('night') === '1', null, { timeout: 5000, polling: 300 }).catch(() => fail('the link does not say night'));
        if (!fetched.some((p) => p.endsWith(`/radar/${id}/wind.json`))) fail('Night never fetched the wind');
        await page.evaluate((at) => window.__hatch.map.view(at, 12), ev.at);
        if (((await page.evaluate(() => window.__hatch.map.zoom())) ?? 0) < 11) fail('Night does not zoom in past town scale');
        await shotR('2b-night');
      }
      await page.locator('#radar .rd-x').click();
      if (await page.locator('#radar').count()) fail('× did not close the replay');
      // Back at the whole-Midwest fit: not just flagged as fitted, but drawn at the fit's zoom once the glide is done.
      await page.waitForFunction(() => window.__hatch.map.moved() === false && Math.abs(window.__hatch.map.zoom() - window.__hatch.map.fitZoom()) < 0.05, null, { timeout: 30000, polling: 300 })
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
      if (!(await page.locator('#season').isVisible())) fail('the season menu did not come back');
      if (!(await hexesDrawn()).length) fail('the forecast hexagons did not come back after the replay');
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
    const ctx = reuse?.ctx ?? (await settledContext(browser, { viewport: { width: 1366, height: 768 } }));
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
      await page.locator(`#drawer .ex-radar[data-radar="${QC}"]`).click();
      if (!(await at(QC))) fail('switching did not go to the Quad Cities');
      if ((await page.locator('#radar').count()) !== 1) fail('more than one replay card after switching to the Quad Cities');
      const qcCap = await page.locator('#radar .rd-cap').innerText();
      if (!/CDT/.test(qcCap) || !/June 2012/.test(qcCap)) fail('the card after switching is not the Quad Cities\'');
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
      await shotCdp(page, `${out}/radar-switch-race.png`);
      const drawn = await page.waitForFunction(() => ['radar-frame', 'radar-rings', 'radar-site'].every((id) => window.__hatch.map.drawn().includes(id)),
        null, { timeout: 30000, polling: 400 }).then(() => true, () => false);
      if (!drawn) fail('of two quick clicks, the replay is gone from the map');
      await page.locator('#radar .rd-x').click();
      if (!(await home())) fail('× after two quick clicks did not bring the Midwest back');
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  }
  };
  // The watch list (src/ui/watch.ts), over http with the Atlas: the star in the species sheet toggles, three species can be
  // watched and each shows in the Watching row with a countdown, the list survives a reload, a cross removes one, the
  // list stops at 12, and a missing, mangled or blocked localStorage never breaks the page. Desktop and phone.
  const watchUnit = async ([w, h, phone], browser) => {
    const tag = `watch ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && !PHOTOS.test(r.url()) && fail(`external request ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const shotW = (step) => page.screenshot({ path: `${out}/watch-${phone ? 'phone' : 'desktop'}-${step}.png`, timeout: 60000 })
      .catch((e) => console.log(`watch-${step} screenshot skipped: ${e.message.split('\n')[0]}`));
    const KEY = 'hatch-watch';
    const stored = () => page.evaluate((k) => localStorage.getItem(k), KEY);
    const chips = () => page.locator('#sp-watch .sp-go');
    const star = page.locator('.sp-star');
    const open = async () => {
      await page.locator('#species').click();
      await page.locator('#species-sheet').waitFor({ state: 'visible' });
    };
    const go = async (key) => {
      await page.goto(`${origin}/?noauto&today=2027-01-15&date=08-01${key ? `&species=${key}` : ''}`);
      if (key) await page.waitForFunction((k) => window.__hatch?.current?.().id === `${k}-atlas`, key, { timeout: 30000 }).catch(() => fail(`${key} never opened`));
      await page.waitForTimeout(1200);
    };
    try {
      await go('papilio-glaucus');
      await page.evaluate((k) => localStorage.removeItem(k), KEY);
      await page.reload();
      await page.waitForTimeout(1500);
      await open();
      if ((await star.getAttribute('aria-pressed')) !== 'false') fail('the star starts on');
      // Nothing watched: no chips, just the one line on what the star does (once the tree is in).
      if (await chips().count()) fail('the Watching row shows chips with nothing watched');
      await page.locator('#sp-watch .sp-none').waitFor({ timeout: 15000 }).catch(() => fail('with nothing watched, the Watching row does not say how to add one'));
      await page.keyboard.press('Escape');
      // Three species, one after another, each from its own page (the list is the only thing that carries over).
      const three = ['papilio-glaucus', 'papilio-polyxenes', 'poecilocapsus-lineatus'];
      for (const k of three) {
        if (k !== three[0]) await go(k);
        await open();
        // Keyboard operable: focus the star and press Enter.
        await star.focus();
        await page.keyboard.press('Enter');
        // A toggle button: aria-pressed carries the state, the label stays "Watch ..." (never "Stop watching": a double negative when pressed).
        if ((await star.getAttribute('aria-pressed')) !== 'true' || !/^Watch /.test((await star.getAttribute('aria-label')) ?? '')) fail(`${k}: Enter on the star did not watch it, or its label stopped reading "Watch ..."`);
        await page.keyboard.press('Escape');
      }
      if ((await stored()) !== JSON.stringify([...three].reverse())) fail(`the watch list saved as ${await stored()}`);
      // Back on a different species, the sheet lists all three with a countdown each. A saved place too: the chip of the
      // species on screen counts down to the very season the line under the map names.
      await page.evaluate(() => localStorage.setItem('hatch-place', JSON.stringify({ name: 'Chicago, IL', lat: 41.88, lng: -87.63 })));
      await go('papilio-glaucus');
      await open();
      await page.waitForFunction(() => document.querySelectorAll('#sp-watch .sp-go').length === 3, null, { timeout: 10000 })
        .catch(async () => fail(`the Watching row shows ${await chips().count()} of 3 species after a reload`));
      // Their countdowns arrive once season.bin is in.
      await page.waitForFunction(() => [...document.querySelectorAll('#sp-watch .sp-go span')].every((s) => /^out (now|in \d+ days?)$/.test(s.textContent)), null, { timeout: 15000 })
        .catch(async () => fail(`the Watching countdowns read ${JSON.stringify(await page.locator('#sp-watch .sp-go span').allTextContents())}`));
      if ((await star.getAttribute('aria-pressed')) !== 'true') fail('the star is not on for a watched species after a reload');
      const row = await page.locator('#sp-watch').boundingBox();
      if (!row || row.x < 0 || row.x + row.width > w + 1 || row.height > 70) fail(`the Watching row is ${row ? `${Math.round(row.width)}x${Math.round(row.height)}` : 'missing'}, not a compact strip`);
      for (const c of await chips().all()) {
        const b = await c.boundingBox();
        if (!b || b.height < 36) fail('a Watching chip is under 36 px tall');
      }
      await page.waitForTimeout(600);
      await shotW('1-picker');
      // Dark mode.
      await page.evaluate(() => document.getElementById('theme-btn').click());
      await page.waitForTimeout(500);
      await shotW('2-picker-dark');
      await page.evaluate(() => document.getElementById('theme-btn').click());
      // Keyboard focus on a chip's cross survives a re-render of the row (the search box's input event redraws it).
      await page.locator('#sp-watch [data-unwatch="papilio-glaucus"]').focus();
      await page.evaluate(() => document.getElementById('sp-q').dispatchEvent(new Event('input')));
      if ((await page.evaluate(() => document.activeElement?.dataset.unwatch)) !== 'papilio-glaucus') fail('a re-render of the Watching row dropped focus from a chip\'s cross');
      // A chip opens its species; with a saved place, that chip and the line under the map then say the same.
      await page.locator('#sp-watch [data-key="papilio-polyxenes"]').click();
      await page.waitForFunction(() => window.__hatch?.current?.().id === 'papilio-polyxenes-atlas', null, { timeout: 30000 }).catch(() => fail('a Watching chip did not open its species'));
      await page.locator('#near').waitFor({ state: 'visible', timeout: 30000 }).catch(() => fail('the saved place\'s line did not show'));
      await open();
      const chipSays = (await page.locator('#sp-watch [data-key="papilio-polyxenes"] span').textContent()) ?? '';
      const chipTitle = await page.locator('#sp-watch [data-key="papilio-polyxenes"]').getAttribute('title');
      const lineSays = (await page.locator('#near-go').textContent()) ?? '';
      const agree = chipSays === 'out now' ? / out now/.test(lineSays) : lineSays.includes(` ${chipSays.replace(/^out /, '')} (`);
      if (!agree || chipTitle !== 'Season at your saved place') fail(`the on-screen species' chip ("${chipSays}", ${chipTitle}) and the line under the map ("${lineSays}") disagree`);
      // A cross removes one, and the store follows.
      await page.evaluate(() => localStorage.removeItem('hatch-place'));
      await page.locator('#sp-watch [data-unwatch="poecilocapsus-lineatus"]').click();
      if ((await chips().count()) !== 2) fail('the chip\'s cross did not remove it');
      if ((await stored()) !== JSON.stringify(['papilio-polyxenes', 'papilio-glaucus'])) fail(`after a cross the watch list saved as ${await stored()}`);
      // The cap: twelve other species fill it, a thirteenth is refused with a note.
      const names = await page.evaluate(async () => (await (await fetch('atlas/species.json')).json()).slice(0, 30).map((s) => s.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')));
      await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, names.filter((n) => !['papilio-polyxenes', 'actias-luna', 'photinus-pyralis', 'popillia-japonica', 'danaus-plexippus', 'vanessa-atalanta'].includes(n)).slice(0, 12)]);
      await go('papilio-polyxenes');
      await open();
      await page.waitForFunction(() => document.querySelectorAll('#sp-watch .sp-go').length === 12, null, { timeout: 10000 })
        .catch(async () => fail(`twelve saved species show ${await chips().count()} chips`));
      await star.click();
      if ((await star.getAttribute('aria-pressed')) !== 'false' || !/full/.test((await page.locator('#sp-wnote').textContent()) ?? '') || (await chips().count()) !== 12) fail('a thirteenth species was not refused');
      await shotW('3-full');
      // Missing, mangled and blocked storage: the page loads, the sheet opens, nothing is watched, nothing throws.
      for (const bad of ['{not json', '{"a":1}', '[1,null,"BAD KEY!",{}]', '"x"', '["gone-species"]']) {
        await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, bad]);
        await go('papilio-polyxenes');
        await open();
        await page.waitForTimeout(800);
        if (await chips().count()) fail(`with the saved list ${bad} the Watching row is not empty`);
        await star.click();
        if ((await star.getAttribute('aria-pressed')) !== 'true') fail(`with the saved list ${bad} the star does not work`);
      }
      const blocked = await ctx.newPage();
      blocked.on('pageerror', (e) => fail(`blocked storage: pageerror: ${e.message}`));
      await blocked.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', { get: () => { throw new DOMException('blocked', 'SecurityError'); } });
      });
      await blocked.goto(`${origin}/?noauto&today=2027-01-15`);
      await blocked.waitForTimeout(2500);
      await blocked.locator('#species').click();
      await blocked.locator('.sp-star').click();
      if ((await blocked.locator('.sp-star').getAttribute('aria-pressed')) !== 'true') fail('with storage blocked the star does not work for the visit');
      // A second species starred in the same visit joins the first instead of replacing it (a failed read is not an empty list).
      await blocked.locator('#sp-q').fill('papilio polyxenes');
      await blocked.waitForFunction(() => /match/.test(document.querySelector('.sp-crumbs')?.textContent ?? ''), null, { timeout: 15000 });
      await blocked.locator('#sp-q').press('Enter');
      await blocked.waitForFunction(() => window.__hatch?.current?.().id === 'papilio-polyxenes-atlas', null, { timeout: 30000 }).catch(() => fail('with storage blocked a searched species did not open'));
      await blocked.locator('#species').click();
      await blocked.locator('.sp-star').click();
      await blocked.waitForFunction(() => document.querySelectorAll('#sp-watch .sp-go').length === 2, null, { timeout: 10000 })
        .catch(async () => fail(`with storage blocked, starring a second species left ${await blocked.locator('#sp-watch .sp-go').count()} chips, not 2`));
      // And a cross removes only its own (the search box still holds the last search, which hides the row: clear it).
      await blocked.locator('#sp-q').fill('');
      await blocked.locator('#sp-watch [data-unwatch="papilio-polyxenes"]').click();
      if ((await blocked.locator('#sp-watch .sp-go').count()) !== 1) fail('with storage blocked, a cross did not leave the other species watched');
      if (!(await blocked.locator('#map').isVisible())) fail('with storage blocked the map is gone');
      await blocked.close();
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // The "fewer photos than expected" strip (seen-2026.json): chips read "seen of expected" photos, the caption says photos
  // and never declines, it fits the sheet, and a chip opens the species on 2026. Desktop and phone.
  const quietUnit = async ([w, h, phone], browser) => {
    const tag = `quiet ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    try {
      await page.goto(`${origin}/?noauto&today=2027-01-15`);
      await page.waitForTimeout(1500);
      await page.locator('#species').click();
      const chip = page.locator('#sp-quiet [data-season="2026"]');
      await chip.first().waitFor({ timeout: 15000 }).catch(() => fail('the species picker shows no quiet strip'));
      const n = await chip.count();
      if (n < 1 || n > 10) fail(`the quiet strip has ${n} chips`);
      const cap = (await page.locator('#sp-quiet .sp-lab').textContent()) ?? '';
      if (!/photos/i.test(cap) || /declin|decreas|fewer insects|abundan/i.test(cap)) fail(`the quiet strip's caption reads "${cap}"`);
      const notes = await page.locator('#sp-quiet .sp-n').allTextContents();
      if (!notes.length || notes.some((t) => !/^\d+ of \d+$/.test(t) || +t.split(' of ')[0] >= 0.6 * +t.split(' of ')[1])) fail(`the quiet chips read ${notes.join(' | ')}`);
      // Identifications lag: no chip may be a species whose typical season peaks in the six weeks before the file's
      // last day (QUIET_LATE_DAYS), whose photos are still waiting for IDs.
      const late = await page.evaluate(async (keys) => {
        const [bin, seen, sp] = await Promise.all([fetch('atlas/season.bin').then((r) => r.arrayBuffer()), fetch('atlas/seen-2026.json').then((r) => r.json()), fetch('atlas/species.json').then((r) => r.json())]);
        const b = new Uint8Array(bin), steps = 62;
        const key = (n) => n.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
        return keys.filter((k) => {
          const i = sp.findIndex((s) => key(s.name) === k);
          if (i < 0) return false;
          let pk = 0;
          for (let j = 1; j < steps; j++) if (b[i * 2 * steps + j] > b[i * 2 * steps + pk]) pk = j;
          return 60 + 4 * pk > seen.last_day - 42;
        });
      }, await chip.evaluateAll((els) => els.map((e) => e.dataset.key)));
      if (late.length) fail(`the quiet strip lists species whose season peaks too late for their IDs to be in: ${late.join(', ')}`);
      const tip = (await page.locator('#sp-quiet .sp-lab').getAttribute('title')) ?? '';
      if (!/identif/i.test(tip)) fail(`the quiet strip's tooltip doesn't say identifications are still coming in: "${tip}"`);
      const sb = await page.locator('#sp-quiet').boundingBox();
      const sh = await page.locator('#species-sheet').boundingBox();
      if (!sb || !sh || sb.x < sh.x - 1 || sb.x + sb.width > sh.x + sh.width + 1 || sb.y + sb.height > sh.y + sh.height + 1) fail('the quiet strip spills out of the species sheet');
      await page.screenshot({ path: `${out}/quiet-${phone ? 'phone' : 'desktop'}.png`, timeout: 60000 }).catch(() => {});
      const key = await chip.first().getAttribute('data-key');
      await chip.first().click();
      await page.waitForFunction((k) => window.__hatch.current().id === `${k}-atlas`, key, { timeout: 30000 }).catch(() => fail(`the first quiet species (${key}) did not open`));
      await page.waitForFunction(() => window.__hatch.current().mode() === '2026', null, { timeout: 25000 }).catch(() => fail('a quiet species did not open on 2026'));
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // The tree of life's group names and taps (src/ui/treeOfLife.ts): a group picked on the wheel goes by its English
  // name (tree.json "c", build_tree.py) with the Latin one on its crumb's tooltip and its card; a second tap on the
  // picked group zooms into it, and so does Enter (said in the live region); a quick double tap on the picked group
  // zooms into it once, not into whatever is under the finger mid-flight. On a phone the strips over the tree fold away
  // once it is touched, the wheel fills the room, and the whole tree brings them back; on a desktop they stay.
  // Desktop and phone; ONLY=tree runs just this, in every engine ENGINES names.
  const treeUnit = async ([w, h, phone], browser) => {
    const tag = `tree ${phone ? 'phone' : 'desktop'} ${browser.browserType().name()}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    await ctx.route(PHOTOS, (r) => r.abort());
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const tap = (x, y) => (phone ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
    const scale = () => page.locator('.tol-canvas').evaluate((c) => Number(c.dataset.scale));
    const strips = () => page.locator('#sp-list').isVisible();
    const card = () => page.locator('.tol-card:not([hidden]) b').textContent({ timeout: 10000 }).catch(() => null);
    const zoomedFrom = (s0, what) => page.waitForFunction((s) => Number(document.querySelector('.tol-canvas').dataset.scale) > s * 1.5, s0, { timeout: 5000, polling: 250 })
      .then(() => true, () => (fail(`${what} did not zoom in`), false));
    const settle = () => page.waitForTimeout(800); // a flight takes 520 ms
    try {
      await page.goto(`${origin}/?noauto&today=2027-01-15`);
      await page.locator('#species').click({ timeout: 60000 });
      await page.waitForFunction(() => Number(document.querySelector('.tol-canvas')?.dataset.branches) > 1500, null, { timeout: 30000, polling: 300 })
        .catch(() => fail('the tree of life never drew'));
      const names = await page.evaluate(async () => (await (await fetch('atlas/tree.json')).json()).c ?? {});
      if (Object.keys(names).length < 150) fail(`tree.json names only ${Object.keys(names).length} groups`);
      /** Touch the tree's empty edge (on a phone that folds the strips), then tap round the wheel until a group with an
       * English name is picked (its card offers "Zoom in"): where, and what. Each try starts from nothing picked (a tap
       * on the edge), so it never taps the picked group a second time. */
      const pickGroup = async () => {
        let box = await page.locator('.tol-canvas').boundingBox();
        const edge = () => tap(box.x + 8, box.y + box.height / 2).then(() => page.waitForTimeout(400));
        await edge();
        await settle();
        box = await page.locator('.tol-canvas').boundingBox();
        const [cx, cy, rad] = [box.x + box.width / 2, box.y + box.height / 2, Math.min(box.width, box.height) * 0.3];
        for (let k = 0; k < 36; k++) {
          const p = [cx + Math.cos((k / 36) * Math.PI * 2) * rad, cy + Math.sin((k / 36) * Math.PI * 2) * rad];
          if (k) await edge();
          await tap(...p);
          await page.waitForTimeout(400); // past the double-tap window, so each is a single tap
          const c = await page.evaluate(() => ({ go: document.querySelector('.tol-go')?.textContent, b: document.querySelector('.tol-card:not([hidden]) b')?.textContent, sub: document.querySelector('.tol-card span')?.textContent }));
          const latin = Object.keys(names).find((l) => names[l] === c.b);
          if (c.go === 'Zoom in' && latin) return { at: p, ...c, latin };
        }
        throw new Error('no tap on the wheel picked a group with an English name');
      };
      const toWhole = async () => {
        await page.locator('.sp-crumbs button').first().click();
        await settle();
      };
      let g = await pickGroup();
      if (!g.sub.includes(g.latin) || / in /.test(g.sub)) fail(`the card for ${g.b} reads "${g.sub}", not its count and Latin name`);
      const last = page.locator('.sp-crumbs button').last();
      if ((await last.textContent()) !== g.b || (await last.getAttribute('title')) !== g.latin)
        fail(`the last crumb reads "${await last.textContent()}" (title "${await last.getAttribute('title')}"), not ${g.b} (${g.latin})`);
      if (/idae$/.test(await page.locator('.sp-crumbs').textContent())) fail('a crumb still reads in Latin where an English name exists');
      if (!/iNaturalist/.test(await page.locator('.tol-src').textContent())) fail('the tree does not credit iNaturalist for its names');
      // Phone: the strips are folded and the whole wheel fills their room. Desktop: they never fold.
      const tb = await page.locator('.sp-tree').boundingBox();
      if (phone) {
        if (await strips()) fail('touching the tree left the strips over it');
        if (tb.height < h * 0.65) fail(`with its strips folded the tree has only ${Math.round(tb.height)} px of ${h}`);
        const whole = await scale();
        if (whole * 1000 < Math.min(tb.width, tb.height) * 0.38) fail(`with its strips folded the whole wheel is only ${Math.round(whole * 2000)} px across`);
      } else if (!(await strips())) fail('on a desktop the strips folded away');
      // A second tap on the picked group zooms into it.
      let s0 = await scale();
      await page.waitForTimeout(700); // well clear of the pick's own tap: software GL can hold an event back
      await tap(...g.at);
      if (await zoomedFrom(s0, `a second tap on ${g.b}`) && (await card()) !== g.b) fail(`the second tap moved the pick off ${g.b}`);
      await settle();
      await page.screenshot({ path: `${out}/tree-${phone ? 'phone' : 'desktop'}-${browser.browserType().name()}.png`, timeout: 60000 }).catch(() => {});
      // The whole tree again: on a phone the strips come back.
      await toWhole();
      if (phone && !(await strips())) fail('the whole tree did not bring the strips back');
      // Enter on the picked group zooms in, and the live region says so.
      if (!phone) {
        g = await pickGroup();
        s0 = await scale();
        await page.locator('.tol-canvas').focus();
        await page.keyboard.press('Enter');
        await zoomedFrom(s0, `Enter on ${g.b}`);
        if ((await page.locator('.tol-live').textContent()) !== `Zoomed to ${g.b}`) fail(`after Enter the live region reads "${await page.locator('.tol-live').textContent()}"`);
        await toWhole();
      }
      // A quick double tap on the picked group zooms into that group, once.
      g = await pickGroup();
      s0 = await scale();
      // Sent from inside the page (a driven tap can lag half a second in software GL): the first tap zooms into the
      // picked group, the second lands on the first frame the view has moved, mid-flight.
      await page.waitForTimeout(700);
      await page.evaluate(([[x, y], type]) => new Promise((done) => {
        const cv = document.querySelector('.tol-canvas');
        const tap = () => ['pointerdown', 'pointerup'].forEach((t) => cv.dispatchEvent(new PointerEvent(t, { pointerId: 9, pointerType: type, isPrimary: true, bubbles: true, clientX: x, clientY: y })));
        const s0 = Number(cv.dataset.scale);
        tap();
        let frames = 0;
        const next = () => (Number(cv.dataset.scale) > s0 * 1.02 || ++frames > 120 ? (tap(), done()) : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }), [g.at.map(Math.round), phone ? 'touch' : 'mouse']);
      await zoomedFrom(s0, `a double tap on ${g.b}`);
      await settle();
      if ((await card()) !== g.b) fail(`a double tap on the picked ${g.b} went on to ${await card()}`);
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // The "Flies with" strip (pickTwins over season.bin): three chips, never the species on the map, it fits the sheet, and
  // a chip opens that species, whose own strip then leaves it out. Desktop and phone. ONLY=twins runs just this.
  const twinsUnit = async ([w, h, phone], browser) => {
    const tag = `twins ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    try {
      await page.goto(`${origin}/?noauto&today=2027-01-15`);
      await page.waitForTimeout(1500);
      await page.locator('#species').click();
      const chip = page.locator('#sp-twins [data-key]');
      await chip.first().waitFor({ timeout: 15000 }).catch(() => fail('the species picker shows no "Flies with" strip'));
      const keys = await chip.evaluateAll((els) => els.map((e) => e.dataset.key));
      if (keys.length !== 3 || new Set(keys).size !== 3 || keys.includes('luna')) fail(`the luna moth's "Flies with" chips are ${keys.join(', ')}`);
      if (((await page.locator('#sp-twins .sp-lab').textContent()) ?? '') !== 'Flies with') fail('the strip is not captioned "Flies with"');
      const sb = await page.locator('#sp-twins').boundingBox();
      const sh = await page.locator('#species-sheet').boundingBox();
      if (!sb || !sh || sb.x < sh.x - 1 || sb.x + sb.width > sh.x + sh.width + 1 || sb.y + sb.height > sh.y + sh.height + 1) fail('the "Flies with" strip spills out of the species sheet');
      await page.waitForFunction(() => [...document.querySelectorAll('#sp-twins img')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {}); // lazy photos: in before the shot
      await page.screenshot({ path: `${out}/twins-${phone ? 'phone' : 'desktop'}.png`, timeout: 60000 }).catch(() => {});
      const key = keys[0];
      await chip.first().click();
      await page.waitForFunction((k) => [k, `${k}-atlas`].includes(window.__hatch.current().id), key, { timeout: 30000 }).catch(() => fail(`the first twin (${key}) did not open`));
      await page.waitForTimeout(500);
      await page.locator('#species').click();
      await page.waitForFunction((k) => {
        const ks = [...document.querySelectorAll('#sp-twins [data-key]')].map((e) => e.dataset.key);
        return ks.length === 3 && !ks.includes(k);
      }, key, { timeout: 15000 }).catch(() => fail(`after switching to ${key}, its "Flies with" strip is missing or lists itself`));
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // seasonsOf (src/atlas/index.ts), the one season rule for the watch chips and the line under the map, on synthetic
  // curves (no browser): a noisy shoulder dip and a stray tail stay one season; a real gap makes two broods, and the
  // countdown in the gap waits for the second one (src/ui/near.ts).
  const seasonsUnit = async () => {
    const fail = (m) => problems.push(`seasons: ${m}`);
    try {
      const { outputFiles } = require('esbuild').buildSync({
        stdin: { contents: "export { seasonsOf } from './src/atlas/index'; export { dueShort } from './src/ui/near';", resolveDir: resolve('.'), loader: 'ts' },
        bundle: true, write: false, format: 'esm', platform: 'node', define: { 'import.meta.env.BASE_URL': '"/"' }, logLevel: 'silent',
      });
      const { seasonsOf, dueShort } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
      const bell = (k, c, w, h) => h * Math.exp(-(((k - c) / w) ** 2));
      // One season (steps 8-40) whose rising shoulder dips under the line for two steps, plus a two-step stray tail.
      const noisy = Array.from({ length: 62 }, (_, k) => (k === 11 || k === 12 ? 2 : bell(k, 26, 8, 255) + (k >= 8 && k <= 40 ? 14 : 0)) + (k === 50 || k === 51 ? 16 + k - 50 : 0));
      const one = seasonsOf(noisy);
      if (one?.broods?.length !== 1) fail(`a noisy single season split into ${one?.broods?.length} broods: ${JSON.stringify(one?.broods)}`);
      // Two broods 40 days apart: spring (peak step 12) and a bigger summer one (peak step 36).
      const two = seasonsOf(Array.from({ length: 62 }, (_, k) => bell(k, 12, 3, 120) + bell(k, 36, 4, 255)));
      if (two?.broods?.length !== 2) fail(`a two-brood curve gave ${two?.broods?.length} broods: ${JSON.stringify(two?.broods)}`);
      else {
        const gap = Math.round((two.broods[0].end + two.broods[1].start) / 2);
        const want = two.broods[1].start - gap;
        const said = dueShort(two, Date.UTC(2026, 0, gap));
        if (said !== `out in ${want} days`) fail(`between broods (day ${gap}) the countdown reads "${said}", not "out in ${want} days"`);
        if (dueShort(two, Date.UTC(2026, 0, two.broods[0].peak)) !== 'out now') fail('in the spring brood the countdown does not read "out now"');
      }
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    console.log('seasons: checked');
  };
  // The weekly rebuild's year (pipeline/atlas/weekly.py): with a year.json naming 2027 and its files laid over main's
  // (here 2026's, served as 2027's, marked "so far"), the season menu, the picker's strips and the card all move to
  // 2027 on their own, and the card says its counts are so far, or too few yet to judge. ONLY=thisyear runs just this.
  const thisYearUnit = async (browser) => {
    const tag = 'this year';
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const isOn = (id) => page.waitForFunction((k) => window.__hatch.current().id === k, id, { timeout: 60000, polling: 250 });
    const file = (f) => readFileSync(join(distDir, 'atlas', f));
    const seen = JSON.parse(file('seen-2026.json'));
    const sp = JSON.parse(file('species.json'));
    const at = (name) => sp.findIndex((s) => s.name === name);
    seen.year = 2027;
    seen.so_far = true;
    seen.species[at('Poecilocapsus lineatus')] = [12, 9.4, null, null];
    await ctx.route('**/atlas/year.json', (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ year: 2027, so_far: true, warm_through: 120 }) }));
    await ctx.route('**/atlas/seen-2027.json', (rt) => rt.fulfill({ contentType: 'application/json', body: JSON.stringify(seen) }));
    await ctx.route('**/atlas/seen-2027.bin', (rt) => rt.fulfill({ body: file('seen-2026.bin') }));
    await ctx.route('**/atlas/ahead-2027.bin', (rt) => rt.fulfill({ body: file('ahead-2026.bin') }));
    try {
      await page.goto(`${origin}/?species=lycorma-delicatula&noauto&year=2027&date=09-10`);
      await isOn('lycorma-delicatula-atlas');
      await page.waitForFunction(() => window.__hatch.current().mode() === '2027', null, { timeout: 60000, polling: 250 }).catch(() => fail('a ?year=2027 link did not open on 2027'));
      const opts = await page.locator('#season option').evaluateAll((els) => els.map((e) => e.value));
      if (!opts.includes('2027') || opts.includes('2026')) fail(`the season menu offers ${opts.join(', ')}`);
      await page.locator('#bar .ribbon .seen-only').waitFor({ state: 'attached', timeout: 60000 }).catch(() => fail('2027 drew no photos seen'));
      const ohio = await clearSpotOn(page, [-84.5, 39.5, -81, 41.5]);
      await page.mouse.click(ohio[0], ohio[1]);
      await page.waitForFunction(() => /Across the map in 2027 so far \(1,760 photos\): \d+(\.\d)?× as many photos as expected/.test(document.getElementById('probe').textContent), null, { timeout: 60000, polling: 250 })
        .catch(async () => fail(`the 2027 card does not say its count is so far: "${await page.locator('#probe').innerText()}"`));
      await page.screenshot({ path: `${out}/thisyear-card.png`, timeout: 60000 }).catch(() => {});
      await page.goto(`${origin}/?species=poecilocapsus-lineatus&noauto&year=2027&date=05-25`);
      await isOn('poecilocapsus-lineatus-atlas');
      await page.waitForFunction(() => window.__hatch.current().mode() === '2027', null, { timeout: 60000, polling: 250 }).catch(() => fail('the plant bug did not open on 2027'));
      await page.locator('#bar .ribbon .seen-only').waitFor({ state: 'attached', timeout: 60000 }).catch(() => {});
      const mid = await clearSpotOn(page, [-90, 40.5, -86, 42.5]);
      await page.mouse.click(mid[0], mid[1]);
      await page.waitForFunction(() => /Across the map in 2027 so far \(12 photos\): too few yet to judge/.test(document.getElementById('probe').textContent), null, { timeout: 60000, polling: 250 })
        .catch(async () => fail(`a thin 2027 count is not "too few yet to judge": "${await page.locator('#probe').innerText()}"`));
      await page.locator('#species').click();
      await page.locator('#sp-odd [data-season]').first().waitFor({ timeout: 60000 }).catch(() => fail('the picker shows no surprises'));
      const seasons = new Set(await page.locator('#sp-odd [data-season], #sp-off [data-season], #sp-quiet [data-season]').evaluateAll((els) => els.map((e) => e.dataset.season)));
      if (seasons.size !== 1 || !seasons.has('2027')) fail(`the picker's strips open on ${[...seasons].join(', ')}`);
      const lab = (await page.locator('#sp-odd .sp-lab').textContent()) ?? '';
      if (lab !== '2027 surprises so far') fail(`the surprises strip reads "${lab}"`);
      if ((await page.locator('#sp-odd').getAttribute('aria-label')) !== '2027 surprises so far') fail('the surprises strip is not labelled for 2027 so far');
      const off = (await page.locator('#sp-off .sp-lab').textContent().catch(() => '')) ?? '';
      if (off && off !== '2027 so far: furthest off schedule') fail(`the off-schedule strip reads "${off}"`);
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // The usual years' band on the time bar (spread.py): a typical year shades where its peak usually falls, centred on it,
  // with its key line (swatch and words); two broods' shades never overlap; 2026 (expected vs seen) and a species with too few years of photos draw neither. Light and dark (the
  // phone in mobile.mjs). ONLY=band runs just this.
  const bandUnit = async ([w, h, phone], browser) => {
    const tag = `band ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    for (const scheme of ['light', 'dark']) {
      const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: scheme });
      const page = await ctx.newPage();
      page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
      page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
      const isOn = (id) => page.waitForFunction((k) => window.__hatch.current().id === k, id, { timeout: 60000 });
      try {
        await page.goto(`${origin}/?species=poecilocapsus-lineatus&noauto&date=05-25`);
        await isOn('poecilocapsus-lineatus-atlas');
        await page.locator('#bar .ribbon .range').waitFor({ state: 'attached', timeout: 20000 }).catch(() => fail('a typical year drew no band of usual years'));
        const p = await page.evaluate(() => window.__hatch.current().profile());
        // One band (one brood), a few days to a few weeks wide, around the peak the bar's note names.
        const pk = p.notes.find((k) => /^peak /.test(k.text))?.at;
        const r = p.range?.[0];
        if (p.range?.length !== 1 || !(r.to - r.from >= 6 && r.to - r.from <= 40)) fail(`the band is ${JSON.stringify(p.range)}`);
        else if (!(Math.abs((r.from + r.to) / 2 - pk) <= 0.5)) fail(`the band (${r.from}-${r.to}) is not centred on the peak (${pk})`);
        if (!(await page.locator('#bar .ribbon .range-edge').count())) fail('the band has no bracket marking its span');
        if (!(await page.locator('#strip .range-note').isVisible()) || !(await page.locator('#strip .range-note .range-key').isVisible())) fail('the band has no key line with a swatch');
        await page.waitForTimeout(1500);
        await page.screenshot({ path: `${out}/band-${phone ? 'phone' : 'desktop'}-${scheme}.png`, timeout: 60000 }).catch(() => {});
        if (scheme === 'dark') continue;
        // The first fetch of 2026's photos drops (as a reset connection would): the year asks again and still draws them.
        let dropped = 0;
        await page.route('**/seen-2026.bin', (rt) => (dropped++ ? rt.continue() : rt.abort('connectionreset')));
        await page.goto(`${origin}/?species=poecilocapsus-lineatus&noauto&year=2026&date=05-25`);
        await isOn('poecilocapsus-lineatus-atlas');
        await page.locator('#bar .ribbon .seen-only').waitFor({ state: 'attached', timeout: 60000 }).catch(() => fail(`2026 drew no photos seen (after ${dropped} tries)`));
        if (dropped < 2) fail(`the dropped fetch of 2026's photos was not tried again (${dropped} tries)`);
        await page.unroute('**/seen-2026.bin');
        if (await page.locator('#bar .ribbon .range').count()) fail('2026 (expected vs seen) still draws the usual years\' band');
        if (await page.locator('#strip .range-note').isVisible()) fail('2026 still shows the band\'s key line');
        // A two-brood skipper: a shade for each brood, in order, never overlapping (overlaps merge, never darken).
        await page.goto(`${origin}/?species=lon-zabulon&noauto&date=07-01`);
        await isOn('lon-zabulon-atlas');
        await page.locator('#bar .ribbon .range').first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => fail('the zabulon skipper drew no band'));
        const sw = (await page.evaluate(() => window.__hatch.current().profile())).range ?? [];
        if (sw.length !== 2 || sw[1].from <= sw[0].to) fail(`the zabulon skipper's two broods' shades are ${JSON.stringify(sw)}`);
        await page.goto(`${origin}/?species=forficula-auricularia&noauto&date=07-01`);
        await isOn('forficula-auricularia-atlas');
        await page.waitForTimeout(3000);
        if (await page.locator('#bar .ribbon .range').count()) fail('a species with too few years of photos draws a band');
      } catch (e) {
        fail(`stopped: ${e.message.split('\n')[0]}`);
      }
      await ctx.close();
    }
    console.log(`${tag}: checked`);
  };
  // "When is it out near me?": My area pins the card on Chicago (15 January, so the line under the map counts down to
  // the coming season). The card's one-line sparkline of the season here draws, one line high, and the card and that
  // line give one set of dates: every date either states is the sparkline's first, last or best day, and the countdown
  // names its first. A two-brood skipper shows both best days, in a typical year and in 2026 warmed 3 °F (the line
  // follows the card's season and warmth); the luna moth (no Atlas) has the same line, also zoomed in to its small
  // hexagons. While the card is pinned the time bar's Midwest "peak" note steps aside. Desktop and phone. Waits poll on
  // a timer (a software-GL frame can take 10-25 s). ONLY=near runs just this.
  const nearUnit = async ([w, h, phone], browser) => {
    const tag = `near ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, {
      viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
      geolocation: { latitude: 41.88, longitude: -87.63 }, permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const DATE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \u00A0]\d{1,2}\b/g;
    const norm = (d) => d.replace('\u00A0', ' ');
    const poll = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 120000, polling: 500 }).then(() => true, () => false);
    // The card and the line under the map, read together, and checked against each other.
    const check = async (what, peaks) => {
      // The line under the map follows the card on its next refresh: wait for both to be drawn.
      if (!(await poll(() => document.querySelector('#probe:not([hidden]) .probe-season svg polyline') && !document.getElementById('near').hidden))) {
        return fail(`${what}: no card with a season line, or no line under the map (card: ${JSON.stringify(await page.locator('#probe').innerText().catch(() => ''))})`);
      }
      // Both read one season, so they agree as soon as both are drawn; give a refresh after a late run a moment.
      await poll(() => {
        const first = document.querySelector('#probe .probe-season > span:not(.sr)')?.textContent;
        return first && document.getElementById('near-go').textContent.endsWith(`(${first})`);
      });
      const got = await page.evaluate(() => {
        const row = document.querySelector('#probe .probe-season');
        const svg = row.querySelector('svg').getBoundingClientRect();
        const line = parseFloat(getComputedStyle(row).lineHeight) || parseFloat(getComputedStyle(row).fontSize) * 1.4;
        const card = document.getElementById('probe').cloneNode(true);
        card.querySelectorAll('.sr, .probe-more').forEach((e) => e.remove());
        const peak = document.querySelector('#bar .wave.peak-note');
        return {
          row: [...row.children].filter((e) => !e.classList.contains('sr') && e.tagName !== 'svg').map((e) => e.textContent.replace(/^to /, '')),
          svg: [svg.width, svg.height], height: row.getBoundingClientRect().height, line, over: row.scrollWidth - row.clientWidth,
          dots: row.querySelectorAll('.ps-peak').length, card: card.textContent, near: document.getElementById('near-go').textContent,
          peakNote: peak && !peak.hidden && getComputedStyle(peak).visibility !== 'hidden' ? peak.textContent : null,
        };
      });
      const [first, end, best = ''] = got.row;
      const bests = best.match(DATE) ?? [];
      const set = new Set([first, end, ...bests].map(norm));
      if (!(got.svg[0] >= 40 && got.svg[1] >= 12)) fail(`${what}: the sparkline is ${got.svg.map(Math.round).join('x')} px`);
      if (got.height > Math.max(24, got.line * 1.5)) fail(`${what}: the season line is ${Math.round(got.height)} px high, more than one line`);
      if (got.over > 1) fail(`${what}: the season line overflows the card by ${got.over} px`);
      if (got.dots !== bests.length || (peaks && bests.length !== peaks)) fail(`${what}: ${got.dots} best-day dots and "${best}", not ${peaks ?? 'one per'} best day`);
      if (/Best here|First moths|Busiest \w|Peak likely/.test(got.card)) fail(`${what}: the card still has a separate dates line: ${got.card}`);
      const bad = [...got.card.matchAll(DATE), ...got.near.matchAll(DATE)].map((m) => norm(m[0])).filter((d) => !set.has(d));
      if (bad.length) fail(`${what}: the card or the line under the map gives ${bad.join(', ')}, not one of the season line's ${[...set].join(', ')}`);
      const due = /\((\w+[ \u00A0]\d+)\)$/.exec(got.near)?.[1];
      if (!due || norm(due) !== norm(first)) fail(`${what}: the line under the map ("${got.near}") counts down to ${due}, the card's season starts ${first}`);
      if (got.peakNote) fail(`${what}: the time bar still notes "${got.peakNote}" beside the pinned card's own best days`);
      await page.screenshot({ path: `${out}/near-${phone ? 'phone' : 'desktop'}-${what.replace(/\W+/g, '-')}.png`, timeout: 60000 }).catch(() => {});
    };
    const open = async (query, id, ready) => {
      await page.goto(`${origin}/?${query}&noauto&today=2027-01-15`);
      await poll((k) => window.__hatch?.current().id === k, id);
      if (ready && !(await poll(ready))) fail(`${query}: never ready`);
      await page.locator('#locate').click();
    };
    try {
      await open('species=lon-zabulon&date=07-01', 'lon-zabulon-atlas');
      await check('zabulon skipper', 2);
      // Another season and warmth: the line counts down to the card's 2026 dates, warmed, not a typical year's.
      await open('species=lon-zabulon&year=2026&warm=3&date=07-01', 'lon-zabulon-atlas', () => !!window.__hatch.current().warmthNote?.());
      await check('zabulon 2026 warmed', null);
      await open('date=05-20', 'luna-replay');
      await check('luna moth', 1);
      // Zoomed in to the small hexagons: the card reads its small hexagon, and so does the line.
      await page.evaluate(() => window.__hatch.map.focus([-87.63, 41.88], 8, window.__hatch.padding(), false));
      if (!(await poll(() => window.__hatch.current().res() > 4 && window.__hatch.current().fineCurrent?.() && /Small hexagon/.test(document.getElementById('probe').textContent))))
        fail('luna zoomed in: the card never moved to a small hexagon');
      else await check('luna zoomed in', 1);
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // "Out here now" (src/atlas/outNow.ts, src/ui/panels.ts): My area pins the card on Chicago, 10 June, a typical year.
  // Its list ranks species by how near each is to its own best day there, so a species on its best day comes above a
  // commoner one well off its own: the page's own network says which is which. At most All and four chips; one
  // narrows the list to its group, All gives the mix back. Short on a phone: two rows closed and the card no taller
  // than main's (166 px at 390); opened out it lists up to 20 in a scrolling room of its own, and no map button climbs
  // over the About button. A row's tap puts that species on the map. A hover card (desktop) has no list (it is only
  // worked out once pinned). Early March, when hardly anything is near its best, it falls back to the commonest
  // species under "Also out here". Desktop and phone. Waits poll on a timer (a software-GL frame can take 10-25 s).
  // ONLY=out runs just this.
  const outUnit = async ([w, h, phone], browser) => {
    const tag = `out here now ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, {
      viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
      geolocation: { latitude: 41.88, longitude: -87.63 }, permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const poll = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 90000, polling: 500 }).then(() => true, () => false);
    const T = { timeout: 90000 };
    // The rows on screen (a phone hides the third while closed).
    const rows = () => page.evaluate(() => [...document.querySelectorAll('#probe .po-list li')].filter((li) => li.getBoundingClientRect().height > 0).map((li) => ({
      key: li.querySelector('[data-species]')?.dataset.species, group: li.dataset.group,
    })));
    const tap = (loc) => (phone ? loc.tap(T) : loc.click(T));
    const open = async (query, id) => {
      await page.goto(`${origin}/?${query}&noauto&today=2027-01-15`, T);
      if (!(await poll((k) => window.__hatch?.current().id === k, id))) throw new Error(`${id} never loaded`);
    };
    try {
      await open('species=epargyreus-clarus&date=06-10', 'epargyreus-clarus-atlas');
      if (!phone) {
        // A card under the pointer, not pinned: no list, and none worked out for it.
        const at = await clearSpotOn(page, [-90, 40.5, -88, 42]);
        await page.mouse.move(at[0], at[1]);
        if (!(await poll(() => !document.getElementById('probe').hidden))) fail('no hover card');
        else if (await page.locator('#probe .probe-others').count()) fail('a hover card lists the species out here (only a pinned card should)');
        await page.mouse.move(5, h / 2);
      }
      await page.locator('#locate').click(T);
      if (!(await poll(() => document.querySelectorAll('#probe:not([hidden]) .po-list li [data-species]').length >= 2)))
        throw new Error(`the pinned card lists no species out here: "${await page.locator('#probe').innerText().catch(() => '')}"`);
      const title = await page.locator('#probe .po-title').textContent();
      if (title !== 'Out here now') fail(`on 10 June the list is titled "${title}", not "Out here now"`);
      // The ranking, by the page's own network over the season at this cell: the first species is near its own best
      // day, and the commonest species here today, if it is not, does not top the list.
      const list = await rows();
      const r = await page.evaluate(async (k) => {
        const a = await window.__hatch.atlas();
        const key = (n) => n.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
        const own = a.species.findIndex((s) => s.name === 'Epargyreus clarus');
        const first = a.species.findIndex((s) => key(s.name) === k);
        const c = a.cellAt(41.88, -87.63);
        const S = a.net.nOut;
        const ls = Array.from({ length: 62 }, (_, j) => a.net.logShares(a.cells[c], 60 + 4 * j, 0));
        const near = (s) => {
          const ph = ls.map((x, j) => Math.exp(x[s]) * a.volume[j]);
          return ph[25] / Math.max(...ph); // day 160, by 10 June
        };
        let common = -1;
        for (let s = 0; s < S - 1; s++) if (s !== own && (common < 0 || ls[25][s] > ls[25][common])) common = s;
        return { first: near(first), common: key(a.species[common].name), commonNear: near(common), commonShare: Math.exp(ls[25][common]), firstShare: Math.exp(ls[25][first]) };
      }, list[0].key);
      if (!(r.first > 0.7)) fail(`the first species (${list[0].key}) is only ${r.first.toFixed(2)} of its best day's photos here`);
      if (r.commonNear < 0.7 && list[0].key === r.common) fail(`the commonest species here (${r.common}), at ${r.commonNear.toFixed(2)} of its best, tops the list`);
      if (!(r.commonShare > r.firstShare)) console.log(`${tag}: note: the first species is also the commonest here`);
      if (list.length !== (phone ? 2 : 3)) fail(`the closed list shows ${list.length} rows, not ${phone ? 2 : 3}`);
      // At most All and four chips.
      const chips = await page.locator('#probe .po-chip').allTextContents();
      if (chips.length > 5) fail(`${chips.length} chips: ${chips.join(', ')}`);
      // Short on a phone: no taller than main's card (161 px at 390) by more than a few px.
      const size = await page.evaluate(() => ({
        card: document.getElementById('probe').getBoundingClientRect().height,
        head: document.querySelector('#probe .po-head').getBoundingClientRect().height,
      }));
      if (phone && (size.card > 166 || size.head > 30)) fail(`the closed card is ${Math.round(size.card)} px (head ${Math.round(size.head)}), over 166`);
      if (!phone) {
        // Every chip is in view, none cut off or scrolled away.
        const cut = await page.evaluate(() => {
          const box = document.getElementById('probe').getBoundingClientRect();
          return [...document.querySelectorAll('#probe .po-chip')].filter((c) => {
            const b = c.getBoundingClientRect();
            return b.left < box.left || b.right > box.right || document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) !== c;
          }).map((c) => c.textContent);
        });
        if (cut.length) fail(`chips out of view: ${cut.join(', ')}`);
      }
      await page.screenshot({ path: `${out}/out-${phone ? 'phone' : 'desktop'}-closed.png`, timeout: 60000 }).catch(() => {});
      // Opened out: more rows, in a room of their own that scrolls; on a phone, no map button over the About button.
      const opener = page.locator('#probe .po-more');
      if ((await opener.textContent())?.trim() !== 'More ▾') fail(`the opener reads "${await opener.textContent()}"`);
      await tap(opener);
      if (!(await poll(() => document.querySelectorAll('#probe .po-list li').length > 3))) fail('the opener shows no more rows');
      const opened = await page.evaluate(() => {
        const l = document.querySelector('#probe .po-list');
        const i = document.getElementById('info-btn').getBoundingClientRect();
        const hit = document.elementFromPoint(i.left + i.width / 2, i.top + i.height / 2);
        return {
          n: l.children.length, scrolls: l.scrollHeight > l.clientHeight + 4, room: l.clientHeight, card: document.getElementById('probe').getBoundingClientRect().height,
          info: !!hit?.closest('#info-btn'), over: hit?.closest('button')?.id ?? hit?.id ?? hit?.tagName, less: document.querySelector('#probe .po-more')?.textContent.trim(),
        };
      });
      if (opened.n < 10 || opened.n > 20) fail(`opened out, the list has ${opened.n} rows, not 10-20`);
      if (!opened.scrolls) fail(`opened out, ${opened.n} rows don't scroll in a room of their own (${opened.room} px)`);
      if (phone && opened.room > Math.min(220, h * 0.25) + 1) fail(`opened out, the list's room is ${opened.room} px, over min(220 px, 25vh)`);
      if (!opened.info) fail(`opened out, ${opened.over} covers the About button`);
      if (opened.less !== 'Less ▴') fail(`opened out, the opener reads "${opened.less}"`);
      await page.screenshot({ path: `${out}/out-${phone ? 'phone' : 'desktop'}-open.png`, timeout: 60000 }).catch(() => {});
      // A chip narrows the list to its group; All brings back the mix.
      const pick = chips.find((g) => g !== 'All');
      if (!pick) fail(`no chip but All: ${chips.join(', ')}`);
      else {
        await tap(page.locator('#probe .po-chip', { hasText: pick }));
        if (!(await poll((g) => {
          const li = [...document.querySelectorAll('#probe .po-list li')];
          return li.length > 0 && li.every((x) => x.dataset.group === g) && document.querySelector('#probe .po-chip[aria-pressed="true"]')?.textContent === g;
        }, pick))) fail(`the ${pick} chip did not narrow the list to ${pick}: ${JSON.stringify(await rows())}`);
        await tap(page.locator('#probe .po-chip', { hasText: 'All' }));
        if (!(await poll(() => new Set([...document.querySelectorAll('#probe .po-list li')].map((x) => x.dataset.group)).size > 1)))
          fail('All did not bring back the mixed list');
      }
      // One tap puts it on the map.
      const go = page.locator('#probe .po-list [data-species]').first();
      const want = await go.getAttribute('data-species', T);
      await tap(go);
      if (!(await poll((k) => window.__hatch.current().id.startsWith(`${k}-`), want))) fail(`tapping ${want} did not put it on the map`);
      // Early March: hardly anything near its best yet, so the commonest species, under the old title.
      await open('species=nymphalis-antiopa&date=03-05', 'nymphalis-antiopa-atlas');
      await page.locator('#locate').click(T);
      if (!(await poll(() => document.querySelector('#probe:not([hidden]) .po-title')?.textContent === 'Also out here' && document.querySelectorAll('#probe .po-list li').length >= 2)))
        fail(`on 5 March the card does not fall back to "Also out here": "${await page.locator('#probe').innerText().catch(() => '')}"`);
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // Memory: only the last ATLAS_KEPT (src/main.ts) Atlas species stay loaded. Flips through more than that from the
  // picker, comes back to the first, and checks it was let go and loaded again: it draws, and its map's colours are
  // the very ones a fresh page draws for it. ONLY=evict runs just this.
  const evictUnit = async (browser) => {
    const tag = 'evict';
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const KEPT = 8;
    const ctx = await settledContext(browser, { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await ctx.route(PHOTOS, (r) => r.abort()); // the picker's photos: not what this checks
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const first = 'papilio-glaucus';
    const rest = [['papilio-polyxenes', 'Papilio polyxenes'], ['bombus-griseocollis', 'Bombus griseocollis'], ['xylocopa-virginica', 'Xylocopa virginica'],
      ['plathemis-lydia', 'Plathemis lydia'], ['epargyreus-clarus', 'Epargyreus clarus'], ['phyciodes-tharos', 'Phyciodes tharos'], ['pieris-rapae', 'Pieris rapae'],
      ['junonia-coenia', 'Junonia coenia'], ['oncopeltus-fasciatus', 'Oncopeltus fasciatus']];
    const isOn = (p, k) => p.waitForFunction((k) => window.__hatch.current().id === `${k}-atlas`, k, { timeout: 60000 });
    const pick = async (k, q) => {
      // Software GL can spend 10-25 s on one frame, and a click waits for two: generous timeouts, as elsewhere in the Atlas.
      await page.locator('#species').click({ timeout: 90000 });
      await page.locator('#sp-q').fill(q, { timeout: 90000 });
      await page.locator(`#sp-list [data-key="${k}"]`).first().click({ timeout: 90000 });
      await isOn(page, k);
    };
    // Every cell's colour on the map's day, once the field for that very day has landed (two reads a second apart agree).
    const colours = (p) => p.evaluate(async () => {
      const h = window.__hatch;
      const read = () => {
        const hex = h.current().render({ t: h.time.cursor, zoom: 5, theme: { bg: '#000', hexEdge: [0, 0, 0, 0], text: '#000' } }).find((l) => /-forecast-r4$/.test(l.id));
        return hex ? JSON.stringify(hex.props.data.map((d) => hex.props.getFillColor(d))) : null;
      };
      let last = null;
      for (let i = 0; i < 60; i++) {
        const now = read();
        if (now && now === last) return { day: new Date(h.time.cursor).toISOString().slice(5, 10), cells: JSON.parse(now) };
        last = now;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    });
    try {
      await page.goto(`${origin}/?species=${first}&noauto&date=06-15`, { timeout: 90000 });
      await isOn(page, first);
      await page.evaluate(() => (window.__firstLayer = new WeakRef(window.__hatch.current())));
      for (const [k, q] of rest) await pick(k, q);
      const atlasCount = await page.evaluate(() => window.__hatch.registry.all().filter((l) => /-atlas$/.test(l.id)).length);
      if (atlasCount > KEPT) fail(`${atlasCount} Atlas species still loaded after ${rest.length + 1} (at most ${KEPT})`);
      if (await page.evaluate((k) => window.__hatch.registry.all().some((l) => l.id === `${k}-atlas`), first)) fail(`${first}, the least recently shown, was kept`);
      if (!(await page.evaluate((k) => window.__hatch.registry.isActive(`${k}-atlas`), rest[rest.length - 1][0]))) fail('the species on screen is not active');
      // Let go means freed: nothing else (a callback's scope, the species shown after it) may still hold it.
      const cdp = await ctx.newCDPSession(page);
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
      await cdp.detach();
      if (await page.evaluate(() => !!window.__firstLayer.deref())) fail(`${first} was let go but something still holds it (never freed)`);
      await pick(first, 'Papilio glaucus');
      if (await page.evaluate(() => window.__hatch.current() === window.__firstLayer.deref())) fail(`${first} came back as the same layer: it was never let go`);
      const back = await colours(page);
      if (!back) fail(`${first} drew no settled map on coming back`);
      else {
        const lit = back.cells.filter((c) => c[3] > 0).length;
        if (lit < 300) fail(`${first} came back with only ${lit} coloured cells`);
        // The same page, loaded afresh (a second Atlas page at once would share the one software-GL process and starve both).
        await page.goto(`${origin}/?species=${first}&noauto&date=${back.day}`, { timeout: 90000 });
        await isOn(page, first);
        const ref = await colours(page);
        const differ = ref ? ref.cells.filter((c, i) => c.join() !== back.cells[i]?.join()).length : -1;
        if (!ref || ref.day !== back.day || differ) fail(`${first} reloaded differs from a fresh load on ${back.day} (${differ} cells)`);
        else console.log(`${tag}: ${first} reloaded after ${rest.length} others, ${lit} coloured cells match a fresh load on ${back.day}`);
      }
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // Empty and failed states (ideas "UI 5"): each says what happened and offers its one next step, and that step works.
  // The picker's no-match line (the box's × clears it), its failed list and "Try again", the town box's no-match line,
  // and My area without location permission ("Find a town"). Desktop and phone.
  // ONLY=empty runs just this.
  const emptyUnit = async ([w, h, phone], browser) => {
    const tag = `empty ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const shotE = (step) => page.screenshot({ path: `${out}/empty-${phone ? 'phone' : 'desktop'}-${step}.png`, timeout: 60000 })
      .catch((e) => console.log(`empty-${step} screenshot skipped: ${e.message.split('\n')[0]}`));
    const msg = () => page.locator('#action-msg').innerText();
    try {
      // The species list fails once, then loads.
      let block = true;
      await page.route('**/atlas/species.json', (r) => (block ? r.abort() : r.continue()));
      await page.goto(`${origin}/?noauto&today=2027-01-15`);
      await page.waitForTimeout(1500);
      await page.locator('#species').click();
      const retry = page.locator('#sp-list [data-retry]');
      await retry.waitFor({ timeout: 15000 }).catch(() => fail('a failed species list offers no "Try again"'));
      if (!/Couldn.t load/.test((await page.locator('#sp-list').innerText()) ?? '')) fail('a failed species list does not say so');
      const tall = async (loc, what) => {
        const bb = await loc.boundingBox();
        if (phone && (!bb || bb.height < 44)) fail(`${what} is ${bb ? Math.round(bb.height) : 0} px tall on a touch screen, under 44`);
      };
      await tall(retry, '"Try again"');
      await shotE('1-list-failed');
      block = false;
      await retry.click();
      if (!(await page.evaluate(() => document.activeElement?.id === 'sp-q'))) fail('after "Try again" focus did not go to the search box');
      await page.waitForFunction(() => document.querySelectorAll('#sp-list .sp-row').length >= 5 && !document.querySelector('[data-retry]'), null, { timeout: 20000 })
        .catch(() => fail('"Try again" did not load the species list'));
      // Nothing watched: the strip says how to start.
      await page.locator('#sp-watch .sp-none').waitFor({ timeout: 15000 }).catch(() => fail('the empty watch list says nothing'));
      // A search with no match: one line says so (no separate count line), and the box's own × clears it.
      await page.locator('#sp-q').fill('zzqxv');
      const none = page.locator('#sp-list .sp-none');
      await none.waitFor({ timeout: 10000 }).catch(() => fail('a search with no match says nothing'));
      if ((await none.textContent()) !== 'No matches. Try the Latin name.') fail(`a search with no match says "${await none.textContent()}"`);
      if (await page.evaluate(() => [...document.querySelector('.sp-crumbs').children].some((c) => !c.classList.contains('sr') && c.textContent.trim()))) fail('a search with no match still shows a separate count line');
      await shotE('2-no-match');
      // The search box's × (a type="search" box's own clear button): the browser's, so emptied as a click on it would.
      await page.locator('#sp-q').fill('');
      if (await none.count()) fail('clearing the search left the no-match line');
      if (!(await page.locator('#sp-list .sp-row').count())) fail('clearing the search did not bring the species back');
      await page.keyboard.press('Escape');
      // The town box: a name with no match says so as it is typed.
      await page.locator('#find').click();
      await page.locator('#find-q').fill('Zzyzx');
      await page.waitForFunction(() => document.querySelector('#finder .find-none[role="status"]')?.textContent === 'No town by that name here.', null, { timeout: 10000 })
        .catch(() => fail('the town box says nothing (in a live region) for a name with no match'));
      await shotE('3-no-town');
      await page.locator('#find-q').press('Escape');
      // My area with location off: says so, and "Find a town" opens the town box.
      await page.locator('#locate').click();
      const act = page.locator('#action-msg .msg-act');
      await act.waitFor({ timeout: 10000 }).catch(async () => fail(`My area without permission offers no next step ("${await msg()}")`));
      if (!/Location is off/.test(await msg())) fail(`My area without permission says "${await msg()}"`);
      if ((await act.textContent()) !== 'Find a town') fail(`My area without permission offers "${await act.textContent()}"`);
      await tall(act, '"Find a town"');
      await shotE('4-location-off');
      await act.click();
      if (!(await page.locator('#finder').isVisible())) fail('"Find a town" did not open the town box');
      if (await act.count()) fail('the message stayed after its button was used');
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // Species search (searchSpecies, src/atlas/names.ts): an exact or whole-word match on the common name, or a featured
  // species, comes first ("luna" is the luna moth, not the Lunate Zale Moth; "cicada" a cicada, not the Cicada-killer;
  // "bumble" a bumble bee, not the Bumble Flower Beetle), and Enter picks that top row. A species iNaturalist keeps as a
  // subspecies has its English name (names.py: the Red-spotted Purple). ONLY=search runs just this.
  const searchUnit = async (browser) => {
    const tag = 'search';
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await ctx.route(PHOTOS, (r) => r.abort());
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && fail(`console error: ${m.text()}`));
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    try {
      await page.goto(`${origin}/?noauto&today=2027-01-15`);
      await page.locator('#species').click({ timeout: 60000 });
      await page.waitForFunction(() => document.querySelectorAll('#sp-list .sp-row').length >= 5, null, { timeout: 30000, polling: 250 });
      // [query, the top row's key, or a test of its name]
      for (const [q, want] of [['luna', 'luna'], ['monarch', 'monarch'], ['firefly', 'firefly'], ['cicada', /^[\w' -]* Cicada$/], ['bumble', /Bumble Bee$/],
        ['red-spotted purple', 'limenitis-astyanax'], ['cassins', /^Cassin's 17-year Cicada$/], ['CASSÍN’S 17', /^Cassin's 17-year Cicada$/]]) {
        await page.locator('#sp-q').fill(q);
        const top = page.locator('#sp-list .sp-row').first();
        await top.waitFor({ timeout: 10000 }).catch(() => {});
        const [key, name] = await top.evaluate((b) => [b.dataset.key, b.querySelector('.sp-name').firstChild.textContent]).catch(() => [null, null]);
        if (typeof want === 'string' ? key !== want : !want.test(name ?? '')) fail(`searching "${q}" puts "${name}" (${key}) first`);
        if (q === 'red-spotted purple' && name !== 'Red-spotted Purple') fail(`Limenitis astyanax is listed as "${name}"`);
        // A featured species shows its own label, as on the featured strip.
        if (q === 'luna' && name !== 'Luna moth') fail(`searching "luna" lists the luna moth as "${name}"`);
      }
      // A word start later in the name counts like the name's own start, and a tie goes to the species with more records:
      // "lunate" lists the lunate species by their record counts (species.json n), whichever word "Lunate" is.
      await page.locator('#sp-q').fill('lunate');
      await page.waitForFunction(() => document.querySelectorAll('#sp-list .sp-row').length >= 2, null, { timeout: 10000, polling: 250 }).catch(() => {});
      const lunate = await page.evaluate(async () => {
        const n = new Map((await (await fetch('atlas/species.json')).json()).map((s) => [s.common, s.n]));
        return [...document.querySelectorAll('#sp-list .sp-row .sp-name')].map((e) => [e.firstChild.textContent, n.get(e.firstChild.textContent)]);
      });
      if (lunate.length < 2 || lunate.some(([, k], i) => k === undefined || (i && k > lunate[i - 1][1])))
        fail(`"lunate" is not listed by records: ${JSON.stringify(lunate)}`);
      // Enter picks the top row: "luna" opens the luna moth, not a lunate one.
      await page.locator('#sp-q').fill('luna');
      await page.locator('#sp-q').press('Enter');
      await page.waitForFunction(() => /^luna/.test(window.__hatch.current().id), null, { timeout: 30000, polling: 250 })
        .catch(async () => fail(`Enter on "luna" opened ${await page.evaluate(() => window.__hatch.current().id)}`));
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // An Atlas species' track record in "How sure?" (species.json "rec", pipeline/atlas/track_record.py): a stamp per
  // test of the map against a plain calendar. The common eastern bumble bee beat it in 2026 and in WI & MN; the
  // Virginian tiger moth tied in 2026 and lost in the states it never saw (so: read loosely in WI & MN, and what tied
  // means); the stink bug lost 2026; the 17-year cicada (no brood in 2026) was never tested. Every card says what the
  // calendar is. Each stamp sits on one line beside its words, on screen, and never spills out of the panel. Desktop
  // and phone. Waits poll on a timer
  // (a software-GL frame can take 10-25 s). ONLY=track runs just this.
  const trackUnit = async ([w, h, phone], browser) => {
    const tag = `track record ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    await ctx.route(PHOTOS, (r) => r.abort());
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const poll = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 90000, polling: 500 }).then(() => true, () => false);
    const CAL = 'Calendar: just the weeks it’s usually photographed, 2° of latitude at a time (2015-2025).';
    const TIED = 'Tied: neither was 20× more likely to be right.';
    // [key, [result, line]...], then the lines under the stamps
    const cases = [
      ['bombus-impatiens', [['beat', /^Beat 2026, a season it never saw · 5,660 photos$/], ['beat', /^Beat WI & MN, states it never saw · 3,234 photos$/]], [CAL]],
      ['spilosoma-virginica', [['tied', /^Tied 2026, a season it never saw · 1,000 photos$/], ['lost', /^Lost WI & MN, states it never saw · 231 photos$/]],
        ['Read this map loosely in WI & MN.', TIED, CAL]],
      ['halyomorpha-halys', [['lost', /^Lost 2026, a season it never saw · 998 photos$/], ['beat', /^Beat WI & MN, states it never saw · 116 photos$/]], ['Read this map loosely.', CAL]],
      ['magicicada-septendecim', [['untested', /^Untested Too few new photos \(2026, WI & MN\) to test$/]], [CAL]],
    ];
    try {
      for (const [key, want, notes] of cases) {
        await page.goto(`${origin}/?species=${key}&noauto&today=2027-01-15`);
        if (!(await poll((k) => window.__hatch?.current()?.id === `${k}-atlas`, key))) { fail(`${key}: never opened`); continue; }
        await (phone ? page.locator('#why').tap() : page.locator('#why').click());
        // The drawer slides in (0.28 s, or a few slow software-GL frames): wait until it has stopped and every stamp is
        // on screen, so the checks and the screenshot see it where it rests.
        if (!(await poll(() => {
          const d = document.querySelector('#drawer.open');
          const s = [...(d?.querySelectorAll('[data-track] .stamp') ?? [])];
          return s.length && !d.getAnimations({ subtree: false }).length && getComputedStyle(d).transform === 'none'
            && s.every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
        }))) { fail(`${key}: "How sure?" never showed a track record on screen`); continue; }
        const lines = await page.locator('#drawer [data-track] p').allInnerTexts();
        if (lines.join('|') !== notes.join('|')) fail(`${key}: the lines under the stamps read ${JSON.stringify(lines)}, not ${JSON.stringify(notes)}`);
        if (/Its own calendar|Lost in 2026/.test(await page.locator('#drawer').innerText())) fail(`${key}: an old calendar or loss bullet is still there`);
        const got = await page.evaluate(() => [...document.querySelectorAll('#drawer [data-track] li')].map((li) => {
          const s = li.querySelector('.stamp').getBoundingClientRect();
          const card = li.closest('.cav').getBoundingClientRect();
          return { result: li.dataset.result, text: li.textContent.replace(/\s+/g, ' ').trim(), stampH: s.height,
            inside: s.left >= card.left && li.getBoundingClientRect().right <= card.right + 0.5 && li.scrollWidth <= li.clientWidth + 1 };
        }));
        if (got.length !== want.length) fail(`${key}: ${got.length} track record lines, not ${want.length}`);
        want.forEach(([result, text], i) => {
          const g = got[i];
          if (!g) return;
          if (g.result !== result || !text.test(g.text)) fail(`${key}: line ${i + 1} reads "${g.text}" (${g.result}), not ${text} (${result})`);
          if (g.stampH > 24) fail(`${key}: the "${result}" stamp wraps (${Math.round(g.stampH)} px tall)`);
          if (!g.inside) fail(`${key}: line ${i + 1} spills out of the panel`);
        });
        const old = await page.locator('#drawer').innerText();
        if (/Tested on 2026|Too few 2026 records/.test(old)) fail(`${key}: the old one-line test result is still there`);
        await page.screenshot({ path: `${out}/track-${phone ? 'phone' : 'desktop'}-${key}.png`, timeout: 60000 }).catch(() => {});
      }
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // Early or late (seen.py's `days`: the whole expected 2026 season slid to fit its photos). A chip ("11 d late") opens
  // that species on 2026 where its slid season peaks (the expected peak moved by those days), not on the calendar day the
  // map was on; the time bar draws the slide as a bracket from the expected peak, in words ("11 days late"; a phone says
  // it as its chip does), the thumb on its slid end, the words and at least part of the bracket clear of the thumb; the
  // caption's "Peak: about" month is the bar note's; a pinned card says it plainly ("came 11 days later")
  // and the Midwest-wide bracket steps aside for it. With "Warm the spring" on, a chip keeps the calendar day and draws
  // no bracket. The days and dates are written out here (public/atlas/seen-2026), not worked out the app's way. Desktop
  // and phone. Waits poll on a timer (a software-GL frame can take 10-25 s). ONLY=earlylate runs just this.
  const earlyLateUnit = async ([w, h, phone], browser) => {
    const tag = `early/late ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    await ctx.route(PHOTOS, (r) => r.abort());
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const poll = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 90000, polling: 500 }).then(() => true, () => false);
    const tap = (loc) => (phone ? loc.tap() : loc.click());
    const openChip = async (key, strip) => {
      await page.locator('#species').click();
      const chip = page.locator(`#${strip} [data-season="2026"][data-key="${key}"]`).first();
      return (await chip.waitFor({ timeout: 60000 }).then(() => true, () => false)) ? chip : null;
    };
    // [key, strip, early or late, days, the day it opens on, the bar's peak note]
    const cases = [
      ['toxomerus-marginatus', 'sp-odd', 'late', 11, 'Jun 24, 2026', 'peak Jun 13'],
      ['hippodamia-variegata', 'sp-off', 'early', 8, 'Jul 3, 2026', 'peak Jul 11'],
    ];
    try {
      for (const [key, strip, way, days, date, peakNote] of cases) {
        // 10 June first: the chip must move the day, not keep it.
        await page.goto(`${origin}/?noauto&today=2027-01-15&date=06-10`);
        if (!(await poll(() => !!window.__hatch?.current()))) { fail('the page never loaded'); break; }
        const chip = await openChip(key, strip);
        if (!chip) { fail(`${key}: no chip on #${strip}`); continue; }
        const words = ((await chip.textContent()) ?? '').trim();
        if (!words.endsWith(`${days} d ${way}`)) fail(`${key}: the chip reads "${words}"`);
        await tap(chip);
        if (!(await poll(([k, d]) => {
          const c = window.__hatch.current();
          return c.id === `${k}-atlas` && c.mode() === '2026' && document.getElementById('t-date').textContent === d && !!document.querySelector('#bar .shift-note:not([hidden])');
        }, [key, date]))) {
          fail(`${key}: never opened on ${date} with its bracket (${await page.locator('#t-date').textContent()}, bracket ${await page.locator('#bar .shift-note:not([hidden])').count()})`);
          continue;
        }
        const got = await page.evaluate(() => {
          const h = window.__hatch;
          const rib = document.querySelector('#bar .ribbon').getBoundingClientRect();
          const thumbW = document.getElementById('t-range').offsetWidth - rib.width;
          const br = document.querySelector('#bar .ribbon .shift').getBoundingClientRect();
          const nr = document.querySelector('#bar .shift-note').getBoundingClientRect();
          return {
            thumb: rib.left + (h.time.stepIndex / Math.max(1, h.time.steps)) * rib.width, thumbW, perDay: rib.width / Math.max(1, h.time.steps),
            br: [br.left, br.right], nr: [nr.left, nr.right], note: document.querySelector('#bar .shift-note').textContent,
            peak: document.querySelector('#bar .wave.peak-note')?.dataset.full ?? '', caption: document.getElementById('countdown').textContent,
          };
        });
        const label = phone ? `${days} d ${way}` : `${days} days ${way}`;
        if (got.note !== label) fail(`${key}: the bracket reads "${got.note}", not "${label}"`);
        if (got.peak !== peakNote) fail(`${key}: the bar's note is "${got.peak}", not "${peakNote}"`);
        const month = new Date(`${peakNote.slice(5)}, 2026`).toLocaleDateString('en-US', { month: 'long' });
        if (!new RegExp(`^Peak: about ${month}`).test(got.caption)) fail(`${key}: the caption says "${got.caption}", not the bar note's ${month}`);
        // The slid end under the thumb's centre; at least half a thumb and 8 px wide, else exactly its days.
        const slid = way === 'late' ? got.br[1] : got.br[0];
        if (Math.abs(slid - got.thumb) > 2) fail(`${key}: the thumb (${got.thumb.toFixed(1)}) is not on the bracket's slid end (${slid.toFixed(1)})`);
        const width = got.br[1] - got.br[0], want = Math.max(days * got.perDay, got.thumbW / 2 + 8);
        if (Math.abs(width - want) > 2) fail(`${key}: the bracket is ${width.toFixed(1)} px wide, not ${want.toFixed(1)} (${days} days at ${got.perDay.toFixed(2)} px)`);
        if (width - got.thumbW / 2 < 7) fail(`${key}: the thumb hides the bracket (${width.toFixed(1)} px, thumb ${got.thumbW} px)`);
        if (got.nr[1] > got.thumb - got.thumbW / 2 && got.nr[0] < got.thumb + got.thumbW / 2) fail(`${key}: the thumb covers "${got.note}"`);
        // A pinned card says it in words, and the Midwest-wide marks step aside for its place.
        const at = await clearSpotOn(page, [-91, 43.5, -88.5, 45.5]);
        await (phone ? page.touchscreen.tap(at[0], at[1]) : page.mouse.click(at[0], at[1]));
        const plain = `and came ${days} days ${way === 'late' ? 'later' : 'earlier'}`;
        if (!(await poll((t) => (document.getElementById('probe')?.textContent ?? '').includes(t), plain)))
          fail(`${key}: the card does not say "${plain}": "${await page.locator('#probe').innerText().catch(() => '')}"`);
        if (/for its warmth/.test((await page.locator('#probe').textContent()) ?? '')) fail(`${key}: the card still says "for its warmth"`);
        const shown = await page.evaluate(() => ['#bar .ribbon .shift', '#bar .shift-note'].filter((q) => getComputedStyle(document.querySelector(q)).visibility !== 'hidden'));
        if (shown.length) fail(`${key}: ${shown.join(', ')} still shown under a pinned card`);
        await page.screenshot({ path: `${out}/earlylate-${phone ? 'phone' : 'desktop'}-${way}.png`, timeout: 60000 }).catch(() => {});
      }
      // Warmed: the chip keeps the calendar day and the bar draws no slide.
      await page.goto(`${origin}/?species=toxomerus-marginatus&noauto&today=2027-01-15&date=06-10&warm=3`);
      if (!(await poll(() => /earlier|later|hardly/.test(document.getElementById('warm-out')?.textContent ?? '')))) fail('warmed: +3 °F never took');
      else {
        const chip = await openChip('toxomerus-marginatus', 'sp-odd');
        if (!chip) fail('warmed: no chip');
        else {
          await tap(chip);
          if (!(await poll(() => window.__hatch.current().mode() === '2026' && !!document.querySelector('#bar .ribbon svg')))) fail('warmed: the chip did not open 2026');
          await page.waitForTimeout(4000); // a peak wait would have landed by now (PEAK_WAIT is 3 s)
          const d = await page.locator('#t-date').textContent();
          if (d !== 'Jun 10, 2026') fail(`warmed: the chip moved the day to ${d}, not keeping Jun 10`);
          if (await page.locator('#bar .ribbon .shift, #bar .shift-note').count()) fail('warmed: the bar draws a slide bracket');
        }
      }
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // Shared links reopen the pinned card (?pin=lat,lng): a hexagon pinned by a tap, for luna, the firefly (forecasts) and
  // an Atlas species, then Share. Its link names the hexagon's centre to 2 decimals; that link in a fresh page pins the
  // same card (title, hexagon and season line), and one press of its × drops pin= from the address bar. A card pinned
  // from My area shares its hexagon, and no part of its link (pin=, at=) gives the reader's own spot. A malformed,
  // partial or far-off pin, a pin on no hexagon, or one for a species that never loads opens with no card and no error,
  // and leaves the address bar. Desktop and phone (luna and the Atlas). Waits poll on a timer (a software-GL frame can
  // take 10-25 s). ONLY=sharepin runs just this.
  const sharePinUnit = async ([w, h, phone], browser) => {
    const tag = `share pin ${phone ? 'phone' : 'desktop'}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ME = { latitude: 41.8812, longitude: -87.6298 }; // Chicago's Loop: My area's fix
    const ctx = await settledContext(browser, {
      viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
      geolocation: ME, permissions: ['geolocation'],
    });
    await ctx.route(PHOTOS, (r) => r.abort());
    const watch = (pg) => pg.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const poll = (pg, fn, arg, timeout = 90000) => pg.waitForFunction(fn, arg, { timeout, polling: 500 }).then(() => true, () => false);
    const tap = (pg, loc) => (phone ? loc.tap() : loc.click());
    // The pinned card as a reader sees it: its title, its hexagon, its season line.
    const card = (pg) => pg.evaluate(() => {
      const p = document.getElementById('probe');
      if (!p || p.hidden || !p.querySelector('.probe-close')) return null;
      return { title: p.querySelector('.probe-title')?.textContent ?? '', cell: (p.dataset.key ?? '').split('|')[0], season: p.querySelector('.probe-season')?.textContent ?? '' };
    });
    const same = (a, b) => !!a && !!b && a.title === b.title && a.cell === b.cell && a.season === b.season;
    // Share's link, as mobile.mjs reads it: whichever of the share sheet or the clipboard the browser offers.
    const share = async (pg) => {
      await pg.evaluate(() => {
        window.__shared = null;
        const grab = async (d) => void (window.__shared = typeof d === 'string' ? d : d.url);
        if (navigator.share) navigator.share = grab;
        else Object.defineProperty(navigator, 'clipboard', { value: { writeText: grab } });
      });
      await tap(pg, pg.locator('#share'));
      return (await poll(pg, () => !!window.__shared, null, 30000)) ? pg.evaluate(() => window.__shared) : null;
    };
    const pinOf = (url) => new URL(url).searchParams.get('pin');
    // Opens a link in a fresh page and waits for its card to match `want`; screenshots it as `shot` if given.
    const reopen = async (what, url, want, shot) => {
      const pg = await ctx.newPage();
      watch(pg);
      try {
        await pg.goto(url);
        if (!(await poll(pg, () => !!window.__hatch?.current()))) return fail(`${what}: the shared link never loaded`);
        let got = null;
        const until = Date.now() + 90000;
        while (Date.now() < until && !same((got = await card(pg)), want)) await pg.waitForTimeout(500);
        if (!same(got, want)) return fail(`${what}: the shared link pinned ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
        if (shot) {
          for (const scheme of ['light', 'dark']) {
            await pg.emulateMedia({ colorScheme: scheme });
            await poll(pg, (d) => document.documentElement.classList.contains('dark') === d || document.documentElement.dataset.theme === (d ? 'dark' : 'light'), scheme === 'dark', 10000);
            await pg.waitForTimeout(1500); // a software-GL frame in the new colours
            await pg.screenshot({ path: `${out}/sharepin-${phone ? 'phone' : 'desktop'}-${shot}-${scheme}.png`, timeout: 60000 }).catch(() => {});
          }
          await pg.emulateMedia({ colorScheme: 'light' });
        }
        // Closing the card takes pin= out of the address bar (it keeps the rest of the view). One press, even while the
        // card is rebuilt under it (src/ui/panels.ts keeps the same ×).
        await tap(pg, pg.locator('#probe .probe-close'));
        if (!(await poll(pg, () => !/[?&]pin=/.test(location.search) && /[?&]date=/.test(location.search), null, 30000))) fail(`${what}: closing the card left ${await pg.evaluate(() => location.search)} (card: ${JSON.stringify(await card(pg))})`);
      } finally {
        await pg.close();
      }
    };
    const page = await ctx.newPage();
    watch(page);
    try {
      // [what, link, the species' layer id, where to tap]
      const cases = [
        ['luna', '/?noauto&today=2027-01-15&date=06-10', 'luna-replay', [-91, 40, -87, 43]],
        ['firefly', '/?species=firefly&noauto&today=2027-01-15&date=07-01', 'firefly-replay', [-91, 40, -87, 43]],
        ['atlas', '/?species=papilio-glaucus&noauto&today=2027-01-15&date=06-20', 'papilio-glaucus-atlas', [-91, 40, -87, 43]],
      ];
      // A phone runs luna and the Atlas (the touch and docked-card side); the firefly and the bad pins below go through
      // the very same code, so the desktop alone covers them (CI time: see runUnits).
      for (const [what, link, id, box] of cases.filter(([what]) => !phone || what !== 'firefly')) {
        await page.goto(origin + link);
        if (!(await poll(page, (i) => window.__hatch?.current()?.id === i && window.__hatch.current().cellAt([-89.2, 40.1]) != null, id))) { fail(`${what}: never loaded`); continue; }
        await page.waitForTimeout(1500); // the first frame, so a tap lands on a drawn hexagon
        const at = await clearSpotOn(page, box);
        await (phone ? page.touchscreen.tap(at[0], at[1]) : page.mouse.click(at[0], at[1]));
        if (!(await poll(page, () => !!document.querySelector('#probe:not([hidden]) .probe-close')))) { fail(`${what}: a tapped hexagon pinned no card`); continue; }
        // The Atlas card's season line arrives a pass later: read the card once it has settled.
        await poll(page, () => !!document.querySelector('#probe .probe-season') || !document.querySelector('#probe .probe-title'), null, 30000);
        await page.waitForTimeout(1000);
        const want = await card(page);
        if (!(await poll(page, () => /[?&]pin=/.test(location.search), null, 30000))) fail(`${what}: the address bar never named the pin`);
        const url = await share(page);
        if (!url) { fail(`${what}: Share gave no link`); continue; }
        const pin = pinOf(url);
        if (!/^-?\d{1,2}\.\d{2},-?\d{1,3}\.\d{2}$/.test(pin ?? '')) { fail(`${what}: the shared link's pin is ${JSON.stringify(pin)} (${url})`); continue; }
        await reopen(what, url, want, what);
        await tap(page, page.locator('#probe .probe-close'));
      }
      // My area: the link gives the card's hexagon, never the reader's own spot (to any rounding).
      await page.goto(origin + '/?noauto&today=2027-01-15&date=06-10');
      await poll(page, () => window.__hatch?.current()?.cellAt([-89.2, 40.1]) != null);
      await tap(page, page.locator('#locate'));
      if (!(await poll(page, () => !!document.querySelector('#probe:not([hidden]) .probe-close'), null, 30000))) fail('My area pinned no card');
      else {
        const want = await card(page);
        const url = await share(page);
        const pin = url && pinOf(url);
        if (!pin) fail(`My area: the shared link has no pin (${url})`);
        else {
          // My area zooms in, so the link has an at= (the view's centre): that must not give the spot away either.
          if (!new URL(url).searchParams.get('at')) fail(`My area: the shared link has no at= to check (${url})`);
          // Nowhere in the link (pin=, at= or anything else), at any rounding, as text or as numbers.
          const nums = (decodeURIComponent(new URL(url).search).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
          for (const d of [2, 3, 4]) {
            const [la, ln] = [ME.latitude.toFixed(d), ME.longitude.toFixed(d)];
            if (url.includes(la) || url.includes(ln) || nums.includes(+la) || nums.includes(+ln)) fail(`My area: the link gives the reader's own spot to ${d} decimals (${url})`);
          }
          // Compared as for a tapped hexagon: title, hexagon and season line ("Near you" is the sharer's own and isn't
          // read by card()), so the reopened card need not name a place.
          await reopen('My area', url, { ...want }, null);
        }
      }
      // Pins to ignore: not numbers, one number, three, far from the Midwest, empty parts. No card, no error, and the
      // address bar lets them go. A pin in Lake Michigan is in range but on no hexagon: no card, and it goes once the map
      // has loaded. A species that never loads (an unknown key) leaves luna on screen: its pin goes too, unpinned.
      for (const bad of phone ? [] : ['abc,-89', '41.9', '41.88,-87.63,5', '10,10', ',', '41.88,', '1e400,-89', '43.0,-87.0', '40.12,-89.20&species=no-such-bug']) {
        const [pinPart, extra = ''] = bad.split('&');
        await page.goto(`${origin}/?noauto&today=2027-01-15&date=06-10&pin=${encodeURIComponent(pinPart)}${extra && `&${extra}`}`);
        if (!(await poll(page, () => window.__hatch?.current()?.cellAt([-89.2, 40.1]) != null))) { fail(`pin=${bad}: never loaded`); continue; }
        await page.waitForTimeout(2500);
        if (await card(page)) fail(`pin=${bad} pinned a card`);
        if (!(await poll(page, () => !/[?&]pin=/.test(location.search) && /[?&]date=/.test(location.search), null, 30000)))
          fail(`pin=${bad} stayed in the address bar: ${await page.evaluate(() => location.search)}`);
      }
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  // Small feedback (ideas "UI 4"): the species sheet, the town box, a phone's hex card, the short notes, the held time
  // thumb, the watch star and the species button each move a little, and under reduced motion none of them moves at
  // all (no transition or animation longer than 0). Without reduced motion each does move, so the check can't pass
  // by finding nothing. Desktop and phone. ONLY=motion runs just this.
  const motionUnit = async ([w, h, phone, reduce], browser) => {
    const tag = `motion ${phone ? 'phone' : 'desktop'}${reduce ? ' reduced' : ''}`;
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
      reducedMotion: reduce ? 'reduce' : 'no-preference' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    // The longest transition or animation on an element (or its pseudo-element), in seconds.
    const longest = (sel, pseudo) => page.evaluate(([sel, pseudo]) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const max = (s) => Math.max(0, ...(s || '0s').split(',').map(parseFloat));
      if (!pseudo) {
        const c = getComputedStyle(el);
        return Math.max(max(c.transitionDuration), c.animationName === 'none' ? 0 : max(c.animationDuration));
      }
      // A slider's thumb has no computed style of its own to read: take the longest from the rules for it that apply now
      // (their media conditions match and the element matches the part before the pseudo-element).
      let d = 0;
      const walk = (rules, on) => {
        for (const r of rules) {
          if (r instanceof CSSMediaRule) walk(r.cssRules, on && matchMedia(r.conditionText).matches);
          else if (on && r instanceof CSSStyleRule) {
            for (const part of r.selectorText.split(',')) {
              const [base, pe] = part.trim().split(/(?=::)/);
              if (pe !== pseudo || !el.matches(base)) continue;
              d = Math.max(d, max(r.style.transitionDuration), r.style.animationName && r.style.animationName !== 'none' ? max(r.style.animationDuration) : 0);
            }
          }
        }
      };
      for (const sh of document.styleSheets) walk(sh.cssRules, true);
      return d;
    }, [sel, pseudo ?? null]);
    const seen = [];
    const check = async (what, sel, pseudo) => {
      const d = await longest(sel, pseudo);
      if (d === null) return fail(`${what} (${sel}) is not on the page`);
      seen.push([what, d]);
      if (reduce && d > 0) fail(`${what} still moves under reduced motion (${d * 1000} ms)`);
    };
    try {
      await page.goto(`${origin}/?noauto`);
      // The map is ready once its forecast answers for a place (central Illinois).
      await page.waitForFunction(() => window.__hatch?.current()?.cellAt([-89.2, 40.1]) != null, null, { timeout: 60000 });
      const tap = (loc) => (phone ? loc.tap() : loc.click());
      await check('species button', '#species');
      await tap(page.locator('#species'));
      await page.locator('#species-sheet').waitFor();
      await check('species sheet', '#species-sheet');
      // Un-watching snaps out (only the pressed star has a transition), so the star never fades through a dark half-fill.
      if (((await longest('.sp-star path')) ?? 1) > 0) fail('an unwatched star has a transition');
      await tap(page.locator('.sp-star'));
      await check('watch star (on)', '.sp-star path');
      await page.keyboard.press('Escape');
      if (!(await page.locator('#species-sheet').isHidden())) await tap(page.locator('#species-sheet .sp-x'));
      if (phone) {
        await page.touchscreen.tap(...(await clearSpotOn(page, [-91, 38.5, -88, 41.5])));
        await page.locator('#probe').waitFor({ timeout: 10000 }).catch(() => fail('a tapped hex showed no card'));
        await check('hex card', '#probe');
        await tap(page.locator('#probe .probe-close'));
      }
      await tap(page.locator('#share'));
      await page.waitForFunction(() => document.querySelector('#action-msg')?.textContent, null, { timeout: 10000 }).catch(() => fail('Share said nothing'));
      await check('note', '#action-msg');
      await tap(page.locator('#find'));
      await page.locator('#finder').waitFor();
      await check('town box', '#finder');
      await page.locator('#find-q').press('Escape');
      const r = await page.locator('#t-range').boundingBox();
      // Is the slider marked held (or let go), within a moment? A finger's touchcancel (and a touchstart with no touch
      // listener to wait for) is not cancelable, so CDP answers once it is sent, not once the page has handled it: a check
      // read straight after can beat the pointer event on a busy machine. The app must still get there, just not instantly.
      // Polled on a timer, not per frame: a software-GL frame can take seconds, and a frame-polled wait then saw no frame
      // at all in its 2 s while the class was already there (CI's "not marked held" on main too).
      const heldIs = (want) => page.waitForFunction((w) => document.querySelector('#t-range').classList.contains('held') === w, want, { timeout: 2000, polling: 100 })
        .then(() => true, () => false);
      await page.mouse.move(r.x + 4, r.y + r.height / 2);
      await page.mouse.down();
      if (!(await heldIs(true))) fail('a held time slider is not marked held');
      await check('held time thumb', '#t-range', '::-webkit-slider-thumb');
      await page.mouse.up();
      if (!(await heldIs(false))) fail('a released time slider stays held');
      if (phone) {
        // A finger that turns into a page scroll (the slider pans vertically) is cancelled, not lifted: that lets go too.
        const cdp = await ctx.newCDPSession(page);
        const at = [{ x: r.x + 4, y: r.y + r.height / 2 }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
        if (!(await heldIs(true))) fail('a finger on the time slider does not mark it held');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        if (!(await heldIs(false))) fail('a cancelled touch leaves the time slider held');
      }
      if (!reduce) for (const [what, d] of seen) if (!(d > 0 && d <= 0.24)) fail(`${what} moves for ${d * 1000} ms, not 1-240 ms`);
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked ${seen.length} elements`);
  };
  // A replay's map is the Giant Mayfly's (src/main.ts): opened over luna in 2019 on 2 June with a card pinned, the header
  // names the Giant Mayfly at once, the season menu steps aside, no luna hexagon is drawn, the mayfly's field fades in
  // on the replay's day with one line on it (the model's share on the hatch, and its thin-data flag: 285 records), and
  // the link keeps the view under it. × puts back the species, season, day and card, also when pressed before the Atlas
  // has arrived (from a link). One desktop case (the phone's header: mobile.mjs). Waits poll on a
  // timer (a software-GL frame can take 10-25 s). ONLY=radarmayfly runs just this.
  const radarMayflyUnit = async (browser) => {
    const tag = 'radar mayfly';
    const fail = (m) => problems.push(`${tag}: ${m}`);
    const ctx = await settledContext(browser, { viewport: { width: 1280, height: 800 } });
    await ctx.route(PHOTOS, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    const poll = (fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout, polling: 400 }).then(() => true, () => false);
    // What a reader sees: the header's species, the season menu, the day, the pinned card's title, the hexagons drawn.
    const look = () => page.evaluate(() => {
      const h = window.__hatch;
      const p = document.getElementById('probe');
      const season = document.getElementById('season');
      return {
        species: document.querySelector('#species .sp-face').textContent,
        season: season.checkVisibility() ? season.value : null,
        day: new Date(h.time.cursor).toISOString().slice(5, 10),
        card: !p.hidden && p.querySelector('.probe-close') ? p.querySelector('.probe-title')?.textContent ?? '' : null,
        hexes: [...new Set(h.map.drawn().filter((id) => /-(forecast|unseen)-r\d/.test(id) && !id.endsWith('-pad')).map((id) => id.split('-').slice(0, 2).join('-')))],
        url: location.search,
      };
    });
    try {
      await page.goto(origin + '/?noauto&today=2027-01-15&year=2019&date=06-02');
      if (!(await poll(() => window.__hatch?.current()?.cellAt([-89.2, 40.1]) != null))) throw new Error('luna never loaded');
      await page.waitForTimeout(1500); // the first frame, so the click lands on a drawn hexagon
      const at = await clearSpotOn(page, [-91, 40, -87, 43]);
      await page.mouse.click(at[0], at[1]);
      if (!(await poll(() => !!document.querySelector('#probe:not([hidden]) .probe-close') && /[?&]pin=/.test(location.search), null, 30000))) fail('a clicked hexagon pinned no card');
      const before = await look();
      await page.locator('#info-btn').click();
      await poll(() => getComputedStyle(document.getElementById('drawer')).transform === 'none', null, 30000);
      await page.locator('#drawer .ex-radar[data-radar="karx-2014-07-20"]').click();
      await page.waitForSelector('#radar', { timeout: 30000 });
      // At once, before the Atlas has loaded: the mayfly's name, no season menu, no luna under the radar.
      const now = await look();
      if (now.species !== 'Giant Mayfly') fail(`over the replay the header reads "${now.species}"`);
      if (now.season !== null) fail('the season menu stays up over the replay');
      if (now.hexes.some((k) => k !== 'hexagenia-limbata')) fail(`other hexagons drawn under the replay: ${now.hexes.join(', ')}`);
      if (!(await poll(() => window.__hatch.map.drawn().some((id) => id.startsWith('hexagenia-limbata-forecast')) && !document.querySelector('#radar .rd-model').hidden)))
        fail('the Giant Mayfly\'s field or its line never came');
      const during = await look();
      if (during.day !== '07-20') fail(`the mayfly's field is on ${during.day}, not the replay's 20 July`);
      if (during.hexes.join() !== 'hexagenia-limbata') fail(`drawn under the replay: ${during.hexes.join(', ')}`);
      const line = await page.locator('#radar .rd-model').innerText();
      // The model's own number on the hatch (RadarEvent.hatch, the river below La Crosse) that day, not the radar dish's.
      const want = await page.evaluate((at) => {
        const e = window.__hatch.current().expected(at, window.__hatch.time.cursor);
        return e && `Typical year here: ${e.oneIn ? `~${e.oneIn} photos` : 'hardly any'} · ${e.records} records`;
      }, [-91.25, 43.72]);
      if (!want || line.trim() !== want || !/285 records/.test(line)) fail(`the replay's line reads "${line}", not "${want}"`);
      if (await page.locator('#radar .rd-model').evaluate((el) => el.scrollWidth > el.clientWidth + 1)) fail('the replay\'s line is cut off');
      const q = new URLSearchParams(during.url);
      if (q.get('radar') !== 'karx-2014-07-20' || q.get('year') !== '2019' || q.get('date') !== '06-02' || q.has('species') || q.get('pin') !== new URLSearchParams(before.url).get('pin'))
        fail(`over the replay the link reads ${during.url}, not the view under it (${before.url})`);
      await shotCdp(page, `${out}/radar-mayfly-open.png`);
      await page.locator('#radar .rd-x').click();
      const back = (b) => {
        const p = document.getElementById('probe');
        const season = document.getElementById('season');
        return document.querySelector('#species .sp-face').textContent === b.species && season.checkVisibility() && season.value === b.season &&
          new Date(window.__hatch.time.cursor).toISOString().slice(5, 10) === b.day && !p.hidden && p.querySelector('.probe-title')?.textContent === b.card &&
          !window.__hatch.map.drawn().some((id) => id.startsWith('hexagenia-limbata-')) &&
          [...new URLSearchParams(location.search)].sort().join() === [...new URLSearchParams(b.url)].sort().join();
      };
      if (!(await poll(back, before, 30000)))
        fail(`× did not put the view back: ${JSON.stringify(await look())}, before ${JSON.stringify(before)}`);
      // Closed while the Atlas is still on its way (its network held back): luna, 2019 and 2 June come back at once, and
      // the Atlas arriving later changes nothing.
      let release = () => {};
      const held = new Promise((r) => (release = r));
      await ctx.route('**/atlas/model.bin', async (r) => (await held, r.continue()));
      await page.goto(origin + '/?noauto&today=2027-01-15&year=2019&date=06-02&radar=karx-2014-07-20');
      await page.waitForSelector('#radar', { timeout: 30000 });
      if ((await look()).species !== 'Giant Mayfly') fail('a replay from a link does not name the Giant Mayfly while the Atlas loads');
      await page.locator('#radar .rd-x').click();
      const early = (b) => document.querySelector('#species .sp-face').textContent === 'Luna moth' && document.getElementById('season').checkVisibility() &&
        document.getElementById('season').value === '2019' && new Date(window.__hatch.time.cursor).toISOString().slice(5, 10) === '06-02' &&
        window.__hatch.current().id === 'luna-replay' && window.__hatch.map.drawn().some((id) => id.startsWith('luna-forecast'));
      if (!(await poll(early, null, 30000))) fail(`closed before the Atlas came, the view is ${JSON.stringify(await look())}`);
      const done = page.waitForEvent('requestfinished', { predicate: (r) => r.url().endsWith('/atlas/model.bin'), timeout: 60000 }).catch(() => null);
      release();
      await done;
      await page.waitForTimeout(2000); // nothing to poll for: it must change nothing
      if (!(await page.evaluate(early))) fail(`the Atlas arriving after × changed the view: ${JSON.stringify(await look())}`);
    } catch (e) {
      fail(`stopped: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
    console.log(`${tag}: checked`);
  };
  const motionCases = [[1280, 800, false, true], [390, 844, true, true], [1280, 800, false, false], [390, 844, true, false]];
  const watchCases = [[1280, 800, false], [390, 844, true]];
  const sharePinCases = watchCases;
  const screenFor = (...k) => (b) => screenUnit(screens.find((s) => s.join() === k.join()), b);
  // Each with its label and rough cost (see runUnits): runUnits starts the longest first, so no worker is left holding
  // the last big one, and splits them over SHARD by cost.
  const W = (label, w, fn) => Object.assign(fn, { label, w });
  const per = (cases, label, w, fn) => cases.map((c, k) => W(`${label} ${c[2] ? 'phone' : 'desktop'}`, Array.isArray(w) ? w[k] : w, (b) => fn(c, b)));
  const liveCost = { 'in-season default': 120, 'off-season pick': 55, 'late file': 40, 'small phone': 50, rerun: 40, 'stub on request': 70, 'no file': 30, phone: 70 };
  units.push(W('radar', 650, radarUnit), W('screen 2560', 110, screenFor('chromium', 2560, 1440)), W('screen 1920', 120, screenFor('chromium', 1920, 1080)),
    W('screen 1280', 110, screenFor('chromium', 1280, 720)), W('screen 900', 100, screenFor('chromium', 900, 700)),
    ...speciesCases.map((c) => W(`species ${c[0]}`, 85, (b) => speciesUnit(c, b))),
    ...per([[1366, 768, false], [390, 844, true]], 'find', 75, findUnit), W('atlas', 170, atlasUnit), W('search', 15, searchUnit), W('seasons', 10, seasonsUnit),
    ...per(watchCases, 'watch', [290, 470], watchUnit), ...per(watchCases, 'empty', 25, emptyUnit), ...per(watchCases, 'quiet', 30, quietUnit),
    ...per(watchCases, 'twins', 30, twinsUnit), ...per(watchCases, 'tree', 25, treeUnit), W('band', 120, (b) => bandUnit([1280, 800, false], b)), W('this year', 80, thisYearUnit),
    ...per(watchCases, 'near', [100, 155], nearUnit), ...per(watchCases, 'out', 80, outUnit), ...per(watchCases, 'track', [130, 140], trackUnit),
    ...per(watchCases, 'early/late', [100, 160], earlyLateUnit), ...per(sharePinCases, 'share pin', [265, 130], sharePinUnit), W('evict', 100, evictUnit),
    ...motionCases.map((c) => W(`motion ${c[2] ? 'phone' : 'desktop'}${c[3] ? ' reduced' : ''}`, c[2] ? 35 : 15, (b) => motionUnit(c, b))),
    ...cases.map((c) => W(`live ${c[0]}`, liveCost[c[0]] ?? 60, (b) => liveUnit(c, b))), W('no WebGL', 15, noWebglUnit),
    ...screens.filter((s) => s[0] !== 'chromium').map((s) => W(`screen ${s.join(' ')}`, 90, (b) => screenUnit(s, s[0] === 'chromium' ? b : undefined))),
    W('radar mayfly', 75, radarMayflyUnit));
  if (process.env.ONLY === 'tree') units.splice(0, units.length, ...Object.values(browsers).flatMap((b) => watchCases.map((c) => () => treeUnit(c, b))));
  if (process.env.ONLY === 'twins') units.splice(0, units.length, ...watchCases.map((c) => (b) => twinsUnit(c, b)));
  if (process.env.ONLY === 'near') units.splice(0, units.length, ...watchCases.map((c) => (b) => nearUnit(c, b)));
  if (process.env.ONLY === 'out') units.splice(0, units.length, ...watchCases.map((c) => (b) => outUnit(c, b)));
  if (process.env.ONLY === 'track') units.splice(0, units.length, ...watchCases.map((c) => (b) => trackUnit(c, b)));
  if (process.env.ONLY === 'sharepin') units.splice(0, units.length, ...sharePinCases.map((c) => (b) => sharePinUnit(c, b)));
  if (process.env.ONLY === 'earlylate') units.splice(0, units.length, ...watchCases.map((c) => (b) => earlyLateUnit(c, b)));
  if (process.env.ONLY === 'band') units.splice(0, units.length, (b) => bandUnit([1280, 800, false], b));
  if (process.env.ONLY === 'find') units.splice(0, units.length, ...[[1366, 768, false], [390, 844, true]].map((c) => (b) => findUnit(c, b)));
  if (process.env.ONLY === 'empty') units.splice(0, units.length, ...watchCases.map((c) => (b) => emptyUnit(c, b)));
  if (process.env.ONLY === 'motion') units.splice(0, units.length, ...motionCases.map((c) => (b) => motionUnit(c, b)));
  if (process.env.ONLY === 'evict') units.splice(0, units.length, evictUnit);
  if (process.env.ONLY === 'search') units.splice(0, units.length, searchUnit);
  if (process.env.ONLY === 'atlas') units.splice(0, units.length, atlasUnit);
  if (process.env.ONLY === 'big') units.splice(0, units.length, screenFor('chromium', 2560, 1440)); // the largest screen, first visit included
  if (process.env.ONLY === 'live') units.splice(0, units.length, ...cases.map((c) => (b) => liveUnit(c, b)));
  if (process.env.ONLY === 'radar') units.splice(0, units.length, radarUnit);
  if (process.env.ONLY === 'radarmayfly') units.splice(0, units.length, radarMayflyUnit);
  if (process.env.ONLY === 'quiet') units.splice(0, units.length, ...watchCases.map((c) => (b) => quietUnit(c, b)));
  if (process.env.ONLY === 'thisyear') units.splice(0, units.length, thisYearUnit);
  if (process.env.ONLY === 'watch') units.splice(0, units.length, seasonsUnit, ...watchCases.map((c) => (b) => watchUnit(c, b))); // a local shortcut: just this section
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
