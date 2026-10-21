# Runbook

## One-command setup, build, test
```
npm install && npm run check
```
`check` = `npm run build` (type-check + dist/), `npm run build:single` (dist-single/index.html), `npm run shoot` (Playwright smoke test).

## Screenshot test
Needs Playwright and a Chromium. In the Claude cloud container:
```
export PLAYWRIGHT_PATH=/opt/node22/lib/node_modules/playwright
export CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
node scripts/shoot.mjs <outDir> <prefix>     # e.g. /mnt/project-files/emergence/screenshots p1
```
On a laptop with `npm i -D playwright && npx playwright install chromium`, leave both unset. It captures 1440x900 and 390x844 at two dates and exits 1 on a page error, console error, external request, or a blank (single-colour) map. Set `DIST=path/to.html` to test another build. LOOK at the PNGs too: the test catches blank, not ugly.

## Resuming after a quiet month
1. Read `STATUS.md` ("Resume here" line) and `build-plan-v2.md`.
2. `git log --oneline | head` and `git status`.
3. `npm ci` (lockfile + exact pins make this reproducible), then `npm run check`.
4. If `check` fails before you touched anything, suspect a Node or Chromium change first, not the code.
5. Forecast archive: look at the `forecast-archive` branch on GitHub; there should be one `archive/YYYY-MM-DD/` folder per night. Gaps mean the Action failed (Actions tab). It is untested as of P0.

## Gotchas
- Never run `npm install` inside `/mnt/project-files` (network mount); work in `/home/claude/emergence` and copy out.
- Don't call `deck.getViewports()` right after `new Deck()`; see `src/map/map.ts`.
- `src/data/midwest-states.json` is generated: `npm run geo` (needs the us-atlas dev dependency).
