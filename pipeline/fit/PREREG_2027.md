# Pre-registration: P3 vs P3.1, 2027 season (written 2026-10-24, on main at 49bfe36)

**In plain words.** Two versions of the luna moth forecast, P3 (on the map now) and P3.1 (a simpler cousin), will both forecast the 2027 season in secret agreement: P3.1 runs as a hidden "shadow" and never appears on the map. We write down now, before any 2027 moth is logged, how we will decide whether P3.1 deserves to replace P3, and we pin the exact code and numbers so nobody (including us) can move the goalposts. No 2027 data exists yet.

**What had been seen.** P3.1 was dropped because of 2026 (P3.1 4.4-6.9 d vs P3 2.1-3.1 d in the dry run). So 2027 is a second chance for P3.1, and the rules favour keeping P3. The scorecard rehearsal on 2026 (`SCORECARD_2026.md`, P3 only) missed by 5.6 d against 8.2 for the calendar, with 6 of 10 dates inside the "likely" range. P3.1 has not been run through the scorecard.

## Glossary
- **Strip**: a 2-degree latitude band (37-39, 39-41, 41-43, 43-45, 45-49 N). **Hex**: a map cell (H3 res 4) the model forecasts.
- **First wave**: first-brood sightings, up to the strip's cut-off day (`bands[].cutoff` in `luna-replay.json`; 45-49 N has none, so day 240).
- **Onset / peak**: the day 10% / 50% of a strip's first-wave sightings are in (10th percentile / median). **Miss**: mean of |onset error| and |peak error|, days.
- **Settle window**: a strip is scored only after its cut-off plus 14 days, so late uploads are in; before that it is "pending". **Lead**: the forecast graded is one issued at least 7 days before the real date.
- **Shadow**: P3.1 forecasts nightly beside P3, in its own archive. **D**: P3.1 headline miss minus P3 headline miss (negative favours P3.1).

## What is pinned (sha256 of file bytes; `python3 pipeline/fit/prereg_hashes.py` reprints them)
| File | sha256 | Role |
|---|---|---|
| `pipeline/live/scorecard.py` | `e50aed72e9fcf0ffe55ce6fc586b71fcce33f2b29a963edda7f5ca26840019ef` | the scorer (settle 14, lead 7, min 20 records, frozen `scored_on` rows) |
| `pipeline/live/build_live.py` | `b95c618b379a9b3afd5d030bed62882a3b1160eae6de78a3f81024c83d2ec211` | nightly forecast; `PRISM_LAG_DAYS` = 3; model hash = first 12 characters of the fits file's sha256 |
| `notebooks/hatch_p1/prep.py` | `e95a096a1e46c0a8cbb5b46239c67a884a415807fa03ddec31ee1480d1dd1127` | record filters (`clean`) |
| `pipeline/replay/build_replay.py` | `76c0fa534f0888dd9f94592782a85d2634ed00aec5b7f80265bb528afd15b104` | writes the fold fits (P3.1 id `p3.1-v1`) |
| `pipeline/replay/fold_fits.json` | `7dc3c4c0887b3a9382164051e88d8b5344d8a7796047615e4c6dfb0342d0334f` | P3 (`p3_photo`) live fits, id `p3-v1`, hash `7dc3c4c0887b` |
| `pipeline/replay/fold_fits_p31.json` | `a9fb5fe06cdb5ecaba79ed6a4a10b494793241e48d1aa9e6b773b22d54500c7b` | P3.1 (`p31_flat`) live fits, hash `a9fb5fe06cdb`; params from the file below, cut-offs identical to P3's (checked against every `loyo_rows.csv` row), no refit |
| `pipeline/fit/results/loyo_params.json` | `5085403514363aaa5f4ab454cc1bb5ef5ec1bb4893d3beab7f4cc5cd1d815f05` | P3 fold fits, run 2 (matches `fold_fits.json`) |
| `pipeline/fit/results/p3_1/loyo_params.json` | `f24032deb4255b583501b0c1532f68cb51a4b49c4cdd1dab1c57a7eea4dd8a4e` | P3.1 fold fits |
| `pipeline/fit/model.py` | `54153777022a781efe832fc7296ae24448e1ddd2a7eb20b3c390f5ae2ab7fc5a` | model definition |
| `pipeline/live/effort_profile.json` | `2508c2dfa0561284b61795cab934570a556f6b174407cb1e7f9c523a445353c1` | shared nightly input |
| `pipeline/live/prism_offsets.json` | `d117d0fc294d7d02400558825709fcc925ef90535f2092cea8f7a7bd15a15617` | shared nightly input |
| `pipeline/live/records/luna_2026_rg.parquet` | `25e89a667e0502396c31fca17d6b1c0d8e2f637ce93bf6567a087e10d7a28aff` | the 2026 records (1,363 research-grade, pulled 24 Oct 2026) used by the Daymet re-check |
| `replay:luna-replay.json#scores+cutoffs+sightings` | `2b30c49ba608ff1a8a8b6102518b3d464b2d554b214cc2c720aafcad318e309a` | calendar baseline numbers, per-strip cut-offs and the sightings behind band weights, all read from `src/data/luna-replay.json` |
| `pipeline/league/rules.py` | `6b519ccfeceea046971ecd69fbe06db987d0b895070caab7330844036f4d076b` | the decision rule below, as code (added 2026-10-25, pre-season) |
| `pipeline/league/weekly.py` | `5a16a8c9c540244a5d370abede007247343258442416b022ccf9bfe4838e1ae6` | the weekly head-to-head: records pull + sha256, common nights, both scorecards, verdict-week cap (added 2026-10-25). P3.1's bench entry (`pipeline/league/bench.py`) is held to this file by `pipeline/league/test_league.py`; the gate's number (`pipeline/league/gates.json`, unpinned so it can be recorded by 31 Aug 2027) must equal the one written in "Daymet result" below, checked by the same test |

Scorecard commit: `49bfe36` (main). Model commits: P3 `896bef5`, P3.1 `e6256aa`..`4471ec6`. The content hashes are the pin; commit ids are for finding things.

## The test
Both models run every night from 2 March in the same live job: same weather, hexes, effort profile, PRISM offsets and lag. **Before 1 March 2027** the shadow job must exist (an amendment with `reason=pre-season` for any pinned file it touches, e.g. a fits-path switch in `build_live.py`) and have archived at least one night to its own folder (`live/archive_p31/`). If it is not archiving by 15 March 2027 the head-to-head is void for 2027 (the map stays P3) and this prereg carries over unchanged to 2028.

**Same issue dates.** Only nights archived by *both* models count. The two archives are cut to their common nights (a night missing for either model is dropped for both, so an outage cannot favour one) and `scorecard.py` is then run unmodified on each, weekly, with the same records pull, each model starting from its own last file so scored rows stay frozen. For each date the graded forecast is the newest common night issued at least 7 days before the real date; if none exists, that strip is "no forecast" for both and is not counted.

**Records.** An automated Monday job pulls the season's research-grade records once, saves the file with its sha256 to the `live-data` branch (`live/records/2027/<date>.parquet`), and feeds the same file to both scorecards. Verdict date: **Monday 27 September 2027** (strips that settle later are not counted). A strip's row is the one first scored (`scored_on`); later uploads change nothing.

## The metric and what counts
Per strip, the scorecard's `miss` (rounded to 0.1 d, as published; D uses these rounded values). **Headline miss** = the strips' misses averaged with weights = each strip's first-wave record count `n` in its scorecard row (the same `n` for both models; the check fails the run if they differ). The scorecard's unweighted summary is reported, not decisive. A strip counts only if scored (at least 20 first-wave records, cut-off + 14 days passed) for **both** models. Calendar baseline: the scorecard's strip mean onset/peak over the scored `luna-replay.json` band-years (hash above); reported for both, not part of the rule. Second brood and days after the cut-off are excluded.

## Decision rule
- **P3.1 wins:** D <= -1.0 d **and** P3.1 has the strictly lower rounded miss in at least 3 strips (a strip with equal rounded misses is a tie and counts for neither; with exactly 3 scored strips that means all 3) **and** the 2026 gate below passes. Then P3.1 goes on the map for the **2028** season only, never mid-2027.
- **Tie:** anything else with at least 3 strips and 150 records scored (including D between -1.0 and +1.0, or D <= -1.0 but the strip count or gate fails). The map stays P3. A tie is not evidence the models are equal, only that P3.1 did not earn the swap.
- **P3 wins:** D >= +1.0 d. P3.1 is retired; the map stays P3.
- **No verdict:** fewer than 3 strips or 150 records scored for both by 27 Sep. Map stays P3.
- **2026 gate (Daymet re-check).** The models were fitted on Daymet but the 2026 rehearsal used PRISM. Procedure, fixed now: rebuild the 2026 rehearsal (`rehearse.py`, same Monday issue dates and the same as-of days as the PRISM run) for both models with Daymet 2026 weather at the hex centres, grade it with the pinned `scorecard.py` and 2026 records file, headline miss as above, giving D(2026). **One firm deadline, 31 August 2027**, the result is written in the "Daymet result" section below. If Daymet 2026 is not published by then, D(2026) is instead computed with PRISM on the same procedure, which must be recorded before 1 March 2027. The gate fails if D(2026) >= +1.0 d. It is a fixed rule: it cannot be waived or invented after 2027 scores are visible.

**Why 1.0 d.** Across the 9 past leave-one-year-out years (`results/p3_1/loyo_rows.csv`, 31 band-years), the record-weighted season-level D between P3.1 and P3 has a mean of -0.1 d and an SD of **0.32 d**. A 1.0 d gap is about 3 SD of that, so noise alone rarely reaches it. It is a floor, not proof: in the 2026 dry run D was +2 to +4 d, about ten SD out, so the live setup (PRISM weather, offsets, sampled weather endings) can separate the models in ways leave-one-year-out never showed. Five strips in one season is thin, hence the 3-strip condition and the 2026 gate.

## Not allowed
- No refit, retune, bound change or new variant of either model during the season; no changing the map's model mid-season; no changing offsets, effort profile, cut-offs or filters after 1 March.
- No change to the metric, weights, strips, settle window, lead, thresholds, verdict date or gate after **1 March 2027**. No dropping a strip or night because it looks odd.
- **Amendments after 1 March 2027** are limited to two reasons: `bug-both-models` (a defect that breaks forecasts or scoring, fixed identically for both models) and `feed-outage` (a weather, iNat or archive outage, handled the same way for both). Each lists which strips were already scored (their rows stay frozen). An amendment can never change model parameters, the metric, thresholds, the verdict date or the gate. Before 1 March, `reason=pre-season` is also allowed.
- A pinned file may change only via an amendment line below; `pipeline/fit/tests/test_prereg.py` fails CI (`.github/workflows/tests.yml` runs `pytest -q pipeline`) otherwise. This is a tripwire, not a lock: a determined edit of the test or table is visible in git history.

## Second shadow: "A1 cap + flag and widen" (rule written 2026-10-25, before any 2027 data)
A separate, secondary shadow beside P3 (P3.1 vs P3 above stays the decisive test and is untouched by this section). It
is the combination proposed in `notebooks/southbias/RESULT.md` ("Proposed (not implemented) for 2027"); that combination
was chosen after seeing the 2026 scores, so it is **not** a pre-registered winner and 2026 is a second look for it.
Code: `pipeline/live/shadow_rule.py`, tests `pipeline/live/test_shadow_rule.py`. In plain words: never believe a warmth
balance richer than the richest one the model learned from, and where a place is past that, say so and stretch the
"likely" range to include the usual date. The point forecast is not moved.
1. **Envelope E(t)** per fold fit: on each day index t (day of year - 1), the largest banked degree-days (Daymet, base
   10 C, from 1 March) at any training place-year (a hexagon-year with at least one first-brood training record), all
   latitudes pooled. 11 arrays of 365 numbers, shipped beside `fold_fits.json`.
2. **A1 cap:** each hexagon's running bank is replaced by min(bank, E(t)) (`cap_inc`); the frozen P3 forecast then runs
   unchanged on the capped weather.
3. **Flag:** a hexagon is flagged if its real, uncapped bank is strictly above E(t) on any day from 1 April (index 90) to
   its strip's A1 forecast peak. A strip is flagged if any hexagon with positive strip weight is flagged.
4. **Widen, don't move:** a flagged strip's onset and peak "likely" ranges become (min(lo, c), max(hi, c)), c = the
   scorecard's calendar date for that strip and quantity. Unflagged strips and all point forecasts are unchanged.
5. **Weather sources, as they differ:** E(t) is built from Daymet (what the fit saw); the live bank is PRISM as
   `pipeline/live/sources.py` reads it, after `prism_offsets.json`. The check on 2023-2025 (`notebooks/southbias/prism_flag.py`)
   found PRISM moves which years fire rather than firing more often.
6. **Grading:** the scorecard's `miss` on the point forecast would be identical to P3's except where the cap binds; the
   widening is judged only by coverage of the real onset/peak and the widened width, reported, not part of the
   P3.1 decision rule above.

**Not yet done, and not hidden:** the 11 envelope arrays are not in the repo (they need the Daymet cube and training
records, which are not cached here), the rule is not wired into `build_live.py` or an archive (`live/archive_a1/`), and
the card text for a flag is not written. Each of those touches or adds inputs and must land before 1 March 2027 with a
`reason=pre-season` amendment line for any pinned file it changes (`build_live.py` is pinned). Until then this shadow does
not exist and nothing is claimed for it. If it is not archiving by 15 March 2027 it is dropped for 2027, with no effect on
the P3 vs P3.1 test.

## Amendments
Format: `- date | path | new sha256 | reason=<code> | scored=<strips or none> | why`.

- 2026-10-25 | pipeline/live/scorecard.py | 6c9f8adf2cf8452ef60ff5f43962ce6d2c7173f5752e6b21b1269d64dff8cfc7 | reason=pre-season | scored=none | added firefly and Japanese beetle layers and per-season history (#57, #60, #63); luna rows of public/live/scorecard.json compared with the registered version: every luna number identical, one note reworded ('moths' to 'peak')
- 2026-10-25 | pipeline/live/build_live.py | 6c1381d1078b2056cc40b6a0e6a8c7c86b41365ef724d9c078ce56f4252d14ce | reason=pre-season | scored=none | added firefly and Japanese beetle layers and per-season history (#57, #60, #63); luna rows of public/live/scorecard.json compared with the registered version: every luna number identical, one note reworded ('moths' to 'peak')
- 2026-10-25 | pipeline/live/build_live.py | 88e30feb041332509c76fde2621646d51810ce15b9525b4219cb9f0ae0d2fd15 | reason=pre-season | scored=none | the P3.1 shadow this prereg requires (pipeline/league/bench.py): each night P3.1 runs on the same weather, cells, effort profile and lag as P3 and its strip dates are written under "shadows" in the live file; a 2026-06-01 backfill built with the old and new file is identical in every field except the new "shadows" key and "checks.shadows_failed"
- 2026-10-25 | pipeline/live/scorecard.py | 80901dfe7b4bb0ff2f94cda15df1f559929deda8a7d08bfcf174898527f54573 | reason=pre-season | scored=none | archives the shadow nightly into live/archive_p31/ (never a backfill) and, once per scoring week, runs pipeline/league/weekly.py: the Monday records pull saved with its sha256 to live/records/2027/, both archives cut to common nights, the unmodified scorecard() run on each from its own last file, and this file's decision rule (pipeline/league/rules.py); no scoring function changed

## Daymet result
(to be filled by 31 Aug 2027: date, Daymet 2026 version, D(2026) for both models, gate pass/fail)
