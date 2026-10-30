import { defineConfig, type Plugin } from 'vite';
import packReplay from './scripts/pack-replay.mjs';
import leanDeps from './scripts/lean-deps.mjs';
import packBasemap from './scripts/pack-basemap.mjs';
import { loaderHtml } from './src/ui/loader';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Writes dist/sw.js (the offline service worker, src/sw.js) once everything else is built. Its version is a hash of
// every file in dist/ and of the template, so any change at all, code or data, rolls out a fresh cache. The precache list is the app
// shell: the page, its bundles and fonts, the manifest and the tab icons. The finer hexagons (~2 MB) are cached as viewed. The
// home-screen icons (icons/, ~57 KB) are left out: a phone fetches them once, when it installs the app, and keeps its own copy.
function serviceWorker(): Plugin {
  let outDir = 'dist';
  let template = 'src/sw.js';
  return {
    name: 'hatch-sw',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
      template = resolve(c.root, 'src/sw.js');
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
      const files = walk(outDir).map((f) => relative(outDir, f).split(sep).join('/')).filter((f) => f !== 'sw.js').sort();
      const src = readFileSync(template, 'utf8');
      const hash = createHash('sha256').update(src);
      // Not the nightly live forecast: the worker fetches it network-first, so a new night needn't replace the whole cache.
      for (const f of files.filter((f) => !f.startsWith('live/'))) hash.update(f).update(readFileSync(join(outDir, f)));
      // Not the radar replay's code (assets/radar*): few open it, so it is cached when it is, like its frames.
      const shell = files.filter((f) => /^assets\/|^(index\.html|manifest\.webmanifest|favicon[^/]*)$/.test(f) && !f.startsWith('assets/radar'));
      const sw = src
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify(['./', ...shell.filter((f) => f !== 'index.html')]));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

// Terser with two passes squeezes deck.gl about 2% smaller than the default esbuild minifier (~11 KB gzipped in the
// one-file build); the build takes ~10 s longer.
const TERSER = { compress: { passes: 2 }, format: { comments: false } };

// Libraries and data change far less often than the app's own code. In their own files (each named by a hash
// of its contents) a returning visitor's browser keeps them across deploys and re-downloads only what changed,
// instead of one ~430 KB file every time anything changes. They also download in parallel.
const chunkOf = (id: string): string | undefined => {
  if (id.includes('/node_modules/h3-js/')) return 'h3';
  // The one deck layer only the radar replay uses (src/radar/radarReplay.ts, a chunk of its own): loaded with it.
  if (/\/@deck\.gl\/layers\/dist[^/]*\/bitmap-layer\//.test(id)) return 'radar-layer';
  if (/\/node_modules\/(@deck\.gl|@luma\.gl|@math\.gl|@loaders\.gl|@probe\.gl|mjolnir\.js|earcut|gl-matrix)\//.test(id)) return 'deck';
  if (id === '\0hatch-packed-replay') return 'replay-data'; // src/data/luna-replay.json, see scripts/pack-replay.mjs
  return undefined;
};

// The loading caterpillar is drawn with the About panel's pen code at build time and written into the page, so it
// shows before any script has arrived. Shared with the one-file build.
export const loader = (): Plugin => ({ name: 'hatch-loader', transformIndexHtml: (html) => html.replace('<!-- loader -->', loaderHtml()) });

// Normal multi-file build -> dist/. Relative base so it works under any sub-path (GitHub Pages etc.).
export default defineConfig({
  base: './',
  plugins: [leanDeps(), packReplay(), packBasemap(), serviceWorker(), loader()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    // deck.gl alone is ~1.1 MB minified (~320 KB gzipped): expected (scripts/budget.mjs caps the one-file build).
    chunkSizeWarningLimit: 1500,
    minify: 'terser',
    terserOptions: TERSER,
    rollupOptions: { output: { manualChunks: chunkOf } },
  },
  define: { __BASEMAP__: true, __HATCH_SW__: 'true' },
});
