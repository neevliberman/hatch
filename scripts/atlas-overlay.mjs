// Lays the weekly Atlas rebuild (pipeline/atlas/weekly.py, the `atlas-data` release) over the built site's atlas/
// folder, so the site shows the current year. Run by deploy-pages.yml after `npm run build`:
//   node scripts/atlas-overlay.mjs <unpacked release folder> dist/atlas
// It refuses (says why, exit 0, main's files stay) a build that:
//   - is a dry run (a few taxa, capped pages, no dots), or names a year older than main's own year.json;
//   - was built for another species list (count + FNV hash of the names, as atlas.ts hashes them for spread.bin),
//     another cells.json or another model.bin (a new model on main waits for the next weekly run);
//   - does not match its own manifest (year.json "files": every file's sha256, and nothing else in the folder).
// Then it copies only the manifest's files, and swaps this year's dots (dots-year/<i>.bin) into main's own
// dots/<i>.bin in place of that year's rows, so older years' dots always come from main. Last, it restamps dist/sw.js:
// its VERSION was hashed over dist/ before the overlay, and the worker serves atlas files cache-first, so without a
// new VERSION returning visitors would keep last week's data. Exit 1 only on a file it cannot read or write.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';

export function speciesHash(names) {
  const s = names.join('\n');
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193) >>> 0;
  return h;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const rel = (root, f) => relative(root, f).split(sep).join('/');

/** Why the overlay in `src` does not fit the site's atlas folder `dest`, or null when it does. */
export function mismatch(src, dest) {
  const year = JSON.parse(readFileSync(join(src, 'year.json'), 'utf8'));
  if (!Number.isInteger(year.year)) return 'year.json names no year';
  if (year.dry_run || year.subset) return 'it is a dry run';
  const mainYear = existsSync(join(dest, 'year.json')) ? JSON.parse(readFileSync(join(dest, 'year.json'), 'utf8')).year : 2026;
  if (year.year < mainYear) return `it is for ${year.year}, older than main's ${mainYear}`;
  const names = JSON.parse(readFileSync(join(dest, 'species.json'), 'utf8')).slice(0, -1).map((s) => s.name);
  if (year.species !== names.length || year.species_hash !== speciesHash(names)) return 'it was built for another species list';
  if (year.model !== sha(readFileSync(join(dest, 'model.bin'))).slice(0, 12)) return 'it was built for another network';
  if (year.cells !== sha(readFileSync(join(dest, 'cells.json'))).slice(0, 12)) return 'it was built for another cell list';
  const files = year.files ?? {};
  const listed = Object.keys(files);
  if (!listed.length) return 'year.json has no manifest';
  for (const f of listed) {
    if (f.includes('..') || f.startsWith('/')) return `the manifest names an odd path (${f})`;
    if (!existsSync(join(src, f)) || sha(readFileSync(join(src, f))) !== files[f]) return `${f} does not match the manifest`;
  }
  const extra = walk(src).map((f) => rel(src, f)).filter((f) => f !== 'year.json' && !(f in files));
  if (extra.length) return `files not in the manifest: ${extra.slice(0, 3).join(', ')}`;
  return null;
}

/** dots.py's <i>.bin: n rows as parallel little-endian arrays (u32 id, u16 doy, u16 lat, u16 lng, u8 year - 2000). */
export function unpackDots(buf) {
  const n = Math.floor(buf.length / 11);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
  return Array.from({ length: n }, (_, i) => ({
    id: v.getUint32(4 * i, true), doy: v.getUint16(4 * n + 2 * i, true), lat: v.getUint16(6 * n + 2 * i, true),
    lng: v.getUint16(8 * n + 2 * i, true), year: buf[10 * n + i],
  }));
}
export function packDots(rows) {
  const n = rows.length;
  const out = Buffer.alloc(11 * n);
  rows.forEach((r, i) => {
    out.writeUInt32LE(r.id, 4 * i);
    out.writeUInt16LE(r.doy, 4 * n + 2 * i);
    out.writeUInt16LE(r.lat, 6 * n + 2 * i);
    out.writeUInt16LE(r.lng, 8 * n + 2 * i);
    out[10 * n + i] = r.year;
  });
  return out;
}
/** main's rows for every other year, then this year's from the release, sorted by year then day (stable, as dots.py). */
export function swapYear(mainBuf, yearBuf, year) {
  const y = year - 2000;
  const rows = [...unpackDots(mainBuf).filter((r) => r.year !== y), ...unpackDots(yearBuf)];
  return packDots(rows.map((r, k) => [r, k]).sort((a, b) => a[0].year - b[0].year || a[0].doy - b[0].doy || a[1] - b[1]).map(([r]) => r));
}

/** dist/sw.js's VERSION hashed again with every file now in the atlas folder, so the worker's cache rolls over. */
export function restamp(swPath, atlasDir) {
  const sw = readFileSync(swPath, 'utf8');
  const m = sw.match(/const VERSION = '([0-9a-f]+)';/);
  if (!m) throw new Error(`${swPath} has no VERSION to restamp`);
  const h = createHash('sha256').update(m[1]);
  for (const f of walk(atlasDir).sort()) h.update(rel(atlasDir, f)).update(readFileSync(f));
  const v = h.digest('hex').slice(0, 12);
  writeFileSync(swPath, sw.replace(m[0], `const VERSION = '${v}';`));
  return v;
}

export function overlay(src, dest) {
  if (!existsSync(join(src, 'year.json'))) return { skipped: `no year.json in ${src}` };
  const why = mismatch(src, dest);
  if (why) return { skipped: why };
  const year = JSON.parse(readFileSync(join(src, 'year.json'), 'utf8'));
  let dots = 0;
  for (const f of [...Object.keys(year.files), 'year.json']) {
    if (f.startsWith('dots-year/')) {
      const name = f.slice('dots-year/'.length);
      const at = join(dest, 'dots', name);
      const main = existsSync(at) ? readFileSync(at) : Buffer.alloc(0);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, swapYear(main, readFileSync(join(src, f)), year.year));
      dots++;
      continue;
    }
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    cpSync(join(src, f), join(dest, f));
  }
  const sw = join(dirname(dest), 'sw.js');
  const version = existsSync(sw) && statSync(sw).isFile() ? restamp(sw, dest) : null;
  return { year, dots, version };
}

function main([src, dest]) {
  if (!src || !dest) throw new Error('usage: node scripts/atlas-overlay.mjs <overlay folder> <site atlas folder>');
  const r = overlay(src, dest);
  if (r.skipped) return console.log(`::warning::atlas overlay skipped: ${r.skipped}; keeping main's atlas files`);
  const y = r.year;
  console.log(`atlas overlay: ${y.year}${y.so_far ? ' so far' : ''}, ${y.photos} photos through day ${y.last_day} ` +
    `(built ${y.built}); ${r.dots} dots files swapped; sw.js VERSION ${r.version ?? '(no sw.js)'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
