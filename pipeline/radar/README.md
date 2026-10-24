# Radar replays

Some evenings a weather radar sees insects. The app replays two evenings when a National Weather Service radar
watched a cloud of burrowing mayflies (*Hexagenia*) come off the water (About, "Real mayfly hatches on radar"; or
`?radar=<id>`):

| id | Radar | Evening (local) | Pack |
|---|---|---|---|
| `karx-2014-07-20` | KARX La Crosse, Wisconsin | Sun 20 July 2014, Mississippi River (CDT) | 22,545 B, 28 scans, 80 km |
| `kcle-2019-06-26` | KCLE Cleveland, Ohio | Wed 26 June 2019, western Lake Erie (EDT) | 15,524 B, 28 scans, 120 km |

Their code and frames load only when one is opened (a normal visit carries only the short list of links), and the
one-file build leaves them out.

`build_radar.py` turns one evening of NOAA NEXRAD Level II scans into the pack the app reads,
`public/radar/<event>/frames.bin.gz` (15 to 25 KB: 28 scans of 160 x 160 cells, 4 bits each) and `meta.json`
(scan times, the grid, the levels, and the insect check below). Run it by hand when an event is added or changed. It is
not part of the app build and never runs in CI: it needs Py-ART, a large install, and 140 to 200 MB of raw scans an
event.

```
python3 -m venv /tmp/radar-venv && /tmp/radar-venv/bin/pip install arm-pyart==2.3.0
/tmp/radar-venv/bin/python pipeline/radar/build_radar.py karx-2014-07-20 --cache /tmp/nexrad
/tmp/radar-venv/bin/python pipeline/radar/build_radar.py kcle-2019-06-26 --cache /tmp/nexrad
```

The scans come from Unidata's public mirror of the NOAA archive (`unidata-nexrad-level2`, no account needed) and are
kept in `--cache`; `--offline` uses only what is already there. The same scans give the same bytes, so a rebuild with
nothing changed shows no diff (checked: both packs rebuild byte for byte, KARX also after the per-event reach was
added).

## What it keeps

- The lowest tilt (0.5 degrees), gridded by Py-ART onto 160 x 160 cells centred on the radar, in its azimuthal
  equidistant frame (sphere, R = 6,370,997 m). Cell centres run from -reach to +reach, so a cell is 2 x reach / 159 wide:
  about 1 km at La Crosse (80 km), 1.5 km on Lake Erie (120 km, since the swarm leaves the islands 60 to 120 km from
  Cleveland). The app maps every texture pixel back to this grid (`src/radar/radarReplay.ts`), so the echo lands at its
  true place, and reads the reach from `meta.json`.
- 8 km to the reach: the blind centre and the far edge, where the beam is high above the ground, are blanked.
- Reflectivity in 15 levels, 2.5 dBZ apart from 10 dBZ. Rain-like cells (20 dBZ or more with a correlation coefficient
  of 0.95 or more) are dropped: 1 cell in the La Crosse evening, 93 (of about 30,000 drawn) on Lake Erie, where the
  densest swarm reaches a CC of 0.95 but keeps a ZDR of 6 dB or more, so they are insects too, not rain.

## The insect check

Reflectivity alone can't tell insects from rain. Dual polarisation can: raindrops are round and all alike, so the
correlation coefficient (CC) is near 0.99 and differential reflectivity (ZDR) near 0 to 2 dB; long, tumbling insects give
a low CC and a high ZDR. For the gridded cells of 25 dBZ or more, in the scans with 100 or more of them (`meta.json`):

| | La Crosse, 20 July 2014 (10 scans) | A rain echo, KARX 22 July 2014 07:42 UTC (by hand) | Lake Erie, 26 June 2019 (3 scans) | A rain echo, KCLE 29 June 2019 11:51 UTC (by hand) |
|---|---|---|---|---|
| CC, median | 0.70 to 0.78 | 0.99 | 0.80 to 0.81 | 1.00 |
| ZDR, median | 7.7 to 7.9 dB | 0.5 dB | 7.3 to 7.4 dB | 0.7 dB |

(7.9 dB is the ceiling of ZDR in these files.) Stepanian et al. (below) use the same idea: they drop cells with ZDR under
5 dB (birds) and remove rain with a polarimetric test (depolarisation ratio under -12.5 dB is rain). A new event should
pass this check, by its numbers in `meta.json` and by eye, before it ships.

## The Lake Erie evening: 26 June 2019, KCLE

**What was reported that night.**

- The NWS Cleveland office "posted a radar shot late Wednesday [26 June 2019] of a mayfly swarm moving from Lake Erie
  inland to Cleveland, Sandusky and other Ohio cities" (Mary Ann Thomas, TribLIVE, published 27 June 2019 07:42 EDT).
- WEWS News 5 Cleveland meteorologist Mark Johnson, 26 June 2019: "Millions of Insects filling the skies over Western
  Lake Erie again tonight...showing up on the Power of 5 Doppler Radar" (quoted by Cox Media Group, 28 June 2019).
- Phil Stepanian (@RadarAndStuff, Notre Dame, first author of the PNAS paper), 27 June 2019: "Radar loop from last night
  showing ascent and downwind drift of several billion Hexagenia [mayflies] over the western basin of Lake Erie. Yes.
  That is billion with a "b"." (embedded in Michigan Public, 8 July 2019).

**What the radar shows.** All 28 KCLE volume scans from 01:46 to 04:56 UTC on 27 June (9:46 pm to 12:56 am EDT; sunset
at Cleveland 9:06 pm). Up to 10:21 pm the lake is quiet. At 10:28 pm (the replay's first frame) thin bands rise over the
islands of the western basin, 60 to 110 km west-northwest of the radar; by 11:10 pm they have merged into one plume that
drifts east-southeast toward the Cleveland shore, peaks around midnight and is still over the lake off Cleveland at 1 am.
That is the "ascent and downwind drift" of the tweet. (These scans end over the water: they don't show it reaching
land, so they neither confirm nor contradict the NWS post's "inland".)

The insect test on the raw (polar) gates of 20 dBZ or more, 8 to 120 km out (the replay's whole reach), checked by hand
alongside the gridded check above:

| UTC (EDT) | Gates of 20 dBZ+ | CC, median | ZDR, median | Depolarisation ratio, median | Rain-like (CC 0.95+, ZDR under 3) |
|---|---|---|---|---|---|
| 02:21 (10:21 pm), before | 509 | 0.83 | 3.3 dB | -7.8 dB | 14% |
| 03:03 (11:03 pm) | 4,077 | 0.92 | 6.5 dB | -7.7 dB | 1% |
| 03:30 (11:30 pm) | 10,852 | 0.83 | 7.1 dB | -6.2 dB | 1% |
| 04:05 (12:05 am), peak | 13,656 | 0.77 | 7.9 dB | -5.4 dB | 1% |
| 04:35 (12:35 am) | 7,108 | 0.79 | 7.6 dB | -5.6 dB | 3% |
| Rain, 29 June 2019 11:51 UTC | 16,407 | 1.00 | 0.6 dB | none (CC at 1: rain) | 95% |

The CC runs higher than at La Crosse while the swarm is young and dense (0.93 to 0.94 from 10:35 to 10:56 pm, 0.92 at
11:03 pm), then settles at 0.77 to 0.83 for the hour around midnight; ZDR stays at 6.5 dB to the 7.9 dB ceiling throughout, and the
depolarisation ratio never comes near rain's. So: insects, not rain.

**How special was the night.** Insect-like gates (20 dBZ or more, CC under 0.9, ZDR over 4 dB, 8 to 120 km) in the scan
nearest midnight EDT on six evenings: 24 June 105, 25 June 579, **26 June 11,773**, 27 June 177, 28 June 181 (with
7,222 rain-like gates: a rainy night), 29 June 100. The 26th is about 20 times its neighbours.

**Another evening, looked at and not used.** 22 June 2022, when NWS Cleveland posted on Facebook that "The KCLE and TDTW
doppler radars are both picking up on a huge swarm of Mayflies over the western basin of Lake Erie this evening" (Fox 2
Detroit, 23 June 2022). The radar agrees (ZDR 6 to 7.5 dB, depolarisation ratio about -7 dB), but the swarm is a narrow
band near Sandusky with a CC of 0.85 to 0.94, smaller and less clear-cut than 2019.

## Honest limits

- Each is a replay of one evening, not a count and not live. Echo strength stands for how much is in the air, roughly.
- La Crosse: the first scans (7:36 to 8:45 pm CDT) are near empty or clutter, so the replay starts at 8:55 pm.
- La Crosse: news reports put the first detection at about 8:45 pm; in these scans the echo is barely there then and
  clear by 9:05 pm. The app quotes no detection time.
- Birds and bats were not tested separately. The 0.5 degree beam climbs with range, which is why the view stops at 80 km
  (La Crosse) or 120 km (Lake Erie, where the beam is about 2 km up at the far edge: the swarm's start over the islands
  is seen from above).
- Lake Erie: the swarm rises about an hour and a half after sunset, later than at La Crosse; the copy says "after dark",
  not "at dusk". The NWS's own post and Mark Johnson's are known from news reports, not seen directly.

## Adding an event

An entry in `EVENTS` here (radar, its site, the UTC window, the first frame to show, and `reach_km` if 80 km is too
little), a run, then an entry in `src/radar/events.ts` (its words and sources) and one in `src/radar/index.ts` (the About
link: a place and a year, a few words). Same id in all three, and one more line in the `RADARS` lists of
`scripts/desktop.mjs` and `scripts/mobile.mjs`. Write down here what was reported that night and what the radar's own
numbers say. Each pack adds 15 to 25 KB, fetched only by someone who opens it.

## Sources

- NOAA NEXRAD Level II, KARX, 21 July 2014 00:36 to 05:01 UTC, and KCLE, 27 June 2019 01:46 to 04:56 UTC (public
  domain), via https://unidata-nexrad-level2.s3.amazonaws.com/
- TribLIVE, "National Weather Service radar detects massive mayfly swarm off of Lake Erie", 27 June 2019:
  https://triblive.com/local/regional/national-weather-service-radar-detects-massive-mayfly-swarm-off-of-lake-erie/
- Cox Media Group (KIRO 7), "Massive swarm of mayflies blankets parts of Ohio; swarm so large it showed up on radar",
  28 June 2019:
  https://www.kiro7.com/news/trending-now/massive-swarm-of-mayflies-blankets-parts-of-ohio-swarm-so-large-it-showed-up-on-radar/962179785
- Michigan Public, "Massive mayfly swarm seen leaving Lake Erie on weather radar", 8 July 2019:
  https://www.michiganpublic.org/news/2019-07-08/massive-mayfly-swarm-seen-leaving-lake-erie-on-weather-radar
- Fox 2 Detroit, "Swarm of bugs picked up on Detroit, Cleveland weather radars", 23 June 2022 (the evening not used):
  https://www.fox2detroit.com/news/swarm-of-bugs-picked-up-on-detroit-cleveland-weather-radars
- Stepanian, P. M. et al. (2020). Declines in an abundant aquatic insect, the burrowing mayfly, across major North
  American waterways. PNAS 117(6): 2987-2992. https://doi.org/10.1073/pnas.1913598117 (Upper Mississippi down 52%
  from 2012 to 2019; western Lake Erie down 84% from 2015 to 2019.)
- Py-ART: Helmus, J. J. and Collis, S. M. (2016), JORS, doi:10.5334/jors.119.
