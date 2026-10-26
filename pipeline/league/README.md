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
| `build_a1.py`, `a1_envelopes.json` | the A1 shadow's frozen warmth range per fold (the cap, the flag) |
| `verdicts.py`, `PROMOTE.md` | an issue per final verdict; the between-seasons swap of a winner |
| `summary.py` | the app's view: each tryout's status and the drift state, added to the published scorecard |
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

**A1, "too warm for the model" (2027, report-only).** The second shadow in PREREG_2027.md, now on the bench as
`luna~p3-a1-v1`: P3's own fits, but no place's warmth bank is believed past the richest one any fitted place-year had
on that date (`a1_envelopes.json`, from `build_a1.py`). A strip whose real bank has gone past that range (on the weather
known that night, from 1 April to its peak) is flagged, and its likely range is stretched to its usual date; the date
itself is not moved. On a 2026 rebuild (PRISM to 15 May, no forecast) the far south's peak moves from day 116 to 120
and its range from 109-120 to 113-135, which now holds the real day, 130; the middle strip is flagged too (peak range
126-138 to 126-143, real 129); the three northern strips are untouched. It is graded every week beside P3 but can never
take the map: its gate is never recorded, so `rules.decide` cannot pass it.

**Eastern shadow track (2027).** The heat clock from tryout 2 forecasts 28 eastern places every night in
shadow (`east.py`, frozen inputs `east_static.json` from `build_east.py`), sealed in `live/archive_east/`, and is
graded every Monday against each place's calendar (`live/league_east.json`). Its own rule, written before the
season, is [EAST_2027.md](EAST_2027.md); on a 2026 rehearsal (`rehearse_east.py`) it would not have passed (it won 11 of 24 places).
It never touches the map or the P3 vs P3.1 test.

**Drift alarm** ([`drift.py`](drift.py), every night after the scorecard). A forecast can miss because the weather
surprised it (a heat wave where it assumed a normal week) or because it reads the weather wrongly. Only the second
means the model is going stale. Once a strip's first wave is over in every fold fit, the same frozen model has been
re-run on the real weather, so the archive holds its answer in hindsight: *model part* = hindsight forecast − real,
*weather part* = the graded miss − model part. A species' season bias (mean model part over its strips) is set against
the same model's leave-one-year-out replay seasons. An alarm needs every strip settled, at least 3 strips and 5 past
seasons, a bias outside a 95% prediction interval for a new season (t × SD × √(1 + 1/n)) plus 1.5 days (PRISM live vs
Daymet replay), and two thirds of strips on that side. A *running* alarm does the same over every settled live season
of that model, for slow drift no single season shows. An alarm only opens one GitHub issue: a refit tryout is due
before next season.

On the 2026 rehearsal (`DRIFT_2026.json`; seen while writing the rule; the seed for the 2027 running check) nothing
fires. Luna's onset forecasts were graded 6.3 days late on average, but 5.8 of that is the weather part and 0.5 the
model part. Luna's peak model part is −3.6 days, 2.1 SD from its past seasons but inside the 7.8-day line, and it is
one strip: the far south's −14 (the extrapolation in [SOUTH_BIAS.md](../fit/SOUTH_BIAS.md)); the other four average
−1.0. So **this alarm is for a model going stale everywhere, not for one strip failing**: that strip is only listed
(`beyond_past`), and the A1 shadow in PREREG_2027.md is the tool for it. Caveats: the 1.5-day allowance comes from one
species, one strip and three years, and the three largest 2026 gaps all lean early (luna peak −5.0, Japanese beetle onset −3.3 and
peak −3.4 against their past means), which may be PRISM rather than drift. Re-measure it when Daymet 2026 is out (due by
31 Aug 2027, with the P3.1 gate) and change it, if needed, only before a season starts. With 6 to 9 past seasons per
species the line is wide (5 to 12 days for one season in 2026), so this catches a large or lasting change, not a small one.

**Tryouts so far** (`tryouts/`): learning from this year's first sightings, no gain ([ASSIM_RESULT.md](tryouts/ASSIM_RESULT.md));
forecasting new regions, where a local heat clock beats the local calendar across the East by 1.6 days, found after
the fact, so it needs 2027 to confirm it ([REGIONAL_RESULT.md](tryouts/REGIONAL_RESULT.md)).

**When a verdict is given** ([`verdicts.py`](verdicts.py), nightly): the job opens one GitHub issue per final verdict
(league or eastern) saying what was decided and what happens next. A winner is swapped onto the map between seasons
by one pull request, following [PROMOTE.md](PROMOTE.md): the map must run exactly the fits the league graded.

**In the app** ([`summary.py`](summary.py), nightly, last): a `league` block in `live/scorecard.json` (the one league
file the site is deployed with) lists each tryout and the drift check's state; the About panel shows it, folded, as
"Model tryouts" under the live check. After rerunning `rehearse.py`, re-add it to main's copy:
`python3 pipeline/league/summary.py --card public/live/scorecard.json --live /nonexistent --drift pipeline/league/DRIFT_2026.json`.

Run: `python3 -m pytest pipeline/league` (offline) · `python3 pipeline/league/weekly.py --live live --season 2027 --force`
