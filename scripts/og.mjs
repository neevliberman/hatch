// Share card (public/og.png, 1200x630): what a link to Hatch looks like in iMessage, Slack, LinkedIn etc.
// A real screenshot of the map in mid-June, taped into a Field Notebook page beside the logo and the title.
// Usage: npm run build:single && node scripts/og.mjs   (re-run when the look of the map changes)
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const app = pathToFileURL(resolve(process.env.DIST ?? 'dist-single/index.html')).href;
// Fonts go in as data URLs: a page made with setContent may not load file:// fonts.
const font = (f) => `data:font/woff2;base64,${readFileSync(resolve('src/fonts', f)).toString('base64')}`;
const logo = readFileSync('public/icons/hatch.svg', 'utf8');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// 1. The map alone, all years pooled, 10 June (the wave mid-way north), with the page's panels hidden.
const mapPage = await browser.newPage({ viewport: { width: 620, height: 520 }, deviceScaleFactor: 2 });
await mapPage.goto(`${app}?date=06-10&noauto`);
await mapPage.addStyleTag({ content: '#top, #bottom, #drawer { display: none !important; }' });
await mapPage.waitForTimeout(3000);
const shot = (await mapPage.screenshot()).toString('base64');

// 2. The card.
const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await card.setContent(`<!doctype html><html><head><style>
@font-face { font-family: Fraunces; font-weight: 700; src: url('${font('fraunces-latin-700-normal.woff2')}'); }
@font-face { font-family: Atkinson; font-weight: 400; src: url('${font('atkinson-hyperlegible-latin-400-normal.woff2')}'); }
@font-face { font-family: Caveat; font-weight: 600; src: url('${font('caveat-latin-600-normal.woff2')}'); }
* { box-sizing: border-box; }
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; position: relative; color: #2b241c; font-family: Atkinson;
  background: #f8f2e3 repeating-linear-gradient(180deg, transparent 0 37px, rgba(70, 52, 30, .13) 37px 38px); }
body::before { content: ''; position: absolute; top: 0; bottom: 0; left: 64px; width: 2px; background: rgba(166, 63, 25, .35); }
.text { position: absolute; left: 104px; top: 70px; width: 480px; }
.logo { width: 132px; height: 132px; margin: 0 0 14px -14px; transform: rotate(-6deg); }
h1 { font: 700 104px/1 Fraunces; margin: 0; letter-spacing: -1px; }
.note { font: 600 41px/1.05 Caveat; color: #8c570c; margin: 10px 0 22px; }
p { font-size: 25px; line-height: 1.38; margin: 0; color: #2b241c; }
.url { position: absolute; left: 104px; bottom: 34px; font-size: 21px; color: #6e6352; }
.photo { position: absolute; right: 56px; top: 50px; width: 540px; padding: 12px 12px 14px; background: #fffdf6;
  box-shadow: 0 10px 28px rgba(60, 40, 20, .28); transform: rotate(2.2deg); }
.photo img { display: block; width: 516px; height: 433px; object-fit: cover; }
.photo figcaption { font: 600 30px/1 Caveat; color: #6e6352; margin: 10px 4px 0; }
.tape { position: absolute; width: 130px; height: 34px; background: rgba(214, 196, 150, .7); top: -14px; }
.tape.l { left: -30px; transform: rotate(-32deg); } .tape.r { right: -30px; transform: rotate(28deg); }
</style></head><body>
<div class="text">
  <div class="logo">${logo.replace('<svg ', '<svg width="100%" height="100%" ').replace(/<rect class="tile"[^>]*>/, '')}</div>
  <h1>Hatch</h1>
  <div class="note">when do insects come out?</div>
  <p>Watch luna moths and fireflies roll north with the warmth across the Midwest: a heat forecast, checked against real sightings.</p>
</div>
<div class="url">neevliberman.github.io/hatch</div>
<figure class="photo" style="margin:0"><span class="tape l"></span><span class="tape r"></span>
  <img src="data:image/png;base64,${shot}" alt=""><figcaption>Luna moths on 10 June, every year since 2015</figcaption></figure>
</body></html>`);
await card.evaluate(() => document.fonts.ready);
await card.waitForTimeout(300);
await card.screenshot({ path: 'public/og.png' });
await browser.close();
console.log('wrote public/og.png');
