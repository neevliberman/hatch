// Mobile smoke test: real phone sizes, touch, both orientations, Safari's engine (WebKit) and Chrome's (Chromium).
// Usage: node scripts/mobile.mjs [outDir]
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html),
//      ENGINES (comma list, default "chromium,webkit"), SHARD ("2/3" = the 2nd of 3 equal slices of the phone and radar
//      cases; unset = all of them).
// FAILS (exit 1) on errors, a map squeezed out by the panels, controls that are covered or off-screen, or a broken
// tap flow (hex card, play, My area, Share, drawer).
// Then, when dist/ (DIST_DIR) has been built, the radar replays over http on the smallest phone of each engine, both
// orientations: each opens from its ?radar= link, its card fits and taps, "How we know" keeps clear of the radar, and ×
// closes it.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extname, join, normalize, resolve } from 'node:path';
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
// Each phone-and-orientation case, and each radar case, takes the next number; a shard runs every SHARD-of-th one.
const [shardNo, shardOf] = (process.env.SHARD ?? '1/1').split('/').map(Number);
let caseNo = 0;
const mine = () => caseNo++ % shardOf === shardNo - 1;
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
    if (!mine()) continue;
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
    // A finger on the About text must scroll it at either stop, even when its first moves twitch down a pixel or two
    // (a real fingertip does). Real touch events need Chromium's protocol; WebKit has no equivalent.
    const swipeText = async (box, stop) => {
      const cdp = await ctx.newCDPSession(page);
      const x = Math.round(width / 2), y = Math.round(box.y + box.height * 0.6);
      const touch = (type, yy) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: yy, id: 1 }] });
      const full = await page.locator('#drawer.full').count();
      await page.evaluate(() => (document.querySelector('#drawer').scrollTop = 0));
      await touch('touchStart', y);
      for (const j of [0, 1, 2, 1]) await touch('touchMove', y + j);
      for (let i = 1; i <= 8; i++) { await touch('touchMove', y - i * 12); await page.waitForTimeout(16); }
      await touch('touchEnd', 0);
      const scrolled = await page.waitForFunction(() => document.querySelector('#drawer').scrollTop > 20, null, { timeout: 5000 }).then(() => true, () => false);
      if (!scrolled) fail(`a swipe on the About text at the ${stop} stop did not scroll it`);
      await page.waitForTimeout(400);
      if ((await page.locator('#drawer.full').count()) !== full) fail(`a swipe on the About text at the ${stop} stop moved the sheet instead`);
      await cdp.detach();
    };
    // Runs in the page: the centre of `s` if a finger could tap it there (shown, on-screen, on top), else null. With
    // `gone`, true once it can't be tapped any more.
    const reachable = ([s, gone]) => {
      const el = document.querySelector(s);
      const r = el?.getBoundingClientRect();
      let at = null;
      if (r && r.width && r.height && !el.disabled && getComputedStyle(el).visibility !== 'hidden') {
        const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
        const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
        if (hit && (hit === el || el.contains(hit))) at = [x, y];
      }
      return gone ? !at : at;
    };
    // Resolves once the page has drawn a frame and run a task after it: its main thread has caught up.
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))).catch(() => {});
    const tap = async (sel) => {
      // The first touch on the map makes deck draw its picking buffer, and on software GL (CI) setting that up blocks
      // the main thread for several seconds. A tap sent meanwhile waits for the page to take it, past the 3 s timeout.
      // So let the page catch up first.
      await settle();
      try {
        await page.locator(sel).tap({ timeout: 3000 });
        return true;
      } catch (e) {
        // Timed out while performing the tap: the touch was already sent, and Playwright gave up waiting for a busy page
        // to take it. It can still land a moment later (the drawer closes), and then the target is gone: that tap
        // worked, and a second one would find nothing to tap. A target still there gets the fallback below.
        // (Gone: hidden, slid off-screen like the closed drawer, or covered.)
        if (/performing tap action\s*$/.test(String(e.message).replace(/\x1b\[\d+m/g, '').trim()) &&
          (await page.waitForFunction(reachable, [sel, true], { timeout: 4000 }).then(() => true, () => false))) return true;
        // Software GL in CI can draw a frame or two a second, and Playwright waits for two quick identical frames
        // before it taps. So check what a finger cares about instead: the target is visible and on top at its centre.
        // Then a plain finger tap at its centre: no more waiting on frames.
        const at = await page.evaluate(reachable, [sel, false]).catch(() => null);
        if (at && (await page.touchscreen.tap(...at).then(() => true, () => false))) return true;
        // The last line of Playwright's log says why (hidden, or which element sits on top).
        fail(`could not tap ${sel} (${String(e.message).trim().split('\n').pop().replace(/\x1b\[\d+m/g, '').trim()})`);
        return false;
      }
    };

    // First visit: the map comes first (the About button just glows). The i button opens the drawer: a side panel, or
    // on a phone held upright a sheet at its middle stop. Either way the map beside or above it stays in use, so a tap
    // there keeps it open and fills its spot card. At the sheet's tall stop (from "How sure?") a tap outside closes it.
    await page.goto(file);
    await page.waitForTimeout(2500);
    await shot('1-first-visit');
    if (await page.locator('#drawer.open').count()) fail('the drawer covers the map on first visit');
    if (!(await page.locator('#info-btn.hint').count())) fail('the About button does not stand out on first visit');
    await tap('#info-btn');
    await page.waitForTimeout(400);
    if (!(await page.locator('#drawer.open').count())) fail('the i button did not open the drawer');
    // Let the slide-in finish before measuring, or a slow machine measures it mid-way and taps the drawer itself.
    await page.waitForFunction(() => document.querySelector('#drawer').getAnimations().length === 0, null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
    // Tap the map: left of a side drawer, or between the top panels and a bottom sheet.
    const box = await page.locator('#drawer').boundingBox();
    const top = await page.evaluate(() => document.querySelector('#top').getBoundingClientRect().bottom);
    const sheet = box.x <= 40;
    if (sheet && box.height > height * 0.6) fail(`the About sheet opens ${Math.round((box.height / height) * 100)}% tall, hiding the map`);
    const spot0 = await page.locator('[data-spot] .spot-title').first().textContent();
    // On land, not a lake (the middle of the free map can be Lake Michigan), and clear of the panels: the first of a
    // few inland spots (Wisconsin, Minnesota, Illinois) that sits in the free strip, else that strip's middle.
    const free = { x1: sheet ? 0 : box.x, y0: top, y1: sheet ? box.y : (await page.locator('#bottom').boundingBox()).y };
    const inland = await page.evaluate(({ x1, y0, y1 }) => [[-89.8, 44.6], [-94.3, 46.2], [-89.2, 40.1]]
      .map((ll) => window.__hatch?.map.project(ll)).find((p) => p && p[0] > 8 && p[0] < (x1 || innerWidth) - 8 && p[1] > y0 + 8 && p[1] < y1 - 8),
      free);
    await page.touchscreen.tap(...(inland ?? [sheet ? width / 2 : box.x / 2, (free.y0 + free.y1) / 2]));
    await page.waitForTimeout(600);
    if (!(await page.locator('#drawer.open').count())) fail('a tap on the map beside the open drawer closed it');
    else if (sheet) {
      // At the middle stop the tapped hexagon's season shows in the sheet (deck holds a tap back for the double-tap window).
      const filled = await page.waitForFunction((t) => document.querySelector('[data-spot] .spot-title')?.textContent !== t, spot0, { timeout: 6000 })
        .then(() => true, () => false);
      if (!filled) fail('a tap on the map at the middle stop did not fill the spot card');
      if (engine === 'chromium') await swipeText(box, 'middle');
    }
    await shot('1b-drawer-and-map');
    await tap('#drawer-close');
    await page.waitForTimeout(400);
    // On a ~2fps CI frame a tap can land before the button takes it: one more try, then it is a real failure.
    if (await page.locator('#drawer.open').count()) await tap('#drawer-close'), await page.waitForTimeout(600);
    if (await page.locator('#drawer.open').count()) fail('the drawer close button did not close it');
    if (await page.locator('#probe .probe-close').isVisible()) await tap('#probe .probe-close');
    if (sheet && (await tap('#why'))) {
      // Slow CI frames: wait for the sheet to finish rising, or the tap aimed above it lands on it.
      // A ~2fps CI frame can take seconds to finish the rise: until it has, a tap "above" the sheet lands on the sheet.
      const risen = await page.waitForFunction(() => { const r = document.querySelector('#drawer')?.getBoundingClientRect();
        return !!r && r.top < innerHeight * 0.15 && getComputedStyle(document.querySelector('#drawer')).transform === 'none'; }, null, { timeout: 10000 })
        .then(() => true, () => false);
      if (!risen) fail('the tall sheet never finished rising');
      await page.waitForTimeout(300);
      const tall = await page.locator('#drawer').boundingBox();
      if (!(await page.locator('#drawer.open.full').count())) fail('"How sure?" did not open the sheet at its tall stop');
      if (engine === 'chromium') await swipeText(tall, 'tall');
      // Above the sheet at the far left: the header's middle is the season menu, which a tap would open instead.
      await page.touchscreen.tap(12, Math.max(4, tall.y / 2));
      await page.waitForTimeout(400);
      if (await page.locator('#drawer.open').count()) {
        fail(`tapping outside the tall sheet did not close it (sheet top ${Math.round(tall.y)}px)`);
        // Recorded; now close it, so one failure does not cover every control the later checks tap.
        await tap('#drawer-close');
        await page.waitForTimeout(600);
      }
      if (await page.locator('#probe').isVisible()) fail('the tap that closed the drawer also opened a card');
    }

    const a = await page.evaluate(audit);
    await shot('2-map');
    if (a.map < MIN_MAP) fail(`panels leave only ${Math.round(a.map * 100)}% of the screen for the map (need ${MIN_MAP * 100}%)`);
    if (a.overflowX) fail('page scrolls sideways');
    if (engine === 'webkit' && a.selectFont < 16) fail(`season menu font ${a.selectFont}px: iOS zooms the page when it opens`);
    a.bad.forEach(fail);
    if (await blank(page)) fail('map looks blank');

    // Tap the map over land (central Illinois, so not a lake whatever the layout): a card must appear, and the
    // actions must stay reachable. Falls back to the middle of the free area.
    const sub = await page.locator('#top').boundingBox();
    const bot = await page.locator('#bottom').boundingBox();
    const land = await page.evaluate(() => window.__hatch?.map.project([-89.2, 40.1]));
    await page.touchscreen.tap(...(land ?? [width / 2, (sub.y + sub.height + bot.y) / 2]));
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

    // By now the map has been tapped and played, so the colour key has folded to its chip; the chip opens it again.
    if (await page.locator('#probe .probe-close').isVisible()) await tap('#probe .probe-close');
    if (!(await page.locator('#key-chip').isVisible())) fail('the colour key did not fold to its chip');
    else if (await tap('#key-chip')) {
      if (!(await page.locator('#key-fold').isVisible())) fail('the Key chip did not open the colour key');
      else await tap('#key-fold');
    }

    // Find a town: the search button opens the name box; typing a town and picking it pins its card. It reads the
    // map's town names, so only a build served over http has it (DIST=... with a server; desktop.mjs checks it too).
    if ((await page.locator('#find').isVisible()) && (await tap('#find'))) {
      if (await page.locator('#find-q').isHidden()) fail('Find a town did not open its name box');
      else {
        await page.keyboard.press('Escape');
        if (await page.locator('#finder').isVisible()) fail('Esc did not close the name box');
        if ((await page.evaluate(() => document.activeElement?.id)) !== 'find') fail('Esc did not return focus to Find a town');
        await tap('#find');
        // Typing must not jump away mid-name. A name several towns share asks which one on Enter, the forecast
        // states first and each with its state; picking one goes there.
        await page.locator('#find-q').fill('Springfield');
        await page.waitForTimeout(500);
        if (await page.locator('#finder').isHidden()) fail('typing a name jumped away before it was picked');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const opts = await page.locator('#find-list li').allTextContents();
        if (await page.locator('#finder').isHidden()) fail('Enter on a shared name jumped to one place without asking');
        else if (!/^Springfield, IL/.test(opts[0] ?? '') || opts.length < 2) fail(`Springfield options read ${JSON.stringify(opts)}`);
        await shot('3a-find-choices');
        await tap('#find-list li');
        await page.waitForTimeout(1000);
        if (await page.locator('#finder').isVisible()) fail('picking a town did not close the name box');
        if (!/Springfield/.test((await page.locator('#probe').textContent()) ?? '')) fail('Find a town showed no card for Springfield');
        await shot('3b-find-town');
        if (await page.locator('#probe .probe-close').isVisible()) await tap('#probe .probe-close');
        if (await page.locator('#recenter').isVisible()) await tap('#recenter');
      }
    }

    if (await tap('#locate')) {
      await page.waitForTimeout(1000);
      if (await page.locator('#probe').isHidden()) fail('"My area" showed no card');
      await shot('4-my-area');
      // My area zooms in on you; go back to the whole Midwest for the pinch test below.
      if (await page.locator('#recenter').isHidden()) fail('"My area" did not zoom in on you');
      else await tap('#recenter');
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
        // The recenter glides back (a third of a second, longer on a slow machine).
        await page.waitForFunction((z) => window.__hatch.map.zoom() <= z + 0.05, z0, { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(200);
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
// The radar replays (src/radar/), over http: the one-file build has none, their frames are files beside the page.
// Every event in the About list, from its ?radar= link: the card's buttons can be tapped, nothing spills off the side,
// "How we know" opens (on a phone on its side the radar moves to the right of it, upright it stays above the card),
// the radar sits at the map's centre, and × gives back the time bar.
const RADARS = { 'karx-2014-07-20': { at: [-91.19, 43.82], tz: 'CDT' }, 'kdvn-2012-06-23': { at: [-90.58, 41.61], tz: 'CDT' }, 'kcle-2019-06-26': { at: [-81.86, 41.41], tz: 'EDT' } };
const distDir = resolve(process.env.DIST_DIR ?? 'dist');
// CI builds only the one-file page for this script, so build the http one here rather than skip the replays.
if (!process.env.DIST_DIR && !existsSync(join(distDir, 'radar'))) execSync('npx vite build --logLevel warn', { stdio: 'inherit' });
if (existsSync(join(distDir, 'radar'))) {
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
  // The smallest phone of each engine: the tightest fit.
  const small = [...new Set(phones.map((p) => p[1]))].map((e) => phones.filter((p) => p[1] === e).sort((a, b) => a[2] * a[3] - b[2] * b[3])[0]);
  for (const [phone, engine, pw0, ph0, dpr] of small) {
    for (const orient of ['portrait', 'landscape']) {
      for (const [id, ev] of Object.entries(RADARS)) {
        if (!mine()) continue;
        const [width, height] = orient === 'portrait' ? [pw0, ph0] : [ph0, pw0];
        const tag = `radar ${id} ${phone} ${orient}`;
        const fail = (m) => problems.push(`${tag}: ${m}`);
        const ctx = await browsers[engine].newContext({ viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
        const page = await ctx.newPage();
        page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
        page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
        // A finger tap at the centre of `sel`, if it is shown, on-screen and on top there.
        const tap = async (sel) => {
          const at = await page.evaluate((s) => {
            const el = document.querySelector(s);
            const r = el?.getBoundingClientRect();
            if (!r || !r.width || !r.height) return null;
            const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
            const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
            return hit && (hit === el || el.contains(hit)) ? [x, y] : null;
          }, sel);
          if (!at) return fail(`could not tap ${sel}`), false;
          await page.touchscreen.tap(...at);
          return true;
        };
        try {
          await page.goto(`${origin}/?radar=${id}&noauto&today=2027-01-15`);
          await page.waitForSelector('#radar', { timeout: 30000 });
          const cap = (await page.locator('#radar .rd-cap').innerText()).replace(/\s+/g, ' ');
          if (!cap.includes(ev.tz) || !/[Mm]ayflies/.test(cap)) fail(`the caption reads "${cap}"`);
          await page.waitForFunction(([lng, lat]) => {
            const c = window.__hatch.map.center(window.__hatch.padding());
            return window.__hatch.map.zoom() > window.__hatch.map.fitZoom() + 1 && Math.abs(c.lngLat[0] - lng) < 0.6 && Math.abs(c.lngLat[1] - lat) < 0.7;
          }, ev.at, { timeout: 30000, polling: 250 }).catch(() => fail('the map did not go to the radar'));
          const card = await page.evaluate(() => {
            const bad = [];
            for (const el of document.querySelectorAll('#radar button')) {
              const r = el.getBoundingClientRect();
              if (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) bad.push(`${el.className} is off-screen`);
              else if (Math.min(r.width, r.height) < 24) bad.push(`${el.className} is only ${Math.round(r.width)}x${Math.round(r.height)}px`);
            }
            return { bad, overflowX: document.documentElement.scrollWidth > innerWidth };
          });
          card.bad.forEach(fail);
          if (card.overflowX) fail('the page scrolls sideways');
          await page.waitForTimeout(1500);
          await page.screenshot({ path: `${out}/radar-${id}-${phone}-${orient}-1.png` });
          if (await tap('#radar .rd-i')) {
            await page.waitForTimeout(300);
            if (await page.locator('#radar .rd-more').isHidden()) fail('"How we know" did not open');
            // Clear of the card: beside it on a phone on its side, above it upright.
            const clear = await page.waitForFunction(([lngLat, side]) => {
              const at = window.__hatch.map.project(lngLat);
              const r = document.getElementById('radar').getBoundingClientRect();
              return !!at && (side ? at[0] > r.right : at[1] < r.top) && r.top >= 0 && r.bottom <= innerHeight + 1;
            }, [ev.at, orient === 'landscape' && height <= 500], { timeout: 30000, polling: 250 }).then(() => true, () => false);
            if (!clear) fail('with "How we know" open, the card covers the radar or runs off the screen');
            await page.waitForTimeout(800);
            await page.screenshot({ path: `${out}/radar-${id}-${phone}-${orient}-2-how.png` });
          }
          if (await tap('#radar .rd-x')) {
            await page.waitForTimeout(600);
            if (await page.locator('#radar').count()) fail('× did not close the replay');
            if (await page.locator('#dock').isHidden()) fail('the time bar did not come back');
          }
        } catch (e) {
          fail(`stopped: ${e.message.split('\n')[0]}`);
        }
        await ctx.close();
        console.log(`${tag}: checked`);
      }
    }
  }
  server.close();
} else problems.push(`radar replays not checked: no ${join(distDir, 'radar')} (run npm run build first)`);
for (const b of Object.values(browsers)) await b.close();
if (problems.length) {
  console.error('MOBILE FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('MOBILE OK');
