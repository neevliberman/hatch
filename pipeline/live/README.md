# Live season forecast

From 2 March to 7 October, `.github/workflows/live-forecast.yml` runs `build_live.py --auto` every morning and
publishes `live/latest.json`, which the app shows as the "live" season. Nothing here refits the model: the season
runs on the frozen P3 fits in `pipeline/replay/fold_fits.json` (the replay's leave-one-year-out fits), recorded in
the file's `model` field.

## One night, step by step
Analogy: finishing a sentence someone has started.
1. **The words already said.** Real daily Tmin/Tmax from 1 March to the newest day PRISM has (usually yesterday or
   the day before), fetched per hex centre from RCC-ACIS (grid 21 = PRISM). The model was fitted on Daymet, so each
   day gets a per-hex, per-month offset (`prism_offsets.json`: mean Daymet minus PRISM over 2015-2025), like
   setting a second thermometer to read like the first.
2. **The next few words.** A 7-day forecast from Open-Meteo (same offsets). Backfills (as-of more than 4 days ago)
   skip this: there is no honest archived forecast to use.
3. **The unknown ending.** Each past year 2015-2025 of Daymet weather, run forward from there: 11 endings.
4. **Run the model.** Each ending x each of the 11 fits = 121 forecasts per hex of the day 5 / 25 / 50 / 75 / 95%
   of its expected first-brood *sightings* have happened (same quantity as the replay, using the typical moth
   recording effort per state in `effort_profile.json`).
5. **Summarise.** `median` = the members' median day. `lo` / `hi` = 10th / 90th percentile of member day plus
   each past real-minus-forecast peak error from the replay's scored band-years. So even a date real weather has
   already fixed keeps the model's honest error (about a week wide), and a far-off date also carries the weather
   spread.
6. **Sightings so far.** This season's openly licensed iNaturalist luna records (research grade plus needs-ID,
   flag bit 2 = not yet confirmed).

## Loud when broken
- Any failed step (feed down, more than 2% of hexes missing weather, temperatures out of range) stops the run before
  writing; the site keeps the last good file.
- A failed run opens a "Live forecast failed" GitHub issue (or comments on the open one).
- The app's "as of" badge turns amber once the file is older than `stale_after_hours` (36) in season.
- The workflow re-enables itself every run (GitHub switches off scheduled workflows after 60 quiet days).

## Where the file goes
The job commits `live/latest.json` to the `live-data` branch and starts `deploy-pages.yml`, which copies that file
over the one bundled from `main` (`public/live/latest.json`, the 2026 dry run). A normal merge to `main` therefore
never rolls the live map back.

## Run it
```
pip install -r notebooks/requirements.txt
python3 pipeline/live/build_live.py --season 2026 --as-of 2026-06-01   # backfill: real weather to 1 June
python3 pipeline/live/build_live.py --auto                             # what the nightly job runs
python3 -m pytest pipeline/live                                        # offline tests
```
First run downloads Daymet 2015-2025 for 551 hexes into `notebooks/data/daymet/` (cached; the workflow caches it
too). A run takes a few minutes, mostly the 551 PRISM calls. `build_static.py` rebuilds the two committed inputs
(only needed if the hex list changes).

Manual backfill from GitHub: Actions > live-forecast > Run workflow, with a season and an as-of date. That
publishes to the live map, so put the newest date back afterwards (or run it blank in season).
