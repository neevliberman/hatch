// Bundle budget (plan v2 P2): fail if the one-file build grows past what a phone on 4G loads in ~2 s.
// Today: deck.gl + h3 + the replay data ≈ 500 KB gzipped. Raise the limit on purpose, never by accident.
// 500 -> 510 KB: the live ("This year") mode added ~3 KB of code and wording, on top of a build already at 498 KB.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// 510 since the firefly and live mode (2026-10-23): their code ships in the page, their data is fetched only when used
// (both together: ~507 KB).
// 540 since 2026-10-24: Neev OK'd headroom for more species and the audit fixes (~0.2 s more on 4G).
const LIMIT_KB = 540;
const file = process.argv[2] ?? 'dist-single/index.html';
const kb = gzipSync(readFileSync(file)).length / 1024;
console.log(`${file}: ${kb.toFixed(0)} KB gzipped (budget ${LIMIT_KB} KB)`);
if (kb > LIMIT_KB) {
  console.error('BUDGET FAILED');
  process.exit(1);
}
