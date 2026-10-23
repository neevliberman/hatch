import { defineConfig, type Plugin } from 'vite';
import packReplay from './scripts/pack-replay.mjs';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { loader } from './vite.config';
import { readFileSync } from 'node:fs';

// The one-file build has to work as a lone file (emailed, on an artifact host), so nothing may point at public/:
// the tab icon goes in as a data URL, and the install-only links go. An install manifest
// can't load from file:// anyway (and would log an error). The service worker is off here too (__HATCH_SW__).
const selfContained = (): Plugin => ({
  name: 'hatch-self-contained',
  transformIndexHtml(html) {
    const icon = `data:image/svg+xml,${encodeURIComponent(readFileSync('public/favicon.svg', 'utf8').replace(/<!--.*?-->\s*/gs, ''))}`;
    return html
      .replace(/\s*<link rel="(manifest|apple-touch-icon)"[^>]*>/g, '')
      .replace(/\s*<link rel="icon" href="[^"]*\.png"[^>]*>/, '')
      .replace(/"\.?\/favicon\.svg"/g, `"${icon}"`);
  },
});

// Terser with two passes squeezes deck.gl about 2% smaller than the default esbuild minifier (~11 KB gzipped in the
// one-file build); the build takes ~10 s longer.
const TERSER = { compress: { passes: 2 }, format: { comments: false } };

// Second build target: ONE self-contained dist-single/index.html (JS, CSS and data inlined).
// Handy for previewing as a hosted page or emailing; the real deploy uses the normal build.
export default defineConfig({
  base: './',
  plugins: [packReplay(), loader(), viteSingleFile(), selfContained()],
  build: { outDir: 'dist-single', target: 'es2022', assetsInlineLimit: 100_000_000, minify: 'terser', terserOptions: TERSER },
  // Map detail loads from files beside the page, which the one-file build has none of: leave that code out.
  define: { __BASEMAP__: false, __HATCH_SW__: 'false' },
});
