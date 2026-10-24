# Live season forecast

From 2 March to 7 October, `.github/workflows/live-forecast.yml` runs `build_live.py --auto` every morning and
publishes `live/latest.json`, which the app shows as the "live" season. Nothing here refits a model: each species
runs on its own frozen leave-one-year-out fits, recorded in its `model` field (id + hash of the fits file).

## Every species, one night
The species are one list, `registry.py`: luna moth (P3, `pipeline/replay/fold_fits.json`), firefly
(`pipeline/firefly/result.json`) and Japanese beetle (`pipeline/species/japanese-beetle.result.json`). Each brings
its own fits, its own replay file (cells, strip cut-offs, past errors for the range, calendar, strip weights), its
own effort profile (`effort_profile.json` for luna, `effort/<key>.json` for the others, from the background its own
fit used) and its own iNaturalist taxon. The weather (steps 1-3 below) is fetched once and shared.

`latest.json` keeps luna's forecast at the top level, exactly as before, and every other species under
`species.<key>` (same fields; `cells` shared from the top level). The workflow therefore did not change: the
entry point loops over the species, and `scorecard.py` archives and scores each one from the same file. A species
that fails keeps last night's entry (the app's "as of" badge then turns amber), is listed in
`checks.species_failed`, and makes the scorecard step exit 1 after publishing, so the run fails and the alarm
issue opens (its log says the scorecard was written and which species failed); luna failing still stops the run
before writing, as before. A backfilled entry, or one carried over from an earlier night, is never archived.

Adding a species: an entry in `registry.py`, then `python3 pipeline/live/build_static.py --effort <key>` (its effort
profile, from the records its fetch script cached). The app finds the species' part of the file by its key
(`src/species.ts`), so nothing else changes. The app fetches the file only when live mode is wanted (a link asks
for it, the live season is on, or the reader reaches for the season menu), so an off-season visit never loads it.
One file for all species is fine for a handful (2026 dry run, three species: 336 KB, 94 KB gzipped, mostly the
beetle's sightings), but an in-season luna visitor still downloads every species; the fix is one file per species,
which needs `deploy-pages.yml` to copy a `live/species/` folder (waiting on a workflow change).

## One night, step by step (per species from step 4)
Analogy: finishing a sentence someone has started.
1. **The words already said.** Real daily Tmin/Tmax from 1 March to the newest day PRISM has a high for (usually
   two or three days ago), fetched per hex centre from RCC-ACIS (grid 21 = PRISM). PRISM's day ends at 7 am, so ACIS
   files each afternoon's high under the next date; `sources.py` moves it back to the day it happened (lows stay as
   filed), which is how Daymet dates them. The model was fitted on Daymet, so each
   day gets a per-hex, per-month offset (`prism_offsets.json`: mean Daymet minus PRISM over 2015-2025, PRISM read the same way), like
   setting a second thermometer to read like the first.
2. **The next few words.** A 7-day forecast from Open-Meteo (same offsets). Backfills (as-of more than 4 days ago)
   skip this: there is no honest archived forecast to use.
3. **The unknown ending.** Each past year 2015-2025 of Daymet weather, run forward from there: 11 endings.
4. **Run the model.** Each ending x each of the 11 fits = 121 forecasts per hex of the day 5 / 25 / 50 / 75 / 95%
   of its expected first-brood *sightings* have happened (same quantity as the replay, using the typical moth
   recording effort per state in `effort_profile.json`).
5. **Summarise.** `median` = the members' median day. `lo` / `hi` = 10th / 90th percentile of member day plus
   each past real-minus-forecast error from the replay's scored band-years (onset errors for the 5% and 25% days,
   peak errors from the 50% day on). So even a date real weather has
   already fixed keeps the model's honest error (about a week wide), and a far-off date also carries the weather
   spread.
6. **Sightings so far.** This season's openly licensed iNaturalist records of the species (research grade plus
   needs-ID, flag bit 2 = not yet confirmed); a one-generation species keeps days up to its last day (240), as its
   replay does.

## Loud when broken
- Any failed step (weather feed down, newest day missing for more than 2% of hexes, fewer than 5 forecast days,
  temperatures out of range) stops the run before writing; the site keeps the last good file. If only iNat is
  down, the forecast still publishes with the previous file's dots (`checks.sightings_fresh: false`).
- Gaps inside the observed record are interpolated; a missing newest day is never invented.
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
python3 pipeline/live/build_live.py --as-of 2026-06-01 --species firefly   # luna + only the firefly
python3 -m pytest pipeline/live                                        # offline tests
```
First run downloads Daymet 2015-2025 for 551 hexes into `notebooks/data/daymet/` (cached; the workflow caches it
too). A run takes a few minutes, mostly the 551 PRISM calls (each species then adds under a minute).
`build_static.py` rebuilds the committed inputs (only needed if the hex list changes; `--effort <key>` for one
species' effort profile).

Manual backfill from GitHub: Actions > live-forecast > Run workflow, with a season and an as-of date. That
publishes to the live map, so put the newest date back afterwards (or run it blank in season).

## Scorecard (how the season's forecast did)
Every night the job also archives each species' strip dates (luna: `live/archive/<season>/<issued>.json` on
`live-data`, as before; the others: `live/archive/<key>/<season>/<issued>.json`,
about 1 KB: each 2-degree latitude strip's onset and peak, the days 10% and 50% of its first-wave sightings should
have happened, with the "likely" range and the model id + hash) and rewrites `live/scorecard.json` with
`scorecard.py`, which the deploy copies next to `latest.json`: one layer per species (`layers.<key>`), each graded
on its own archive, against its own sightings and its own calendar. The app shows it in About > "How sure is it?".
- Graded against research-grade iNaturalist records of that species, with the fit's filters, first wave only (a
  one-generation species: 1 March to day 240), at least 20 per strip.
- A strip is **pending** until its first wave is over and its last day is 14 days old; it is never scored early.
- Each real date is graded on the newest forecast issued at least 7 days before it, from the season's frozen model
  only (the id + hash of the season's first archived forecast; anything else is counted, never graded).
- The baseline is the calendar: each strip's mean onset and peak over 2015-2025. Scores move once a week (Mondays).
- If the scorecard fails, the forecast still publishes and the run then fails, so the alarm issue opens.
- Past seasons are kept: `seasons` lists every other season's last published summary per species (oldest first),
  carried from the file on `live-data` and from `main`'s `public/live/scorecard.json` (`--past`), so the first 2027
  night starts from the 2026 rehearsal and each new season moves the last one into the list. The app's record line
  lists every season the file holds, seasons with the same outcome pooled in one clause ("in 2026 and 2027").

Rehearsed on 2026 with weekly rebuilt forecasts for all three species (`rehearse.py`, archive in `archive/2026/`,
`archive/firefly/2026/`, `archive/japanese-beetle/2026/`): see `SCORECARD_2026.md`.
`public/live/scorecard.json` on `main` is that rehearsal, shown until the first 2027 night replaces it.

## Lead time (how far ahead it helps)
`leadtime.py` (luna only) rebuilds the forecast as issued on 1 Apr, 15 Apr, 1 May, 15 May and 1 Jun of 2023-2026 (GFS as the
7-day forecast) and grades it with the scorecard's code: about 0.5 to 1.5 days better than the usual date from
1 April, and the 7-day forecast adds almost nothing. See `LEADTIME.md`.
