// Bundle budget (plan v2 P2): fail if the one-file build grows past what a phone on 4G loads in ~2 s.
// Today: deck.gl + h3 + the replay data ≈ 425 KB gzipped. Raise the limit on purpose, never by accident.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// 510 since the firefly (2026-10-23): its code ships in the page, its data is fetched only when picked.
const LIMIT_KB = 510;
const file = process.argv[2] ?? 'dist-single/index.html';
const kb = gzipSync(readFileSync(file)).length / 1024;
console.log(`${file}: ${kb.toFixed(0)} KB gzipped (budget ${LIMIT_KB} KB)`);
if (kb > LIMIT_KB) {
  console.error('BUDGET FAILED');
  process.exit(1);
}
