# Hatch

**Try it: https://neevliberman.github.io/hatch/** (redeploys on every merge to `main`). On a phone, *Share → Add to Home Screen* (iPhone) or *Install app* (Android) puts the moth on your home screen; after one visit it opens with no signal too.

A **bug forecast** for the Midwest: scrub a season slider and watch where and when insects (luna moth first, fireflies second) are likely to be flying, on a hex map. Plan: `build-plan-v2.md` (in the project folder).

**Status: P3, "the fit".** One real layer: luna moth sightings from iNaturalist (2015-2025) over a hex map coloured by the heat forecast. Pick a season (or all years pooled), scrub or press play, tap a hex for its forecast, tap a dot for the sighting and a link to its iNaturalist photo. **My area** asks for one location fix (used in your browser only, never stored or sent) and pins the forecast for your hex. **Share this view** copies a link that reopens the same season and day. The forecast is the fitted P3 model: about 3.9 days off on years it never saw, against 7.3 for the usual date, with the old south-early / north-late lean mostly gone. It failed a test on states it never saw, so it is not proven yet (see `pipeline/fit/RESULT.md`).

### What you are looking at (plain words)
- **Dots** are real sightings. Each glows for 10 days and fades, because an adult luna lives about a week. Pale green = first wave, orange = after a late-June or early-July cut-off for that latitude, counted as the second wave (shown, not forecast), small ink dot = blurred location.
- **Hex colours** are the forecast: pale sage (starting) → deep leaf green (peak) → ochre (winding down) → faded brown (over); ink hatching marks hexes with no sightings nearby. It works like a bank account: from 1 March each warm day pays in "warmth saved up" (degree-days above 10 °C), and each moth comes out once the balance reaches its own savings target. The targets sit on a lopsided curve (half are out by about 220 degree-days, with a long late tail). An adult then flies for about a week, and people log moths unevenly (weekends, Moth Week), so the hex shows when *sightings* are expected: "by today about 30% of this spot's sightings should have happened". In a single replayed year, a hex card also gives the strip's likely peak window, sized from how far past forecasts missed for whole latitude strips.
- **Finer hexes when you zoom in:** the whole-Midwest view uses big hexagons (H3 res 4, ~45 km across). Zoom in and they split into res 5 (~17 km, from zoom 6.4) and then res 6 (~6 km, from zoom 7.9), each forecast from the temperatures at its own centre, so lake shores, cities and river valleys show. Same model and folds; accuracy is still only measured for whole latitude strips. The finer files live in `public/fine/` (built by `pipeline/replay/build_fine.py`) and are fetched only when needed, so the first load is unchanged. The one-file build opened from disk stays at res 4.
- **Leave-one-year-out:** a replayed year's forecast is built from the *other* years' moths, like a teacher who writes the exam without seeing this year's answers. It does use that year's real temperatures, so it is a replay, not a spring forecast.
- **Data:** `src/data/luna-replay.json` (≈270 KB), built by `pipeline/replay/build_replay.py` (see its README). Only CC0 / CC BY / CC BY-NC iNaturalist records are included, and photos are linked, not copied. The file is iNaturalist-derived data under those observers' licences (non-commercial terms apply); each record keeps its observation id, which links back to its observer.

### How time reaches the GPU
The ~3,000 dots are uploaded once per season. Scrubbing only changes deck.gl's `DataFilterExtension` range, a single shader uniform: "show dots whose day is between today-10 and today, fading the older ones". Analogy: the dots are a printed transparency; moving the slider just slides the spotlight over it.

## Run
```
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check + dist/
npm run build:single # one self-contained dist-single/index.html (no network needed)
npm run check        # both builds + the screenshot smoke test
npm run icons        # app icons + favicon PNGs from public/icons/moth.svg and public/favicon.svg
npm run og           # the link-preview card, public/og.png (a real map screenshot)
```
See `RUNBOOK.md` for the screenshot test and how to resume after a break.

## Layout (the web app lives at the repo root; `notebooks/` belongs to the Python work)
```
src/core/        grid.ts (H3 cells), timeAxis.ts (clock), layer.ts (contract), registry.ts
src/layers/      lunaReplay.ts (the layer), lunaData.ts (typed access to the replay JSON), fineData.ts (lazy res 5/6 files)
src/map/         map.ts (deck.gl view, picking), basemap.ts (state outlines)
src/ui/          scrubber, caveat drawer, layer list, legend, probe card
src/sw.js        offline service worker (vite.config.ts stamps it with the build hash into dist/sw.js)
public/          manifest.webmanifest, icons/, favicon, og.png (link preview), fine/ (zoomed-in hexes)
src/data/        midwest-states.json (generated by scripts/build-geo.mjs), luna-replay.json (generated by pipeline/replay)
scripts/         build-geo.mjs, icons.mjs, og.mjs, shoot.mjs (visual test), fine.mjs (zoomed-in test over http), budget.mjs (bundle size), archive/save_forecasts.py
pipeline/replay/ Python: iNat + Daymet -> luna-replay.json (reuses notebooks/hatch_p1)
.github/workflows/forecast-archive.yml   nightly NWS forecast archive (+ keepalive against GitHub's 60-day rule)
notebooks/       Python luna notebook (separate owner)
```

## The layer contract
```ts
interface HatchLayer {
  id: string; title: string;
  render(ctx: { t: number; zoom: number; theme: Theme }): deck.Layer[];
  caveats(): CaveatCard;              // required: honesty one tap away
  legend(): LegendSpec;
  probe?(lngLat, t, picked?): ProbeCard | null;   // picked = the dot/hex object under the finger
  credits?(): string[];
}
```
A layer loads its own data and returns deck.gl layers for time `t`. Its preferred scrubber range is passed at registration: `registry.register(layer, { start, end, stepMs })`, so the contract stays tiny.

## Why it is built this way
- **Layers are plug-ins behind a tiny interface.** Like USB: the map is the laptop, a layer is a device. The laptop never needs to know what is inside. We cut `kind`, `resolutions` and `load()` because nothing needs them yet; add a field when a second layer actually demands it.
- **Honesty is part of the contract.** `caveats()` is required, so a layer cannot ship without saying what it does not know. The luna layer says "first test, not yet confirmed" in an always-visible line, and the drawer opens by itself on a first visit.
- **One clock, absolute UTC milliseconds.** Like a single wall clock in a house instead of each room keeping its own time. UTC ms has no timezone or daylight-saving surprises; step size (minute, day, year) is just a number, so season, year and radar layers share one scrubber.
- **H3 hexagons.** Equal-sized, equal-distance neighbours, so a "wave" moves evenly and nothing looks bigger because of a county border. Res 4 (~1,770 km2) is the resolution the model numbers will live at.
- **deck.gl on a plain canvas, no tile basemap yet.** deck.gl draws huge layers on the GPU. State outlines come from bundled data so the app works offline; `map/basemap.ts` is the single place a PMTiles basemap gets added later.
- **One-file build.** `dist-single/index.html` has JS, CSS and data inline: a pocket copy you can open anywhere to check the app still works.
- **Exact dependency versions plus a lockfile.** luma.gl once drifted between two patch versions underneath us; pinning means "works today" stays true next year.
- **The screenshot test fails loudly.** The first version passed while the map was blank. Now any page error, external request, or a single-colour map centre fails the run: a smoke detector, not a decoration.
- **Zoom is tracked from `onViewStateChange`.** deck.gl 9 builds its view manager asynchronously, so asking it for viewports right after creation throws. We listen instead of asking.
- **Forecast archive from day one.** NWS keeps no old forecasts; every night not saved is a future backtest lost.
