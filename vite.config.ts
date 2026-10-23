import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Writes dist/sw.js (the offline service worker, src/sw.js) once everything else is built. Its version is a hash of
// every file in dist/, so any change at all, code or data, rolls out a fresh cache. The precache list is the app
// shell: the page, its bundles and fonts, the manifest and icons. The finer hexagons (~2 MB) are cached as viewed.
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hatch-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
      const files = walk(outDir).map((f) => relative(outDir, f).split(sep).join('/')).filter((f) => f !== 'sw.js').sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const shell = files.filter((f) => /^(assets\/|icons\/)|^(index\.html|manifest\.webmanifest|favicon[^/]*)$/.test(f));
      const sw = readFileSync('src/sw.js', 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify(['./', ...shell.filter((f) => f !== 'index.html')]));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

// Normal multi-file build -> dist/. Relative base so it works under any sub-path (GitHub Pages etc.).
export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  define: { __HATCH_SW__: 'true' },
  build: { outDir: 'dist', target: 'es2022' },
});
