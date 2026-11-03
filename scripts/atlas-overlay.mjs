// Lays the weekly Atlas rebuild (pipeline/atlas/weekly.py, the `atlas-data` release) over the built site's atlas/
// folder, so the site shows the current year. Run by deploy-pages.yml after `npm run build`:
//   node scripts/atlas-overlay.mjs <unpacked release folder> dist/atlas
// It only copies files built for the same species list and network as the site's own (year.json's species count,
// FNV hash of the names, as atlas.ts hashes them for spread.bin, and the model.bin hash), and never a dry-run subset.
// Otherwise it says why and leaves main's files: a new model on main waits for the next weekly run instead of
// pairing new species with last week's counts. Exit 0 either way; exit 1 only on a file it cannot read or copy.
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function speciesHash(names) {
  const s = names.join('\n');
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193) >>> 0;
  return h;
}

/** Why the overlay does not fit the site, or null when it does. */
export function mismatch(year, species, modelBin) {
  if (!Number.isInteger(year.year)) return 'year.json names no year';
  if (year.subset) return 'it is a dry run on a few species';
  const names = species.slice(0, -1).map((s) => s.name);
  if (year.species !== names.length || year.species_hash !== speciesHash(names)) return 'it was built for another species list';
  const model = createHash('sha256').update(modelBin).digest('hex').slice(0, 12);
  if (year.model !== model) return 'it was built for another network';
  return null;
}

function main([src, dest]) {
  if (!src || !dest) throw new Error('usage: node scripts/atlas-overlay.mjs <overlay folder> <site atlas folder>');
  const yf = join(src, 'year.json');
  if (!existsSync(yf)) return console.log(`atlas overlay: no year.json in ${src}; keeping main's atlas files`);
  const year = JSON.parse(readFileSync(yf, 'utf8'));
  const why = mismatch(year, JSON.parse(readFileSync(join(dest, 'species.json'), 'utf8')), readFileSync(join(dest, 'model.bin')));
  if (why) return console.log(`::warning::atlas overlay for ${year.year} skipped: ${why}; keeping main's atlas files`);
  cpSync(src, dest, { recursive: true });
  console.log(`atlas overlay: ${year.year}${year.so_far ? ' so far' : ''}, ${year.photos} photos through day ${year.last_day} (built ${year.built})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
