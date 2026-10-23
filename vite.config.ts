import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Writes dist/sw.js (the offline service worker, src/sw.js) once everything else is built. Its version is a hash of
// every file in dist/ and of the template, so any change at all, code or data, rolls out a fresh cache. The precache list is the app
// shell: the page, its bundles and fonts, the manifest and icons. The finer hexagons (~2 MB) are cached as viewed.
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
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const shell = files.filter((f) => /^(assets\/|icons\/)|^(index\.html|manifest\.webmanifest|favicon[^/]*)$/.test(f));
      const sw = src
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify(['./', ...shell.filter((f) => f !== 'index.html')]));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

// Libraries and data change far less often than the app's own code. In their own files (each named by a hash
// of its contents) a returning visitor's browser keeps them across deploys and re-downloads only what changed,
// instead of one ~430 KB file every time anything changes. They also download in parallel.
const chunkOf = (id: string): string | undefined => {
  if (id.includes('/node_modules/h3-js/')) return 'h3';
  if (/\/node_modules\/(@deck\.gl|@luma\.gl|@math\.gl|@loaders\.gl|@probe\.gl|mjolnir\.js|earcut|gl-matrix)\//.test(id)) return 'deck';
  if (id.endsWith('/src/data/luna-replay.json')) return 'replay-data';
  return undefined;
};

// Normal multi-file build -> dist/. Relative base so it works under any sub-path (GitHub Pages etc.).
export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    // deck.gl alone is ~1.1 MB minified (~320 KB gzipped): expected (scripts/budget.mjs caps the one-file build).
    chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks: chunkOf } },
  },
  define: { __BASEMAP__: true, __HATCH_SW__: 'true' },
});
