# Engineering notes

The design choices behind Hatch, for anyone reading the code. The [README](../README.md) has the overview.

## What the map shows, in detail
- **Dots** are real sightings. Each glows for 10 days and fades, because an adult luna lives about a week. Pale green = first wave; orange = after a late-June or early-July cut-off for that latitude, counted as the second wave (shown, not forecast); gray = blurred location.
- **Hex colours** are the forecast: not yet, starting, peak, winding down, first wave over. A hex shows when *sightings* are expected ("by today about 30% of this spot's sightings should have happened"), because that is the quantity the model is scored on. In a single replayed year, a hex card also gives the strip's likely peak window, sized from how far past forecasts missed for whole latitude strips.
- **Finer hexes when you zoom in.** The whole-Midwest view uses H3 res 4 (~45 km across). Zoom in and they split into res 5 (~17 km, from zoom 6.4) and then res 6 (~6 km, from zoom 7.9), each forecast from the 1 km temperatures at its own centre, so lake shores, cities and river valleys show. Same model and folds; accuracy is still only measured for whole latitude strips. The finer files live in `public/fine/` (built by `pipeline/replay/build_fine.py`) and are fetched only when needed, so the first load is unchanged. The one-file build opened from disk stays at res 4.
- **Leave-one-year-out.** A replayed year's forecast is built from the *other* years' moths, like a teacher who writes the exam without seeing this year's answers. It does use that year's real temperatures, so it is a replay, not a spring forecast.
- **Map detail.** Lakes, rivers, highways, national forests and parks, and ~1,700 town names, all public domain (Natural Earth, US Forest Service, US Census Bureau). Each thing shows from its own zoom: big rivers and lakes on the whole-Midwest view, highways, forests and small towns as you zoom in. Names are placed most important first and skipped if they would overlap a name, a sighting dot or a panel, like a cartographer working down a list. Lakes are drawn over the hexagons, so a shore hexagon stops at the shore. A hexagon belongs to a state when its centre does, which would leave up to half a hexagon of bare paper along every shore and state line (it reads as missing data); so a ring of extra hexagons just outside takes a neighbour's colour, and a mask of the sea and the land around the seven states, drawn over them, trims everything to the edge. That land (the rest of the US, Canada) is drawn too, quietly, so Pittsburgh is not in a lake. Rivers that form a state line (Ohio, Mississippi, Wabash) are drawn on the line itself rather than a kilometre beside it. Two lazy files in `public/basemap/` (built by `pipeline/basemap/build_basemap.py`; the second loads only once you zoom in), so the bundle doesn't grow.
- **Data file.** `src/data/luna-replay.json` (about 270 KB), built by `pipeline/replay/build_replay.py` (see its README).

## How time reaches the GPU
The ~3,000 dots are uploaded once per season. Scrubbing only changes deck.gl's `DataFilterExtension` range, a single shader uniform: "show dots whose day is between today-10 and today, fading the older ones". Analogy: the dots are a printed transparency; moving the slider just slides the spotlight over it.

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
- **Honesty is part of the contract.** `caveats()` is required, so a layer cannot ship without saying what it does not know. The luna layer says "a forecast still being tested" in an always-visible line, with "How sure?" one tap away.
- **One clock, absolute UTC milliseconds.** Like a single wall clock in a house instead of each room keeping its own time. UTC ms has no timezone or daylight-saving surprises; step size (minute, day, year) is just a number, so season, year and radar layers share one scrubber.
- **H3 hexagons.** Equal-sized, equal-distance neighbours, so a "wave" moves evenly and nothing looks bigger because of a county border. Res 4 (~1,770 km2) is the resolution the model numbers will live at.
- **deck.gl on a plain canvas, no tile basemap.** deck.gl draws huge layers on the GPU. State outlines come from bundled data so the app works offline; the map detail is two small self-hosted files drawn by the same deck.gl layers (`map/basemap.ts`), and place names are page text (`map/labels.ts`), so there is no tile server, key or text engine.
- **One-file build.** `dist-single/index.html` has JS, CSS and data inline: a pocket copy you can open anywhere to check the app still works.
- **Exact dependency versions plus a lockfile.** luma.gl once drifted between two patch versions underneath us; pinning means "works today" stays true next year.
- **The screenshot test fails loudly.** The first version passed while the map was blank. Now any page error, external request, or a single-colour map centre fails the run: a smoke detector, not a decoration.
- **Zoom is tracked from `onViewStateChange`.** deck.gl 9 builds its view manager asynchronously, so asking it for viewports right after creation throws. We listen instead of asking.
- **Forecast archive from day one.** NWS keeps no old forecasts; every night not saved is a future backtest lost.
