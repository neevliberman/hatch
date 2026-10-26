# Swapping a winning challenger onto the map

The nightly job opens a "League verdict" issue when a verdict is given (`verdicts.py`). If it says
**challenger wins**, the challenger takes the map for the next season. The swap is one pull request, made between
seasons and before 1 March. A model never changes mid-season.

The rule for the swap: **the map must run exactly the model that won.** Its fits file must keep the hash it was
graded under, which is the `model.hash` in its archived forecasts and in `live/league.json`. A refit is never shipped
in its place, even one made with the same spec.

## Luna
The map's model lives in three places:
- `pipeline/replay/fold_fits.json`, the nightly forecast's fits, read by `build_live.py`;
- `src/data/luna-replay.json`, which holds the past-season view, the past errors behind the "likely" range, and the
  model id the app shows;
- `public/fine/`, the finer hexes, built by `build_fine.py` from `fold_fits.json`.

1. On a fresh `claude/<topic>` branch, **copy the winner's frozen fits file over `fold_fits.json`** (for P3.1:
   `fold_fits_p31.json`). Check that `sha256sum` starts with its graded hash (P3.1: `a9fb5fe06cdb`).
2. **Rebuild the replay from those fits.** `build_replay.py` today always refits (`p3_loyo`) and rewrites
   `fold_fits.json`, so a refit would replace the graded fits.
   - The first swap must therefore add a "use the frozen fold fits" path to it. That path computes the
     leave-one-year-out scores and forecasts from `fold_fits.json` without refitting, the way `build_fine.py`
     already does.
   - It must also read the winner's own headline, not P3's: for P3.1 that is `pipeline/fit/results/p3_1/headline.json`,
     because `results/headline.json` has no `p31_flat` scores.
   - `MODEL_IDS` names the model (`p31_flat` gives `p3.1-v1`).
   - Re-check the hash after the rebuild.
3. Rebuild the finer hexes (`python3 pipeline/replay/build_fine.py`). It refuses fits that do not reproduce the
   replay.
4. Rerun the window check (`python3 pipeline/fit/calibration.py`). If the "likely" range is clearly off, say so in
   the PR.
5. **The pre-registration.** `fold_fits.json`, `build_replay.py` and `luna-replay.json` are pinned by PREREG_2027.md
   (`prereg_hashes.py --check` runs in CI). Once its test is decided, add an amendment line that records the swap,
   or close the old pre-registration and pin the files in the next season's.
6. Bench: the winner leaves the bench after its verdict. If the old champion should stay in the league, add it as a
   challenger for the new season, with its own rule written before 1 March. Update README text that names the model.
7. Open the PR with the usual reviewers, merge it before 1 March, then close the verdict issue.

## Other species
The same steps apply, using the species' own fits and replay (`pipeline/live/registry.py`).

## The eastern clock
"Clock wins" earns an eastern layer: a new map layer, built after the verdict from the frozen `east_static.json`.
It is a feature to plan, not a file swap.
