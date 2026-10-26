# The league: how Hatch improves its own forecasts, honestly

**In plain words.** Think of a sports league. The model on the map is the starter (the *champion*). Challenger models
play every night from the bench: each forecasts the same season on the same weather, and its forecast is sealed
(archived with a date) but never shown. Every week the scorekeeper grades everyone on the same real sightings. A
challenger takes the map only between seasons, and only by a rule written before the season. Nothing here changes the
map; the 2027 luna test in [`PREREG_2027.md`](../fit/PREREG_2027.md) stands exactly as written.

```
weather + sightings ─► nightly: champion (map) + challengers (sealed) ─► weekly scorecard ─► league table
          tryouts on past seasons ─► bench                                                     │
                       new champion next season ◄── yes ── season end: passes the rule? ◄──────┘
```

## Why it cannot fool itself
1. **Only sealed forecasts count.** A forecast is graded only if it was archived at least 7 days before the real date
   (the scorecard's lead), and the archive is a public git history.
2. **Past seasons buy a tryout, not the map.** A new idea must beat the champion on replays of past seasons to get a
   bench spot. We have looked at those seasons too often for them to prove anything, so the map needs a sealed season.
3. **The rule is written first** ([`rules.py`](rules.py), tested): record-weighted miss at least 1 day lower, a
   strictly lower miss in at least 3 strips, and the challenger's own gate passed. Fewer than 3 strips or 150 records:
   no verdict. A challenger 1 day worse is retired.
4. **Swaps happen between seasons**, never mid-season. A winner takes the map the next season.
5. **Same nights, same records.** Each week's records are pulled once and saved with their sha256
   (`live/records/<season>/`), and both models are graded on the nights both archived.

## The parts
| File | What it does |
|---|---|
| `bench.py` | the challengers: id, frozen fits, archive folder, first season, verdict date, gate |
| `rules.py` | the promotion rule (pure, tested) |
| `weekly.py` | the weekly table: records pull, common nights, both scorecards, head to head, verdict -> `live/league.json` |
| `drift.py` | the model-drift alarm: weather part vs model part of each miss, issue when a model looks stale -> `live/drift.json` |
| `gates.json` | each challenger's gate result once known (P3.1: the Daymet 2026 re-check, due 31 Aug 2027) |

**Where it runs.** No new workflow: `build_live.py` forecasts every bench challenger on the night's weather and writes
its strip dates under `shadows` in the live file (about 1 KB each); the nightly job's scorecard step archives them
(`live/<archive>/<season>/<issued>.json`, e.g. `live/archive_p31/`) and, once per scoring week, runs `weekly.py`.
The job's `git add live` commits all of it to the `live-data` branch. A challenger that fails never costs the night's
forecast; it raises the job's alarm.

**Locked for 2027.** `rules.py` and `weekly.py` are pinned by hash in PREREG_2027.md; P3.1's bench entry and the gate's
number (`gates.json`, which must equal the prereg's "Daymet result") are held to it by tests. If the 2027 test is void,
the prereg carries over to 2028: move P3.1's `first_season` and verdict date a year on, before 1 March 2028. A verdict is computed from the verdict week's records and cards, and never recomputed
from later data. A decided challenger leaves the bench. Earlier seasons' tables stay in `league.json` under `past`.
Each week's records file (about 100 KB for luna) is kept, with its sha256, as the receipt.

**Adding a challenger.** Pass its tryout on past seasons (written up beside its code), freeze its fits, add it to
`BENCH` with a gate before 1 March of its first season. From then on, the league grades it every week.

**Eastern shadow track (2027).** The heat clock from tryout 2 forecasts 28 eastern places every night in
shadow (`east.py`, frozen inputs `east_static.json` from `build_east.py`), sealed in `live/archive_east/`, and is
graded every Monday against each place's calendar (`live/league_east.json`). Its own rule, written before the
season, is [EAST_2027.md](EAST_2027.md); on a 2026 rehearsal (`rehearse_east.py`) it would not have passed (it won 11 of 24 places).
It never touches the map or the P3 vs P3.1 test.

**Drift alarm** ([`drift.py`](drift.py), every night after the scorecard). A forecast can miss because the weather
surprised it (a heat wave where it assumed a normal week) or because it reads the weather wrongly. Only the second
means the model is going stale. Once a strip's window is over, the same frozen model has been re-run on the real
weather, so the archive holds its answer in hindsight: *model part* = hindsight forecast − real, *weather part* =
the graded miss − model part. A species' season bias (mean model part over its strips) is set against the same model's
leave-one-year-out replay seasons: an alarm needs at least 3 strips and 5 past seasons, a bias more than 2 SD from
the past mean plus 1.5 days (PRISM live vs Daymet replay), and two thirds of strips on that side. A *running* alarm
does the same over every live season so far (2 SD / √n), for slow drift no single season shows. An alarm only opens a
GitHub issue: a refit tryout is due before next season. On the 2026 rehearsal (`DRIFT_2026.json`; seen while writing the rule; the
seed for the 2027 running check): no alarm. Luna's onset forecasts ran 6.3 days late as graded, but 5.8 of that was
the weather (a hot late March) and 0.5 the model; luna's peak ran 3.6 days early on the real weather (z = −2.05, 1.4
days inside the line), and if 2027 does the same the running alarm fires. Japanese beetle's peak, −2.4 (z = −2.25), is also
just inside.

**Tryouts so far** (`tryouts/`): learning from this year's first sightings, no gain ([ASSIM_RESULT.md](tryouts/ASSIM_RESULT.md));
forecasting new regions, where a local heat clock beats the local calendar across the East by 1.6 days, found after
the fact, so it needs 2027 to confirm it ([REGIONAL_RESULT.md](tryouts/REGIONAL_RESULT.md)).

**Not built yet (before the first verdict, September 2027):** the step that swaps a winner onto the map for the next
season and opens an issue saying what changed and why (the drift alarm shows the nightly job can open issues itself);
showing the table in the app.

Run: `python3 -m pytest pipeline/league` (offline) · `python3 pipeline/league/weekly.py --live live --season 2027 --force`
