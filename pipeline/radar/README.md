# Radar replays

Some evenings a weather radar sees insects. On 20 July 2014 the National Weather Service radar at La Crosse,
Wisconsin (KARX) watched a cloud of mayflies rise off the Mississippi at dusk and drift north. The app replays it
(About, "See a real mayfly hatch on radar"; or `?radar=karx-2014-07-20`). Its code and frames load only when opened,
and the one-file build leaves it out.

`build_radar.py` turns one evening of NOAA NEXRAD Level II scans into the pack the app reads,
`public/radar/<event>/frames.bin.gz` (about 22 KB: 28 scans of 160 x 160 one-km cells, 4 bits each) and `meta.json`
(scan times, the grid, the levels, and the insect check below). Run it by hand when an event is added or changed. It is
not part of the app build and never runs in CI: it needs Py-ART, a large install, and about 140 MB of raw scans.

```
python3 -m venv /tmp/radar-venv && /tmp/radar-venv/bin/pip install arm-pyart==2.3.0
/tmp/radar-venv/bin/python pipeline/radar/build_radar.py karx-2014-07-20 --cache /tmp/nexrad
```

The scans come from Unidata's public mirror of the NOAA archive (`unidata-nexrad-level2`, no account needed) and are
kept in `--cache`; `--offline` uses only what is already there. The same scans give the same bytes, so a rebuild with
nothing changed shows no diff.

## What it keeps

- The lowest tilt (0.5 degrees), gridded by Py-ART onto 160 x 160 cells centred on the radar, in its azimuthal
  equidistant frame (sphere, R = 6,370,997 m). Cell centres run from -80 to +80 km, so a cell is 160/159 km wide. The
  app maps every texture pixel back to this grid (`src/radar/radarReplay.ts`), so the echo lands at its true place.
- 8 to 80 km from the radar: the blind centre and the far edge, where the beam is high above the ground, are blanked.
- Reflectivity in 15 levels, 2.5 dBZ apart from 10 dBZ. Rain-like cells (20 dBZ or more with a correlation coefficient
  of 0.95 or more) are dropped: one cell on this night.

## The insect check

Reflectivity alone can't tell insects from rain. Dual polarisation can: raindrops are round and all alike, so the
correlation coefficient (CC) is near 0.99 and differential reflectivity (ZDR) near 0 to 2 dB; long, tumbling insects give
a low CC and a high ZDR. For the cells of 25 dBZ or more, in the ten scans with 100 or more of them:

| | This evening (meta.json) | A rain echo, same radar, 22 July 2014 07:42 UTC (checked once, by hand) |
|---|---|---|
| CC, median | 0.70 to 0.78 | 0.99 |
| ZDR, median | 7.7 to 7.9 dB (at the radar's 7.9 dB ceiling) | 0.5 dB |

Stepanian et al. (below) use the same idea: they drop cells with ZDR under 5 dB (birds) and remove rain with a
polarimetric test. A new event should pass this check, by its numbers in `meta.json` and by eye, before it ships.

## Honest limits

- A replay of one evening, not a count and not live. Echo strength stands for how much is in the air, roughly.
- The first scans (7:36 to 8:45 pm CDT) are near empty or clutter, so the replay starts at 8:55 pm.
- News reports put the first detection at about 8:45 pm; in these scans the echo is barely there then and clear by
  9:05 pm. The app quotes no detection time.
- Birds and bats were not tested separately. The 0.5 degree beam climbs with range, which is why the view stops at 80 km.

## Adding an event

An entry in `EVENTS` here (radar, its site, the UTC window, the first frame to show), a run, then an entry in
`src/radar/events.ts` (its words and sources) and one in `src/radar/index.ts` (the About link). Same id in all three.

## Sources

- NOAA NEXRAD Level II, KARX, 21 July 2014 00:36 to 05:01 UTC (public domain), via
  https://unidata-nexrad-level2.s3.amazonaws.com/
- Stepanian, P. M. et al. (2020). Declines in an abundant aquatic insect, the burrowing mayfly, across major North
  American waterways. PNAS 117(6): 2987-2992. https://doi.org/10.1073/pnas.1913598117 (Upper Mississippi down 52%
  from 2012 to 2019; western Lake Erie down 84% from 2015 to 2019.)
- Py-ART: Helmus, J. J. and Collis, S. M. (2016), JORS, doi:10.5334/jors.119.
