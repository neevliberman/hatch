import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The one-file build is opened from disk or an artifact host, where an install manifest can't load (and would log
// an error): drop the link. The service worker is off here too (__HATCH_SW__).
const noManifest = (): Plugin => ({
  name: 'hatch-no-manifest',
  transformIndexHtml: (html) => html.replace(/\s*<link rel="manifest"[^>]*>/, ''),
});

// Second build target: ONE self-contained dist-single/index.html (JS, CSS and data inlined).
// Handy for previewing as a hosted page or emailing; the real deploy uses the normal build.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile(), noManifest()],
  define: { __HATCH_SW__: 'false' },
  build: { outDir: 'dist-single', target: 'es2022', assetsInlineLimit: 100_000_000 },
});
