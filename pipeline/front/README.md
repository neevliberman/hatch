# Migrant trackers (monarch, red admiral)

Two species with no forecast: sightings so far this spring, as dots, in the species menu under "Butterflies".

Why no model: monarchs and red admirals arrive from the south rather than emerge from warmth. In the species check
(2018-2025, eight Midwest cities, leave-one-year-out; `/mnt/project-files/species-pick/midwest-species-ranking.md`):

| | Usual date off by | Best driver tried | Verdict |
|---|---|---|---|
| Monarch | 5.6 d | spring warmth 5.3, southerly wind 5.4-5.8, southern cities' arrival 5.9, degree-days 8.1 | nothing beats the usual date |
| Red admiral | 10.3 d | southern cities' arrival 4.5 | works, but the north trails the south by only ~4 d: a nowcast, not a forecast |

```
python3 pipeline/front/build_front.py monarch       # past springs (2019-2025) -> public/species/monarch/front.json
python3 pipeline/front/build_front.py red-admiral
```

Rows are the live file's: `[iNat id, year, day of year, lat, lng, flags]` (2 = rough location, 4 = not yet confirmed),
adults only, openly licensed, one per person, place and day, 1 March to 15 July (later dots are the summer's own
broods). Past years ship in one file per species (about 190 KB / 345 KB, fetched when the species is picked).

**This season** comes through the nightly job with no workflow change: `build_live.py` adds `front.<key>` to
`live/latest.json` (this season's sightings so far, from `live_front()`), and the app's season menu offers it as
"live". A failed iNat pull keeps last night's entry, and never holds the forecast back.

Adding a tracker: an entry in `SPECIES` (`build_front.py`), the script above, a `FrontConfig` in `src/species/<key>.ts`
(its words, dot colour and header mark in `src/marks/`) and one `tracker(...)` line in `src/species.ts`. The layer is
`src/layers/frontLayer.ts`; it fills the same `LunaLayer` seam as the hexagon species, without hexagons.
