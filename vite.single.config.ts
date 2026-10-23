import { defineConfig } from 'vite';
import packReplay from './scripts/pack-replay.mjs';

// Terser with two passes squeezes deck.gl about 2% smaller than the default esbuild minifier (~11 KB gzipped in the
// one-file build); the build takes ~10 s longer.
const TERSER = { compress: { passes: 2 }, format: { comments: false } };
import { viteSingleFile } from 'vite-plugin-singlefile';

// Second build target: ONE self-contained dist-single/index.html (JS, CSS and data inlined).
// Handy for previewing as a hosted page or emailing; the real deploy uses the normal build.
export default defineConfig({
  base: './',
  plugins: [packReplay(), viteSingleFile()],
  build: { outDir: 'dist-single', target: 'es2022', assetsInlineLimit: 100_000_000, minify: 'terser', terserOptions: TERSER },
  // Map detail loads from files beside the page, which the one-file build has none of: leave that code out.
  define: { __BASEMAP__: false },
});
