// App icons from the hand-drawn moth: home-screen and install icons (PNG) for phones that don't take SVG icons.
// Usage: node scripts/icons.mjs   (re-run after editing public/icons/moth.svg or public/favicon.svg)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const PAPER = '#f8f2e3';
const moth = readFileSync('public/icons/moth.svg', 'utf8').replace('<svg ', '<svg width="100%" height="100%" ');
const favicon = readFileSync('public/favicon.svg', 'utf8').replace('<svg ', '<svg width="100%" height="100%" ');
// [file, size, svg, padding as a share of the side]. Maskable icons get cropped to a circle or squircle by
// Android, so their moth stays inside the middle 80% "safe zone"; iOS rounds the corners of apple-touch-icon itself.
const icons = [
  ['icons/icon-192.png', 192, moth, 0.06],
  ['icons/icon-512.png', 512, moth, 0.06],
  ['icons/icon-maskable-512.png', 512, moth, 0.17],
  ['icons/apple-touch-icon.png', 180, moth, 0.08],
  ['favicon-32.png', 32, favicon, 0],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
for (const [file, size, svg, pad] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = Math.round(size * (1 - 2 * pad));
  const bg = svg === favicon ? 'transparent' : PAPER;
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${bg}">
    <div style="width:${inner}px;height:${inner}px">${svg}</div></body>`);
  await page.screenshot({ path: `public/${file}`, omitBackground: bg === 'transparent' });
  await page.close();
}
await browser.close();
console.log(`wrote ${icons.length} icons`);
