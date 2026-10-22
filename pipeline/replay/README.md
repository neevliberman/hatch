# Season replay data pipeline

`build_replay.py` builds `src/data/luna-replay.json`, the file the Hatch "season replay" map reads.
It holds, for every res-4 hex cell in the seven core states, a forecast of the day each share
(5%, 25%, 50%, 75%, 95%) of first-brood luna moths is out, for each year 2015-2025 plus a "typical" year.
It also holds the display sightings (iNaturalist, openly licensed), the brood cut-offs, and the
leave-one-year-out scores that back up the forecast.

Run it from the repo root: `pip install -r notebooks/requirements.txt`, then
`python3 pipeline/replay/build_replay.py`. The first run downloads iNaturalist records and Daymet
temperatures (a few minutes, rate-limited) into `notebooks/data/`; reruns are offline.
Tests: `python3 -m pytest pipeline/replay`.

Since P3 the forecast is the fitted model (see `pipeline/fit/README.md`; P3.1 since 2026-10-22: no daylength term, warmth targets at or above 0): warmth is counted as degree-days
(base 10 C, from 1 March), each moth has a warmth target on a skewed curve, and an adult flies for a week.
For each year the builder refits the model on the other ten years (leave-one-year-out), so a replayed year
never saw its own moths. A cell's quantiles are days by which that share of its expected first-brood *sightings*
(flight share x the state's typical moth-recording effort, up to the brood cut-off) has happened. That is the
same quantity the scores test, so a hex is judged on the same footing as the dots. Run `pipeline/fit/run_p3.py` first: it writes `pipeline/fit/results/headline.json`,
and the builder stops without writing if its own refits do not reproduce those scores within 0.15 d.

Fields added in P3 (all optional; P2 readers ignore them):
- `scores[].p1_onset`, `scores[].p1_peak`: what the P1/P2 model said for that band-year (`heat_*` is now P3).
- `model`: model id/spec, median warmth target, headline leave-one-year-out and holdout MAEs, noise floor.
- `interval`: an 80% band for a forecast date, as day offsets `[low, high]` (10th and 90th percentile of real minus
  forecast over the leave-one-year-out band-years). `peak` offsets go on a cell's 50% day; `onset` offsets go on the
  10%-of-sightings onset (`scores[].heat_onset`). Example: peak 2 June with `peak: [-6, 4]` reads "27 May to 6 June".
- `scorecard`: per latitude band, MAE of P3 / P1 / calendar and the mean peak error (forecast minus real).

LOYO means leave-one-year-out. Analogy: to grade a weather forecaster on 2019, you hide everything that
happened in 2019 and let them learn from the other ten years only. So a replayed year never "saw" its own moths,
and the replay is an honest guess, not a memory.

## Finer hexes (res 5 and 6)

`build_fine.py` evaluates the same forecast at res 5 (~17 km across) and res 6 (~6 km) for every cell whose centre is in
a core state, so the map can sharpen as you zoom in. Each finer hex uses the 1 km Daymet temperatures at its own
centre: lake-shore cooling, city heat and river valleys show up. Nothing is refit. `build_replay.py` writes
`fold_fits.json` (the chosen model's leave-one-year-out fits, year effect dropped, and each fold's brood cut-offs), and
`build_fine.py` reuses those folds with the same per-cell state effort profile, latitude strip and cut-off as res 4.
It refuses to write unless those fits reproduce the shipped res-4 forecast exactly. Daymet is read in chunks of 1,500
cells, so res 6 (~27,000 cells) stays well under 1 GB of memory.

Run `python3 pipeline/replay/build_fine.py` after `build_replay.py` (`--res 5` or `--res 6` to build one level; the
manifest keeps levels built earlier). Output goes to `public/fine/` as static files the app fetches when the user zooms
in (format in the module docstring): `manifest.json`, then per level `r{res}/cells.bin` (cell list and "seen" flag,
inherited from the res-4 parent) and one `r{res}/{mode}.bin` per season (5 bytes per cell: day of year minus 60, 255 =
never). A finer hex is not scored on its own: all accuracy figures stay at the latitude-strip level.
