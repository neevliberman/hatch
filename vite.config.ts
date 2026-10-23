import { defineConfig } from 'vite';
import packReplay from './scripts/pack-replay.mjs';

// Terser with two passes squeezes deck.gl about 2% smaller than the default esbuild minifier (~11 KB gzipped in the
// one-file build); the build takes ~10 s longer.
const TERSER = { compress: { passes: 2 }, format: { comments: false } };

// Libraries and data change far less often than the app's own code. In their own files (each named by a hash
// of its contents) a returning visitor's browser keeps them across deploys and re-downloads only what changed,
// instead of one ~430 KB file every time anything changes. They also download in parallel.
const chunkOf = (id: string): string | undefined => {
  if (id.includes('/node_modules/h3-js/')) return 'h3';
  if (/\/node_modules\/(@deck\.gl|@luma\.gl|@math\.gl|@loaders\.gl|@probe\.gl|mjolnir\.js|earcut|gl-matrix)\//.test(id)) return 'deck';
  if (id === '\0hatch-packed-replay') return 'replay-data'; // src/data/luna-replay.json, see scripts/pack-replay.mjs
  return undefined;
};

// Normal multi-file build -> dist/. Relative base so it works under any sub-path (GitHub Pages etc.).
export default defineConfig({
  base: './',
  plugins: [packReplay()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    // deck.gl alone is ~1.1 MB minified (~320 KB gzipped): expected (scripts/budget.mjs caps the one-file build).
    chunkSizeWarningLimit: 1500,
    minify: 'terser',
    terserOptions: TERSER,
    rollupOptions: { output: { manualChunks: chunkOf } },
  },
  define: { __BASEMAP__: true },
});
