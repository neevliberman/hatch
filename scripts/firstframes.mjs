// First-frames check: films the first seconds of page load, which the other smoke tests skip (they look after 2.5 s,
// once the page has settled). A frame that flashes for 50 ms on a real phone is still a frame people see.
// Usage: node scripts/firstframes.mjs [outDir]
// Env: PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST (html file, default dist-single/index.html),
//      ENGINES (comma list, default "chromium,webkit").
// How: before the page's own code runs, every WebGL draw call and every animation frame is wrapped. After each frame
// that drew to the map's canvas, it notes the canvas's pixel buffer size, its size on screen and whether it is visible.
// FAILS (exit 1) when, from the first frame until 1.5 s after the map shows, a visible map frame was:
//   - stretched: drawn into a buffer that is not the canvas's size on screen (blurry, and zoomed in or squashed),
//   - misplaced: a canvas that does not cover the map area (offset or cropped),
//   - or when the map never shows (15 s).
// Chromium also saves a filmstrip (the screen as painted, every frame) as one contact sheet per screen, for the visual
// review in CONTRIBUTING.md.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const out = process.argv[2] ?? 'screenshots/firstframes';
mkdirSync(out, { recursive: true });
const file = pathToFileURL(resolve(process.env.DIST ?? 'dist-single/index.html')).href;
const engines = (process.env.ENGINES ?? 'chromium,webkit').split(',');
// Software GL in CI draws its first map frame anywhere from 1 to 6 s in (a phone takes well under a second), so watch
// until the map shows (WATCH_MS at most), then AFTER_MS longer for the frames that follow it.
const WATCH_MS = 15000;
const AFTER_MS = 1500;

// [name, engine, width, height, pixel ratio, phone]: the phones the first flash was seen on, and two desktops.
const screens = [
  ['iphone-15', 'webkit', 393, 852, 3, true],
  ['iphone-15-landscape', 'webkit', 852, 393, 3, true],
  ['pixel-7', 'chromium', 412, 915, 2.625, true],
  ['laptop', 'chromium', 1280, 720, 1, false],
  ['mac-retina', 'webkit', 1440, 900, 2, false],
].filter((s) => engines.includes(s[1]));

// Runs in the page before any of its scripts. Kept small and self-contained: it is a string to the browser.
const recorder = () => {
  const log = [];
  const t0 = performance.now();
  let drew = new Set();
  // Canvases that have drawn to the screen at least once: looked at every frame after that, since a frame that draws
  // nothing still shows the last picture, stretched if the canvas has since changed size.
  const seen = new Set();
  const wrap = (proto) => {
    if (!proto) return;
    // Draw calls only: a clear alone shows nothing that could look stretched.
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const orig = proto[name];
      if (orig) proto[name] = function (...a) {
        // Only draws to the screen count (not to an offscreen buffer, such as picking).
        if (!this.getParameter(this.FRAMEBUFFER_BINDING)) drew.add(this.canvas);
        return orig.apply(this, a);
      };
    }
  };
  wrap(window.WebGLRenderingContext?.prototype);
  wrap(window.WebGL2RenderingContext?.prototype);
  const visible = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
    }
    return true;
  };
  const note = () => {
    for (const c of drew) seen.add(c);
    drew = new Set();
    if (!seen.size) return;
    const t = Math.round(performance.now() - t0);
    for (const c of seen) {
      if (!(c instanceof HTMLCanvasElement) || !c.isConnected) continue;
      const r = c.getBoundingClientRect();
      const host = (c.closest('#map') ?? c.parentElement).getBoundingClientRect();
      log.push({
        t, wall: Date.now(), buf: [c.width, c.height], css: [r.width, r.height], dpr: devicePixelRatio, on: visible(c),
        rect: [r.left, r.top, r.right, r.bottom].map(Math.round), host: [host.left, host.top, host.right, host.bottom].map(Math.round),
      });
    }
  };
  // Every animation-frame callback is followed by a look at what it drew, while it is still in the frame being painted.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => {
    try { cb(ts); } finally { if (!window.__firstFramesStop) note(); }
  });
  window.__firstFrames = log;
};

const problems = [];
for (const e of new Set(screens.map((s) => s[1]))) {
  const browser = await pw[e].launch(
    e === 'chromium'
      ? { executablePath: process.env.CHROMIUM || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
      : {},
  );
  for (const [name, engine, width, height, dpr, phone] of screens.filter((s) => s[1] === e)) {
    const fail = (m) => problems.push(`${name}: ${m}`);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: phone, isMobile: phone });
    await ctx.addInitScript(recorder);
    const page = await ctx.newPage();
    page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && fail(`external request ${r.url()}`));
    page.on('console', (m) => m.type() === 'error' && fail(`console error: ${m.text()}`));
    page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
    // Chromium: film the screen as painted (every frame that changes), for the contact sheet.
    const frames = [];
    let cdp = null;
    if (engine === 'chromium') {
      cdp = await ctx.newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
        frames.push({ t: metadata.timestamp, data });
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    }
    await page.goto(file);
    const showed = await page
      .waitForFunction(() => window.__firstFrames.some((f) => f.on), null, { timeout: WATCH_MS, polling: 100 })
      .then(() => true, () => false);
    if (showed) await page.waitForTimeout(AFTER_MS);
    await page.evaluate(() => (window.__firstFramesStop = true));
    if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
    const log = await page.evaluate(() => window.__firstFrames);
    writeFileSync(`${out}/${name}.json`, JSON.stringify(log));

    // What reached the screen: map frames drawn while the canvas was visible.
    const shown = log.filter((f) => f.on && f.css[0] > 0 && f.css[1] > 0);
    if (!shown.length) fail(`the map never showed in ${WATCH_MS / 1000} s`);
    // The app may draw at fewer pixels than the screen has (it caps the pixel ratio at 2), so a buffer can be up to
    // devicePixelRatio times the CSS size. Stretched: width and height scaled differently. Blurry: fewer pixels than CSS.
    const stretched = shown.filter((f) => {
      const [sx, sy] = [f.buf[0] / f.css[0], f.buf[1] / f.css[1]];
      return Math.abs(sx - sy) / Math.max(sx, sy) > 0.03 || Math.min(sx, sy) < 0.95 || Math.max(sx, sy) > f.dpr * 1.05;
    });
    if (stretched.length) {
      const f = stretched[0];
      fail(`${stretched.length} visible frame(s) stretched, first at ${f.t} ms: drawn at ${f.buf.join('x')} px, shown at ` +
        `${f.css.map(Math.round).join('x')} CSS px (blurry and zoomed)`);
    }
    const off = shown.filter((f) => f.rect.some((v, i) => Math.abs(v - f.host[i]) > 2));
    if (off.length) fail(`${off.length} visible frame(s) misplaced, first at ${off[0].t} ms: canvas at [${off[0].rect}], map area at [${off[0].host}]`);
    const first = shown[0];
    console.log(`${name}: ${log.length} map frames drawn, first visible at ${first ? first.t + ' ms' : 'never'}` +
      `${first ? ` (${first.buf.join('x')} px)` : ''}${frames.length ? `, ${frames.length} frames filmed` : ''}`);

    // The contact sheet: up to 13 of the filmed frames, side by side, with their time. Frames that barely differ from the one
    // before (the loading caterpillar inching) are skipped first, so the sheet spends its room on what changed.
    if (frames.length) {
      const start = frames[0].t;
      const early = frames.filter((f, i) => i === 0 || i === frames.length - 1 || Math.abs(f.data.length / frames[i - 1].data.length - 1) > 0.03);
      const even = early.length <= 10 ? early : Array.from({ length: 10 }, (_, i) => early[Math.round((i * (early.length - 1)) / 9)]);
      // Always the frame painted just after the map first showed and after the first bad frame (both clocks are wall
      // time on this machine), and last, the page once settled.
      const at = (wall) => wall && frames.findLast((f) => f.t <= wall / 1000 + 0.1);
      const pick = [...new Set([...even, at(first?.wall), at(stretched[0]?.wall ?? off[0]?.wall)].filter(Boolean))].sort((x, y) => x.t - y.t);
      pick.push({ t: Date.now() / 1000, data: (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64'), settled: true });
      const sheet = await page.evaluate(async ({ pick, start }) => {
        const imgs = await Promise.all(pick.map(async (f) => createImageBitmap(await (await fetch('data:image/jpeg;base64,' + f.data)).blob())));
        const w = imgs[0].width > imgs[0].height ? 360 : 240;
        const h = Math.round((imgs[0].height / imgs[0].width) * w);
        const cols = Math.min(6, imgs.length);
        const rows = Math.ceil(imgs.length / cols);
        const c = new OffscreenCanvas(cols * (w + 8) + 8, rows * (h + 28) + 8);
        const g = c.getContext('2d');
        g.fillStyle = '#222';
        g.fillRect(0, 0, c.width, c.height);
        g.font = '14px sans-serif';
        imgs.forEach((im, i) => {
          const x = 8 + (i % cols) * (w + 8);
          const y = 8 + Math.floor(i / cols) * (h + 28);
          g.drawImage(im, x, y + 20, w, h);
          g.fillStyle = '#fff';
          g.fillText(`${Math.round((pick[i].t - start) * 1000)} ms${pick[i].settled ? ' (settled)' : ''}`, x, y + 14);
        });
        const blob = await c.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      }, { pick: pick.map((f) => ({ t: f.t, data: f.data, settled: !!f.settled })), start });
      writeFileSync(`${out}/${name}-filmstrip.png`, Buffer.from(sheet, 'base64'));
    }
    await ctx.close();
  }
  await browser.close();
}

if (problems.length) {
  console.error(`\nFIRST FRAMES: ${problems.length} problem(s)\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nfirst frames: OK');
