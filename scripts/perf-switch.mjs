// Species-switch timing on a weak phone: software GL (SwiftShader) and the CPU slowed 4x (CDP), a phone viewport.
// Usage: node scripts/perf-switch.mjs [runs]   (default 3; prints each run and the medians as JSON lines)
// Env: PARTS (switch,scrub,link,cold: which measurements, default switch,scrub; link: the first field from a ?species=
//      link; cold: a plain first visit, luna's field; each with the longest long task before that field), PLAYWRIGHT_PATH (module path), CHROMIUM (browser binary), DIST_DIR (http build, default dist/; built if missing),
//      CPU (throttle rate, default 4), PROFILE=1 (a CPU profile of one run's switches: the top functions by self and
//      total time; an unminified build reads best: npx vite build --minify false --outDir dist-prof), PROFILE_FIRST=1
//      (the same for the first load), DETAIL=1 (each switch's gaps, long tasks, network runs and files, from the tap),
//      CPU_ONLY=1 (the network's own WebGL2 context refused: the plain-network path).
// The one-file build has no Atlas (its files sit beside the page), so this serves dist/ over http, as mobile.mjs does
// for its species cases. Measures, per run: the first Atlas field drawn from a ?species= link (and when the loader
// went), then six switches (big and small species) from the picker: until the new field is drawn, and the longest
// frame gap and long task from the tap until 3 s after it is drawn. Each tap waits for a settled page first.
// "Drawn" is the new species' first field on screen: when its season moves the day, the nearest day ready stands in
// while that day is worked out (DETAIL shows when the network finishes it).
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const RUNS = Number(process.argv[2] ?? 3);
const CPU = Number(process.env.CPU ?? 4);
const SETTLE = 3000;
const FIRST = 'papilio-glaucus';
// Big (thousands of records and dots) and small (about 100-350), alternating.
const SWITCHES = ['bombus-impatiens', 'meropleon-ambifusca', 'apis-mellifera', 'tipula-fuliginosa', 'harmonia-axyridis', 'chrysopa-nigricornis'];

const distDir = resolve(process.env.DIST_DIR ?? 'dist');
if (!existsSync(join(distDir, 'atlas'))) execSync('npx vite build --logLevel warn', { stdio: 'inherit' });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = join(distDir, path);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!f.startsWith(distDir) || !existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// In the page, from its first script: long tasks, the gaps between animation frames, and when each species' field is
// first in the drawn layers (stamped at the next frame, once deck has painted it).
const probe = (cpuOnly) => {
  if (cpuOnly) {
    const get = HTMLCanvasElement.prototype.getContext;
    const off = globalThis.OffscreenCanvas?.prototype.getContext;
    const no = (orig) => function (kind, ...a) {
      const gl = orig.call(this, kind, ...a);
      if (gl && kind === 'webgl2' && (this.width === 1 && this.height === 1)) return null; // the network's own context
      return gl;
    };
    HTMLCanvasElement.prototype.getContext = no(get);
    if (off) OffscreenCanvas.prototype.getContext = no(off);
  }
  const P = (window.__perf = { long: [], gaps: [], drawnAt: {}, loaderAt: null });
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => P.long.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true });
  } catch {}
  // A plain visit's first field: luna's hexagons are in the page, so they are on screen with the map's first frame (the
  // map shows itself after a render), unless they were not in that frame: then at the frame after they are.
  const hexes = () => window.__hatch?.map.drawn().some((l) => /-forecast-r\d/.test(l));
  new MutationObserver(() => {
    if (P.hexAt === undefined && document.querySelector('#map.drawn') && hexes()) P.hexAt = performance.now();
  }).observe(document, { attributes: true, attributeFilter: ['class'], subtree: true });
  let last = performance.now();
  let seen = null;
  const tick = (now) => {
    if (now - last > 50) P.gaps.push([last, now - last]);
    P.last = last = now;
    if (seen) for (const id of seen) P.drawnAt[id] ??= now;
    seen = null;
    const h = window.__hatch;
    if (h) {
      const want = h.current().id.replace(/-atlas$/, '-forecast-r4');
      if (want !== h.current().id && !P.drawnAt[want] && h.map.drawn().includes(want)) seen = [want];
    }
    if (P.loaderAt === null && document.getElementById('loader')?.classList.contains('done')) P.loaderAt = now;
    // Any species' first field on screen: its hexagons in the drawn layers, with the map shown (a plain visit's luna).
    if (P.hexAt === undefined && document.querySelector('#map.drawn') && hexes()) P.hexSeen ? (P.hexAt = now) : (P.hexSeen = true);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r0 = (v) => (v == null ? null : Math.round(v));

const oneRun = async (profile) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true });
  await ctx.addInitScript(probe, !!process.env.CPU_ONLY);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const t = { switches: [] };
  if (process.env.PROFILE_FIRST) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  await page.goto(`${origin}/?species=${FIRST}&noauto&date=06-15`);
  const fid = `${FIRST}-forecast-r4`;
  await page.waitForFunction((id) => window.__perf.drawnAt[id], fid, { timeout: 180000, polling: 250 });
  await page.waitForTimeout(SETTLE);
  const first = await page.evaluate((id) => ({ drawn: window.__perf.drawnAt[id], loader: window.__perf.loaderAt, gpu: null }), fid);
  first.gpu = await page.evaluate(async () => !!(await window.__hatch.atlas())?.gpu);
  t.first = { drawn: r0(first.drawn), loader: r0(first.loader), gpu: first.gpu };
  if (process.env.PROFILE_FIRST) {
    const { profile: p } = await cdp.send('Profiler.stop');
    t.profile = summarise(p);
    t.first.long = await page.evaluate(() => window.__perf.long.map(([s, d]) => `${Math.round(s)}+${Math.round(d)}`).join(' '));
  }
  // DETAIL=1: each switch's frame gaps and long tasks from the tap, and each graphics-card run of the network.
  if (process.env.DETAIL) await page.evaluate(async () => {
    const g = (await window.__hatch.atlas())?.gpu;
    window.__perf.gpu = [];
    for (const k of ['basis', 'run', 'all']) {
      const f = g?.[k];
      if (f) g[k] = function (...a) {
        const s = performance.now();
        const log = () => window.__perf.gpu.push([`${k}(${typeof a[1] === 'number' ? a[1] : 'days'})`, s, performance.now() - s]);
        const r = f.apply(this, a);
        if (r instanceof Promise) r.finally(log);
        else log();
        return r;
      };
    }
  });
  if (profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  for (const key of SWITCHES) {
    const id = `${key}-forecast-r4`;
    // The picker as a reader uses it: open, type, tap the row (plain DOM clicks: Playwright's own would wait for two
    // still frames first, which a software-drawn page can take seconds to give).
    await page.evaluate(() => document.getElementById('species').click());
    await page.waitForSelector('#sp-q', { state: 'visible', timeout: 30000 });
    await page.evaluate((k) => {
      const q = document.getElementById('sp-q');
      q.value = k.replace(/-/g, ' ');
      q.dispatchEvent(new Event('input', { bubbles: true }));
    }, key);
    await page.waitForFunction((k) => document.querySelector(`#sp-list [data-key="${k}"]`), key, { timeout: 30000, polling: 250 });
    // Tap once the page has settled (no frame gap over 50 ms for a second), so the picker's own drawing is not counted.
    await page.waitForFunction(() => {
      const g = window.__perf.gaps.at(-1);
      return performance.now() - window.__perf.last < 100 && (!g || performance.now() - (g[0] + g[1]) > 1000);
    }, null, { timeout: 60000, polling: 250 });
    const t0 = await page.evaluate((k) => {
      const t0 = performance.now();
      document.querySelector(`#sp-list [data-key="${k}"]`).click();
      return t0;
    }, key);
    await page.waitForFunction((id) => window.__perf.drawnAt[id], id, { timeout: 180000, polling: 250 });
    await page.waitForTimeout(SETTLE);
    const m = await page.evaluate(([id, t0, settle]) => {
      const P = window.__perf;
      const end = P.drawnAt[id] + settle;
      const within = (s, d) => s + d >= t0 && s <= end;
      const rel = (xs) => xs.filter(([s, d]) => within(s, d)).map(([s, d]) => `${Math.round(s - t0)}+${Math.round(d)}`).join(' ');
      return {
        ...(P.gpu ? { detail: { gaps: rel(P.gaps), long: rel(P.long), gpu: P.gpu.filter(([, s, d]) => within(s, d)).map(([k, s, d]) => `${k}@${Math.round(s - t0)}+${Math.round(d)}`).join(' '),
          files: performance.getEntriesByType('resource').filter((e) => within(e.startTime, e.duration)).map((e) => `${e.name.split('/').slice(-2).join('/')}@${Math.round(e.responseEnd - t0)}`).join(' ') } } : {}),
        drawn: P.drawnAt[id] - t0,
        gap: Math.max(0, ...P.gaps.filter(([s, d]) => within(s, d)).map(([, d]) => d)),
        long: Math.max(0, ...P.long.filter(([s, d]) => within(s, d)).map(([, d]) => d)),
      };
    }, [id, t0, SETTLE]);
    t.switches.push({ key, drawn: r0(m.drawn), gap: r0(m.gap), long: r0(m.long), ...(m.detail ? { detail: m.detail } : {}) });
  }
  if (profile) {
    const { profile: p } = await cdp.send('Profiler.stop');
    t.profile = summarise(p);
  }
  t.errors = errors;
  await ctx.close();
  return t;
};

// Self time and total time by function (name, file, line), from a CDP CPU profile.
const summarise = (p, spans = [], offset = 0) => {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map();
  const dt = p.timeDeltas;
  const hits = new Map();
  p.samples.forEach((s, k) => hits.set(s, (hits.get(s) ?? 0) + (dt[k + 1] ?? 0)));
  const label = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  const total = new Map();
  for (const [id, us] of hits) {
    const n = byId.get(id);
    self.set(label(n), (self.get(label(n)) ?? 0) + us);
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) {
      const l = label(byId.get(x));
      if (seen.has(l)) continue;
      seen.add(l);
      total.set(l, (total.get(l) ?? 0) + us);
    }
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([l, us]) => `${Math.round(us / 1000)} ms  ${l}`);
  const windows = spans.map(([s0, d]) => {
    const w = new Map();
    const ws = new Map();
    let ts = p.startTime;
    p.samples.forEach((id, k) => {
      ts += dt[k] ?? 0;
      const ms = ts / 1000 - offset;
      if (ms < s0 || ms > s0 + d) return;
      const us = dt[k + 1] ?? 0;
      ws.set(label(byId.get(id)), (ws.get(label(byId.get(id))) ?? 0) + us);
      const seen = new Set();
      for (let x = id; x !== undefined; x = parent.get(x)) {
        const l = label(byId.get(x));
        if (seen.has(l) || l.startsWith('(root)')) continue;
        seen.add(l);
        w.set(l, (w.get(l) ?? 0) + us);
      }
    });
    return `@${Math.round(s0)}+${Math.round(d)}: self ${top(ws, 4).join(', ')}\n    ` + top(w, 14).join('\n    ');
  });
  return { self: top(self, 30), total: top(total, 45), windows };
};

// The date slider dragged a day at a time through SCRUB_DAYS new days, on the first species: in a typical year and in
// ATLAS_YEAR (its days ahead: three clocks, the costlier run). Per day, from the slider's step until the network has
// worked that day out (each graphics-card call logged with its day), and the longest long task over the whole drag;
// then a quick drag (the same number of days, a step every 150 ms) until its last day is worked out.
const SCRUB_DAYS = 10;
const scrubRun = async (season) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true });
  await ctx.addInitScript(probe, false);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.goto(`${origin}/?species=${FIRST}&noauto&date=06-01${season ? `&season=${season}` : ''}`);
  const fid = `${FIRST}-forecast-r4`;
  await page.waitForFunction((id) => window.__perf.drawnAt[id], fid, { timeout: 180000, polling: 250 });
  const first = await page.evaluate((id) => window.__perf.drawnAt[id], fid);
  await page.waitForTimeout(SETTLE);
  await page.evaluate(async () => {
    const g = (await window.__hatch.atlas())?.gpu;
    window.__perf.net = [];
    for (const k of ['basis', 'run']) {
      const f = g?.[k];
      if (f) g[k] = function (...a) {
        const r = f.apply(this, a);
        if (typeof a[1] === 'number') window.__perf.net.push([a[1], performance.now()]);
        return r;
      };
    }
  });
  // One slider step later; resolves with that step's day of year.
  const step = () => page.evaluate(() => {
    const r = document.getElementById('t-range');
    r.value = String(Number(r.value) + 1);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    const t = window.__hatch.time.cursor;
    return [performance.now(), Math.round((t - Date.UTC(new Date(t).getUTCFullYear(), 0, 0)) / 864e5)];
  });
  const doneAt = (day) => page.waitForFunction((d) => window.__perf.net.find((e) => e[0] === d)?.[1], day, { timeout: 120000, polling: 250 }).then((h) => h.jsonValue());
  const from = await page.evaluate(() => performance.now());
  const days = [];
  for (let k = 0; k < SCRUB_DAYS; k++) {
    const [t0, day] = await step();
    days.push((await doneAt(day)) - t0);
    await page.waitForTimeout(300);
  }
  const long = await page.evaluate((t) => Math.max(0, ...window.__perf.long.filter(([s]) => s >= t).map(([, d]) => d)), from);
  await page.waitForTimeout(SETTLE);
  const quickFrom = await page.evaluate(() => performance.now());
  let last = null;
  for (let k = 0; k < SCRUB_DAYS; k++) {
    last = await step();
    await page.waitForTimeout(150);
  }
  const quick = (await doneAt(last[1])) - quickFrom;
  const quickLong = await page.evaluate((t) => Math.max(0, ...window.__perf.long.filter(([s]) => s >= t).map(([, d]) => d)), quickFrom);
  await ctx.close();
  return { first: r0(first), perDay: r0(median(days)), dayMax: r0(Math.max(...days)), long: r0(long), quick: r0(quick), quickLong: r0(quickLong) };
};

// The first field only, in a fresh context (no cache): a ?species= link (its own field, as oneRun's first) or a plain
// first visit (luna's field, the opening playback left to start). Also when the loader went, the longest long task
// and longest frame gap before the field was drawn, the longest long task in the 8 s after it, and the files' timings
// (DETAIL=1).
const AFTER = 8000;
const firstRun = async (kind) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true });
  await ctx.addInitScript(probe, false);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  if (process.env.PROFILE_FIRST) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  const fid = `${FIRST}-forecast-r4`;
  await page.goto(kind === 'link' ? `${origin}/?species=${FIRST}&noauto&date=06-15` : `${origin}/`);
  const at = kind === 'link' ? (id) => window.__perf.drawnAt[id] : () => window.__perf.hexAt;
  await page.waitForFunction(at, fid, { timeout: 180000, polling: 250 });
  // And the longest long task in the AFTER ms after it (the first moments a reader would try the map).
  await page.waitForTimeout(AFTER);
  let profile = null;
  if (process.env.PROFILE_FIRST) {
    const now = await page.evaluate(() => performance.now());
    const p = (await cdp.send('Profiler.stop')).profile;
    // Each long task over 800 ms on its own: what ran in it (page time = profile time - offset, near enough).
    const spans = await page.evaluate(() => window.__perf.long.filter(([, d]) => d > 800));
    profile = summarise(p, spans, p.endTime / 1000 - now);
  }
  const m = await page.evaluate(([kind, id, after]) => {
    const P = window.__perf;
    const drawn = kind === 'link' ? P.drawnAt[id] : P.hexAt;
    const before = (xs) => xs.filter(([s]) => s < drawn);
    return {
      drawn, loader: P.loaderAt,
      after: Math.max(0, ...P.long.filter(([s, d]) => s + d > drawn && s < drawn + after).map(([, d]) => d)),
      long: Math.max(0, ...before(P.long).map(([, d]) => d)),
      gap: Math.max(0, ...before(P.gaps).map(([, d]) => d)),
      longs: before(P.long).map(([s, d]) => `${Math.round(s)}+${Math.round(d)}`).join(' '),
      files: performance.getEntriesByType('resource').filter((e) => e.startTime < drawn).map((e) => `${e.name.split('/').slice(-2).join('/').split('?')[0]}@${Math.round(e.startTime)}-${Math.round(e.responseEnd)}`).join(' '),
    };
  }, [kind, fid, AFTER]);
  await ctx.close();
  const out = { drawn: r0(m.drawn), loader: r0(m.loader), long: r0(m.long), gap: r0(m.gap), after: r0(m.after) };
  if (process.env.DETAIL) Object.assign(out, { longs: m.longs, files: m.files });
  return { out, profile };
};

const PARTS = (process.env.PARTS ?? 'switch,scrub').split(',');
const runs = [];
for (let r = 0; r < RUNS; r++) {
  const t = PARTS.includes('switch') ? await oneRun(process.env.PROFILE && r === 0) : { switches: [], first: {} };
  if (PARTS.includes('scrub')) t.scrub = { typical: await scrubRun(null), year: await scrubRun('2026') };
  for (const kind of ['link', 'cold']) {
    if (!PARTS.includes(kind)) continue;
    const { out, profile } = await firstRun(kind);
    t[kind] = out;
    if (profile && r === 0) t.profile = profile;
  }
  runs.push(t);
  const { profile, ...rest } = t;
  console.log(JSON.stringify({ run: r + 1, ...rest }));
  if (profile) {
    console.log('-- self time --\n' + profile.self.join('\n'));
    console.log('-- total time --\n' + profile.total.join('\n'));
    if (profile.windows?.length) console.log('-- long tasks --\n' + profile.windows.join('\n'));
  }
}
const med = {};
for (const kind of ['link', 'cold']) {
  if (PARTS.includes(kind)) med[kind] = Object.fromEntries(['drawn', 'loader', 'long', 'gap', 'after'].map((k) => [k, median(runs.map((t) => t[kind][k]))]));
}
if (PARTS.includes('scrub')) {
  med.scrub = Object.fromEntries(['typical', 'year'].map((m) => [m, Object.fromEntries(['first', 'perDay', 'dayMax', 'long', 'quick', 'quickLong'].map((k) => [k, median(runs.map((t) => t.scrub[m][k]))]))]));
}
if (PARTS.includes('switch')) Object.assign(med, {
  firstDrawn: median(runs.map((t) => t.first.drawn)),
  loader: median(runs.map((t) => t.first.loader)),
  switches: SWITCHES.map((key, k) => ({
    key,
    drawn: median(runs.map((t) => t.switches[k].drawn)),
    gap: median(runs.map((t) => t.switches[k].gap)),
    long: median(runs.map((t) => t.switches[k].long)),
  })),
});
if (med.switches) {
  med.switchDrawn = median(med.switches.map((s) => s.drawn));
  med.switchGap = median(med.switches.map((s) => s.gap));
  med.switchDrawnMax = Math.max(...med.switches.map((s) => s.drawn));
  med.switchGapMax = Math.max(...med.switches.map((s) => s.gap));
}
console.log(JSON.stringify({ medians: med }));
await browser.close();
server.close();
