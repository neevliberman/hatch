# Swapping a winning challenger onto the map

The nightly job opens a "League verdict" issue when a verdict is given (`verdicts.py`). If it says
**challenger wins**, the challenger takes the map for the next season. The swap is one pull request, made between
seasons and before 1 March. A model never changes mid-season.

The rule for the swap: **the map must run exactly the model that won.** Its fits file must keep the hash it was
graded under (the `model.hash` in its archived forecasts and in `live/league.json`).

## Luna (the champion's files: `pipeline/replay/fold_fits.json`, `src/data/luna-replay.json`)
1. On a fresh `claude/<topic>` branch, set `"chosen"` in `pipeline/fit/results/headline.json` to the winner's spec
   (for P3.1: `p31_flat`). `build_replay.py` names the model from it (`MODEL_IDS`: `p31_flat` gives `p3.1-v1`).
2. Run `python3 pipeline/replay/build_replay.py`. It refits the leave-one-year-out folds with that spec and
   rewrites `fold_fits.json` and `luna-replay.json`. The replay holds the past-season view, the past errors behind
   the "likely" range, and the model id the app shows.
3. **Check the hash:** `sha256sum pipeline/replay/fold_fits.json` must start with the winner's graded hash (P3.1:
   `a9fb5fe06cdb`). If the refit does not reproduce it, copy the winner's frozen fits file over `fold_fits.json`
   instead and rebuild the replay's scores from it. Never ship a refit the league did not grade.
4. Rerun the window check (`python3 pipeline/fit/calibration.py`). If the "likely" range is clearly off, say so
   in the PR.
5. Bench: remove the winner's entry from `pipeline/league/bench.py` (it leaves the bench after its verdict
   anyway). If the old champion should stay in the league, add it as a challenger for the new season, with its own
   rule written before 1 March.
6. Write the next season's pre-registration (as `pipeline/fit/PREREG_2027.md`), and update README text that names
   the model.
7. Open the PR with the usual reviewers, merge it before 1 March, then close the verdict issue.

## Other species
The same steps apply, using the species' own fits and replay (`pipeline/live/registry.py`).

## The eastern clock
"Clock wins" earns an eastern layer: a new map layer, built after the verdict from the frozen `east_static.json`.
It is a feature to plan, not a file swap.
