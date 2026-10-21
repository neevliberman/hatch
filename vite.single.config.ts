import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Second build target: ONE self-contained dist-single/index.html (JS, CSS and data inlined).
// Handy for previewing as a hosted page or emailing; the real deploy uses the normal build.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { outDir: 'dist-single', target: 'es2022', assetsInlineLimit: 100_000_000 },
});
