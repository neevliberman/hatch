// Zoomed-in smoke test for the finer hexagons (res 5 and 6), which only load over http(s).
// Usage: node scripts/fine.mjs [outDir]   (after `npm run build`; serves dist/ on a local port)
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST_DIR (default dist), SHARD ("2/3" = the 2nd of 3 equal
//      slices of the cases; unset = all of them).
// FAILS (exit 1) on any page or console error, a failed or non-local request, a level that never appears,
// a blank map, or a tap that shows no card.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots/fine';
mkdirSync(out, { recursive: true });
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
const origin = `http://127.0.0.1:${server.address().port}`;
const manifest = JSON.parse(readFileSync(join(root, 'fine/manifest.json'), 'utf8'));
const finest = Math.max(...Object.keys(manifest.levels).map(Number));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const problems = [];

const measure = async (b64) => {
  const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(Math.floor(bmp.width * 0.3), Math.floor(bmp.height * 0.3), Math.floor(bmp.width * 0.4), Math.floor(bmp.height * 0.25)).data;
  const counts = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return { distinct: counts.size, dominant: Math.max(...counts.values()) / (d.length / 4) };
};

// Share of pixels (top 60% of the screen: the map, not the panels) that clearly differ between two screenshots.
const differ = async ([a, b]) => {
  const px = async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, bmp.width, Math.floor(bmp.height * 0.6)).data;
  };
  const [x, y] = [await px(a), await px(b)];
  let n = 0;
  for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 40) n++;
  return n / (x.length / 4);
};

const CHROME_OFF = '#top, .brand, #recenter, #actions { visibility: hidden !important; }';

// [label, query, lng, lat, zoom, expected res]: lake shores, a city and a river valley, then back out.
const cases = [
  // Dates sit where the season is turning there, so the local differences show as two colours.
  ['chicago-z7', '?year=2021&date=05-22&noauto', -87.9, 42.0, 7.0, 5],
  ['lake-mi-shore-z8.6', '?date=05-28&noauto', -86.05, 42.55, 8.6, 6],
  ['detroit-z9', '?year=2025&date=05-30&noauto', -83.2, 42.4, 9.0, 6],
  ['mississippi-z8.2', '?date=05-24&noauto', -91.2, 43.2, 8.2, 6],
  ['wheel-back-out', '?noauto', -88.5, 42.5, 5.0, 4],
];
// Each screen case and each species case takes the next number; a shard runs every SHARD-of-th one.
const [shardNo, shardOf] = (process.env.SHARD ?? '1/1').split('/').map(Number);
let caseNo = 0;
const mine = () => caseNo++ % shardOf === shardNo - 1;
const shots = [
  ['desktop', 1440, 900, false],
  ['mobile', 390, 844, true],
];

for (const [name, width, height, mobile] of shots) {
  for (const [label, query, lng, lat, zoom, want] of cases) {
    if (!mine()) continue;
    const res = Math.min(want, finest);
    const tag = `${name} ${label}`;
    // Reduced motion: no first-frame wash or glides, so the back-out comparison isn't racing an animation on a slow runner.
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('request', (r) => !r.url().startsWith(origin) && !/^(data|blob):/.test(r.url()) && problems.push(`${tag}: external request ${r.url()}`));
    page.on('requestfailed', (r) => problems.push(`${tag}: request failed ${r.url()}`));
    page.on('response', (r) => r.status() >= 400 && problems.push(`${tag}: HTTP ${r.status()} ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`${tag}: console error: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${tag}: pageerror: ${e.message}`));
    await page.goto(`${origin}/${query}`);
    await page.waitForFunction(() => !document.getElementById('loader'), null, { timeout: 15000 }).catch(() => problems.push(`${tag}: the map never drew its first frame`));
    await page.waitForTimeout(1200);
    if (label === 'wheel-back-out') {
      // Wheel in to the finest level and back out, as a person does (each level comes and goes many frames apart).
      // A jump straight from res 6 to res 4 hid a bug that left small hexagons drawn in the gaps along the shores.
      await page.evaluate(() => window.__hatch.map.view([-87.9, 42.0], 5));
      await page.mouse.move(width * 0.5, height * 0.35);
      for (let k = 0; k < 14; k++) await page.mouse.wheel(0, -250).then(() => page.waitForTimeout(200));
      await page.waitForFunction(() => window.__hatch.luna.res() > 4, null, { timeout: 8000 }).catch(() => problems.push(`${tag}: never zoomed in`));
      await page.waitForTimeout(1000);
      for (let k = 0; k < 14; k++) await page.mouse.wheel(0, 250).then(() => page.waitForTimeout(200));
      await page.mouse.move(width * 0.5, height - 4); // off the map, so no hover card in the comparison
      await page.waitForTimeout(1000);
    }
    // Back-out stays where the wheel left it: jumping again would redraw and hide what the zoom out left behind.
    const at = label === 'wheel-back-out' ? await page.evaluate(() => window.__hatch.map.center(window.__hatch.padding())) : null;
    if (!at) await page.evaluate(([a, b, z]) => window.__hatch.map.view([a, b], z), [lng, lat, zoom]);
    const ok = await page.waitForFunction((r) => window.__hatch.luna.res() === r, res, { timeout: 8000 }).then(() => true, () => false);
    const got = await page.evaluate(() => window.__hatch.luna.res());
    if (!ok) problems.push(`${tag}: expected res ${res}, map shows res ${got}`);
    await page.waitForTimeout(800);
    // The back-out comparison is about the map: the chrome that only shows once the view has moved (the recenter
    // button, the brand pill's backing) is hidden from both shots.
    const chrome = label === 'wheel-back-out' ? await page.addStyleTag({ content: CHROME_OFF }) : null;
    const png = await page.screenshot({ path: `${out}/${name}-${label}.png` });
    if (chrome) await chrome.evaluate((el) => el.remove());
    const m = await page.evaluate(measure, png.toString('base64'));
    if (label === 'wheel-back-out') {
      // After zooming in and out, the map must look like a fresh load of the same view: no small hexagons left over.
      const fresh = await ctx.newPage();
      await fresh.goto(`${origin}/${query}`);
      await fresh.waitForFunction(() => !document.getElementById('loader'), null, { timeout: 15000 }).catch(() => {});
      await fresh.waitForTimeout(1200);
      await fresh.evaluate((c) => window.__hatch.map.focus(c.lngLat, c.zoom, window.__hatch.padding()), at);
      await fresh.waitForTimeout(1500);
      await fresh.addStyleTag({ content: CHROME_OFF });
      const ref = await fresh.screenshot({ path: `${out}/${name}-${label}-fresh.png` });
      await fresh.close();
      const diff = await page.evaluate(differ, [png.toString('base64'), ref.toString('base64')]);
      console.log(`${tag}: differs from a fresh load in ${(diff * 100).toFixed(2)}% of pixels`);
      if (diff > 0.005) problems.push(`${tag}: after zooming in and out the map differs from a fresh load (${(diff * 100).toFixed(1)}% of pixels)`);
    }
    console.log(`${tag}: res ${got}, centre colours=${m.distinct}, dominant=${(m.dominant * 100).toFixed(0)}%`);
    // Zoomed in close, one hexagon can fill the middle of the screen, so only a single flat colour counts as blank there.
    if (got > 4 ? m.distinct < 2 : m.distinct < 4 || m.dominant > 0.97) problems.push(`${tag}: map looks blank: ${JSON.stringify(m)}`);
    // Tap the middle: the card must show, and say what a small hexagon is when one is on screen.
    // Back-out taps where the wheel zoomed (around Chicago); the other cases tap the middle of their view.
    const tapY = height * (label === 'wheel-back-out' ? 0.35 : 0.45);
    if (mobile) await page.touchscreen.tap(width * 0.5, tapY);
    else await page.mouse.click(width * 0.5, tapY);
    await page.waitForTimeout(500);
    if (await page.locator('#probe').isHidden()) problems.push(`${tag}: tapping the map showed no card`);
    else {
      const text = await page.locator('#probe').textContent(); // all lines, even those a hover card hides
      if (got > 4 && !/Small hexagon/.test(text)) problems.push(`${tag}: card does not say it is a small hexagon: ${text}`);
      if (got === 4 && /Small hexagon/.test(text)) problems.push(`${tag}: res-4 card calls itself small`);
    }
    await page.screenshot({ path: `${out}/${name}-${label}-card.png` });
    if (label === 'chicago-z7') {
      // Switching season while zoomed in keeps the small hexagons on screen (no flash back to the big ones).
      const seen = await page.evaluate(async () => {
        const sel = document.querySelector('#season');
        const next = [...sel.options].map((o) => o.value).find((v) => /^\d{4}$/.test(v) && v !== sel.value); // a past year: live has no small hexagons
        sel.value = next;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const res = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 1500) res.push(await new Promise((r) => requestAnimationFrame(() => r(window.__hatch.luna.res()))));
        return res;
      });
      if (seen.some((r) => r === 4)) problems.push(`${tag}: switching season flashed back to the big hexagons (${seen.join(',')})`);
      if (seen.at(-1) !== res) problems.push(`${tag}: after a season switch the map shows res ${seen.at(-1)}, expected ${res}`);
      // ...and the new season's own colours arrive (not the last season's, kept on screen for the moment of the switch).
      await page.waitForFunction(() => window.__hatch.luna.fineCurrent(), null, { timeout: 8000 })
        .catch(() => problems.push(`${tag}: after a season switch the small hexagons never showed the new season`));
    }
    await ctx.close();
  }
}

// Every species, in a past season and in the live one: zooming in must split the big hexagons (live once stayed at res 4).
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const probe = await ctx.newPage();
  await probe.goto(`${origin}/?noauto`);
  await probe.waitForFunction(() => document.querySelectorAll('#species option').length > 0 && !document.getElementById('loader'), null, { timeout: 15000 });
  await probe.waitForTimeout(1500);
  const keys = await probe.evaluate(() => [...document.querySelectorAll('#species option')].map((o) => o.value));
  await ctx.close();
  for (const key of keys) {
    for (const season of ['2021', 'live']) {
      if (!mine()) continue;
      const tag = `species ${key} ${season}`;
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const page = await c.newPage();
      page.on('pageerror', (e) => problems.push(`${tag}: pageerror: ${e.message}`));
      await page.goto(`${origin}/?noauto&species=${key}&season=${season}&date=06-20`);
      await page.waitForFunction(() => !document.getElementById('loader'), null, { timeout: 15000 }).catch(() => problems.push(`${tag}: never drew`));
      await page.waitForTimeout(2500);
      if (await page.evaluate(() => window.__hatch.current().tracker === true)) {
        await c.close(); // a tracker (monarch, red admiral) has no hexagons to split
        continue;
      }
      if (season === 'live' && (await page.evaluate(() => window.__hatch.current().mode())) !== 'live') {
        await c.close(); // this species has no live forecast (yet)
        continue;
      }
      const res = [];
      for (const [lng, lat, z] of [[-87.9, 43.04, 7], [-87.9, 43.04, 8.6]]) {
        await page.evaluate(([a, b, zz]) => window.__hatch.map.view([a, b], zz), [lng, lat, z]);
        await page.waitForTimeout(2500);
        res.push(await page.evaluate(() => window.__hatch.current().res()));
      }
      console.log(`${tag}: res at zoom 7 / 8.6 = ${res.join(' / ')}`);
      // Every species ships res 5 and 6 (pipeline/species/build_fine.py --res 5 6), so zoom 8.6 shows the smallest hexagons.
      if (res[0] < 5 || res[1] < 6) problems.push(`${tag}: hexagons did not split on zoom (res ${res.join(' then ')}, wanted 5 then 6)`);
      await c.close();
    }
  }
}
// How every species looks, in light and dark, on a desktop and a phone: hexagons drawn (a tracker's too), a coloured
// season ribbon, a species mark with no paper disc in dark mode, a species menu wide enough for its mark and arrow, and
// one clean focus ring on the menus. (Trackers once shipped with no hexagons, a clear ribbon and a glaring disc.)
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const probe = await ctx.newPage();
  await probe.goto(`${origin}/?noauto`);
  await probe.waitForFunction(() => document.querySelectorAll('#species option').length > 0 && !document.getElementById('loader'), null, { timeout: 15000 });
  const keys = await probe.evaluate(() => [...document.querySelectorAll('#species option')].map((o) => o.value));
  await ctx.close();
  for (const key of keys) {
    for (const scheme of ['light', 'dark']) {
      for (const [vname, width, height, mobile] of [['desktop', 1440, 900, false], ['phone', 390, 844, true]]) {
        if (!mine()) continue;
        const tag = `look ${key} ${scheme} ${vname}`;
        const c = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, colorScheme: scheme, reducedMotion: 'reduce' });
        const page = await c.newPage();
        page.on('pageerror', (e) => problems.push(`${tag}: pageerror: ${e.message}`));
        await page.goto(`${origin}/?noauto&species=${key}&date=06-20`);
        await page.waitForFunction(() => !document.getElementById('loader'), null, { timeout: 15000 }).catch(() => problems.push(`${tag}: never drew`));
        // The species loads after the page does: wait for its own layer, or this would score the luna moth again.
        await page.waitForFunction((k) => window.__hatch.current().id.startsWith(k + '-'), key, { timeout: 15000 }).catch(() => problems.push(`${tag}: its layer never loaded`));
        await page.waitForTimeout(2500);
        const got = await page.evaluate(async () => {
          const h = window.__hatch;
          const cur = h.current();
          const layers = cur.render({ t: h.time.cursor, zoom: 5, theme: { bg: '#000', hexEdge: [0, 0, 0, 0], text: '#000' } });
          const hexes = layers.filter((l) => /-forecast-r\d/.test(l.id));
          const bands = [...document.querySelectorAll('#t-ribbon path.band')].map((b) => b.getAttribute('fill'));
          const sel = document.getElementById('species');
          const mark = decodeURIComponent(document.getElementById('mark').src);
          await new Promise((r) => setTimeout(r, 300));
          return {
            hexes: hexes.reduce((n, l) => n + (l.props.data?.length ?? 0), 0),
            bands: bands.filter((f) => f && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(f)).length,
            disc: /r=['"]256['"]/.test(mark),
            menuWidth: sel.getBoundingClientRect().width,
            speciesShown: !sel.closest('label').hidden,
          };
        });
        if (!got.hexes) problems.push(`${tag}: no hexagons drawn`);
        if (!got.bands) problems.push(`${tag}: the season ribbon has no colour`);
        if (scheme === 'dark' && got.disc) problems.push(`${tag}: the species mark still has its paper disc`);
        if (mobile && got.speciesShown && got.menuWidth < 64) problems.push(`${tag}: species menu ${got.menuWidth}px wide, too narrow for mark and arrow`);
        // One focus ring: no outline offset from the border (it read as a doubled box), an accent border and hairline instead.
        let ring = null;
        for (let i = 0; i < 40 && !ring; i++) {
          await page.keyboard.press('Tab');
          ring = await page.evaluate(() => {
            const sel = document.activeElement;
            if (sel?.id !== 'season') return null;
            const st = getComputedStyle(sel);
            const edge = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            return { outline: st.outlineStyle === 'none' || parseFloat(st.outlineWidth) === 0, shadow: st.boxShadow !== 'none', visible: sel.matches(':focus-visible'), accent: !!edge && st.borderTopColor !== getComputedStyle(document.body).color };
          });
        }
        if (!ring) problems.push(`${tag}: Tab never reached the season menu`);
        else if (!ring.visible || !ring.outline || !ring.shadow || !ring.accent) problems.push(`${tag}: menu focus is not one clean ring (${JSON.stringify(ring)})`);
        await page.screenshot({ path: `${out}/look-${key}-${scheme}-${vname}.png` });
        console.log(`${tag}: hexes ${got.hexes}, ribbon bands ${got.bands}, menu ${Math.round(got.menuWidth)}px`);
        await c.close();
      }
    }
  }
}
await browser.close();
server.close();
if (problems.length) {
  console.error('FINE FAILED:\n - ' + [...new Set(problems)].join('\n - '));
  process.exit(1);
}
console.log('FINE OK');
