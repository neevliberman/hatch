import { defineConfig } from 'vite';

// Normal multi-file build -> dist/. Relative base so it works under any sub-path (GitHub Pages etc.).
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
  define: { __BASEMAP__: true },
});
