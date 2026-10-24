# Pre-registration: P3 vs P3.1, 2027 season (written 2026-10-24)

Same rule as FROZEN_P3.md: write the rules down, then look. **No 2027 data exists yet.** Last data seen: the 2026 season (dry run, `pipeline/live/DRYRUN_2026.md`, and the 2026 rehearsal on the `scorecard` branch).

**What had been seen, honestly.** P3.1 was tried and dropped *because* of 2026 (RESULT.md, DRYRUN_2026.md: P3.1 4.4-6.9 d vs P3 2.1-3.1 d). So 2027 is a second chance for P3.1 and a first clean test of that 2026 result, not a fresh start. The rules below are tilted toward keeping P3 for that reason.

## The question
Over the 2027 first brood, does P3.1 (`p31_flat`: no daylength term, warmth targets at or above zero) forecast luna onset and peak dates better than P3 (`p3_photo`, the model on the map)? Both run every night from 2 March in the same live job on the same weather, same hexes, same effort profile; P3.1 is a shadow and never appears on the map. Each model has its own archive, so the scorecard (which grades one frozen model per archive) runs once per model.

## What is pinned (sha256 of the file bytes; `python3 pipeline/fit/prereg_hashes.py` reprints them)
| File | sha256 | Role |
|---|---|---|
| `pipeline/replay/fold_fits.json` | `7dc3c4c0887b3a9382164051e88d8b5344d8a7796047615e4c6dfb0342d0334f` | P3 live fits, model id `p3-v1` (this hash's first 12 characters are the scorecard's model hash) |
| `pipeline/fit/results/loyo_params.json` | `5085403514363aaa5f4ab454cc1bb5ef5ec1bb4893d3beab7f4cc5cd1d815f05` | P3 fold fits, run 2 (source of the line above) |
| `pipeline/fit/results/p3_1/loyo_params.json` | `f24032deb4255b583501b0c1532f68cb51a4b49c4cdd1dab1c57a7eea4dd8a4e` | P3.1 fold fits (`p31_flat` entries) |
| `pipeline/fit/model.py` | `54153777022a781efe832fc7296ae24448e1ddd2a7eb20b3c390f5ae2ab7fc5a` | model definition |
| `pipeline/live/effort_profile.json` | `2508c2dfa0561284b61795cab934570a556f6b174407cb1e7f9c523a445353c1` | shared nightly input |
| `pipeline/live/prism_offsets.json` | `6c53fbaca6cb0c6ad9fa7dfacc554d9034452b1f55b68be58eac8156674beef5` | shared nightly input |
| `calendar:luna-replay.json#scores` | `748a4b425bc867ee0e19322f1de5a7d595a85aa9e4bf28458c74f56d0628161a` | calendar baseline numbers (hash of each band-year's real onset and peak in `src/data/luna-replay.json`) |

Git state when pinned: base commit `7dbf813` (branch `prereg`); P3.1 was committed in `e6256aa`..`4471ec6`; P3 in `896bef5`. The content hashes are the pin; the commit ids are for finding things. `pipeline/fit/tests/test_prereg.py` fails if any pinned file changes without this table changing too.

**One gap, closed before the season.** P3.1 has no live-format fits file yet (the map's `fold_fits.json` is P3's). By **1 March 2027** it is built mechanically from the P3.1 file above by the same code that wrote P3's (`pipeline/replay/build_replay.py`, no refit), and its hash and model id (`p3.1-v1`) are added here as a dated amendment. If its numbers differ from the P3.1 file above, the amendment says why; if they cannot be reconciled, P3.1 is dropped from the test and the map stays on P3.

## The metric
Per 2-degree latitude band ("strip"), as the scorecard defines it: **miss = mean of |forecast onset - real onset| and |forecast peak - real peak|, in days**. Real onset/peak = 10th percentile / median day of the strip's first-wave research-grade records (wild, exact location, adult or unannotated, one per observer + hex + day; the FROZEN_P3.md filters). Forecast = the newest archived forecast issued at least 7 days before each real date. **Headline = the strips' misses averaged with each strip weighted by its number of first-wave records** (the dry run's "sighting-weighted"). The scorecard's own unweighted mean is also reported but does not decide. The dry run's rough hex-median summary is *not* this metric; it was a smoke test.

## Which bands and dates count
- The five strips 37-39, 39-41, 41-43, 43-45, 45-49 N. A strip counts only if it has at least 20 first-wave records and is scored for **both** models.
- A strip is scored only after its first-wave cut-off (from `src/data/luna-replay.json`, per strip) plus the **14-day settle window**; before that it is "pending", never scored early. Records posted later than the score date are ignored.
- The verdict uses the scorecard as of **Monday 27 September 2027** (the Monday on or before 30 Sep), using the record pull saved that day (its file hash is written to the verdict note). Later records do not change it.
- Second brood and anything after day 240 are excluded.

## Calendar baseline
Each strip's mean onset and peak over the scored band-years in `luna-replay.json` (hash above), as the scorecard computes it. Reported for each model. It is a sanity check, not part of the win rule: a model that does not beat the calendar in 2027 gets that said plainly in the write-up.

## Decision rule
D = headline miss of P3.1 minus headline miss of P3 (negative favours P3.1).
- **P3.1 wins:** D is -1.0 d or lower, **and** P3.1 has the lower miss in at least 3 of the scored strips. Then P3.1 goes onto the map for the **2028** season (never mid-2027), *provided* the Daymet 2026 re-check below does not show P3 ahead by 1.0 d or more. If it does, the two seasons disagree and the map stays on P3 until a third season.
- **Tie:** D is between -1.0 and +1.0 d, or P3.1 meets -1.0 but not the 3-strip condition. The map stays on P3 (the incumbent; P3.1 has to earn the swap). P3.1 stays a shadow for 2028.
- **P3 wins:** D is +1.0 d or higher. P3.1 is retired; the map stays on P3.
- **No verdict** (stays on P3, written up as such): fewer than 3 strips or fewer than 150 first-wave records in total are scored for both models by 27 Sep.
Why 1.0 d: the leave-one-year-out difference between the two models had a 95% interval of about plus or minus 0.3 d, the noise floor of one band-year is about 3 d, and with five strips one season is thin.

## Minimum sample sizes
20 first-wave records per strip; at least 3 strips and 150 records in total for a verdict (above). The 2026 rehearsal had 5 strips with 54-222 records each, so this is expected to be met.

## Not allowed
- No refit, re-tuning, bound change, or new variant of either model during the season; no swapping the map's model mid-season; no tweaking either model's inputs (offsets, effort profile, cut-offs) after 1 March.
- No change to the metric, weights, bands, settle window, lead days or thresholds after **1 March 2027**. Before then, a change needs a dated amendment below with the reason.
- No dropping a strip or a day because it looks odd. Bad data is handled by an amendment dated before the score is read, or reported alongside.
- A pinned file that changes needs a dated amendment here with the new hash and the reason; the test enforces it.
- Everything the season produces is reported, including a P3 loss of its own advantage.

## Mid-2027 re-check: Daymet 2026
The models were fitted on Daymet weather, but the 2026 dry run and rehearsal used PRISM (with offsets). Daymet 2026 is expected around **mid-2027**. When it is out (check by **1 August 2027**), re-score the 2026 dry run for both models with Daymet 2026 instead of PRISM, same strips, same metric, same 14-day settle window and 7-day lead (no 7-day weather forecast either way). Record the result here as a dated note. It cannot change the 2027 metric or thresholds; it feeds the "P3.1 wins" proviso above and says how much of the 2026 miss was the PRISM-vs-Daymet gap. If Daymet 2026 is not out by 1 September 2027, say so here and apply the proviso as "no evidence of reversal".

## Amendments
(none yet; each entry: date, what, why, new hash, and whether any 2027 data had been seen)
