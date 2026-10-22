# P3 frozen choices (written 2026-10-22, before any P3 score was computed)

Same rule as P1: write the choices down, then look. Anything changed after scoring goes in the change log at the bottom with the reason, and both results are kept.

**What had been seen before writing this.** P1's results ([RESULT.md](../../notebooks/RESULT.md)) and P2's per-band bias (forecast about 6 d early at 37-39 °N and 4 d late at 45-49 °N). While building the code I fitted the model once to *all* records pooled (no held-out scoring) to check that it runs and converges. That fit put the latitude slope at about +1 degree-day per degree of latitude (close to zero) and the skew close to a half-normal. The daylength version needed a warm start to converge, so every model with a latitude or daylength term now starts from the flat model's fit. Simulate-and-recover on synthetic data was run (it passes, see tests). No held-out score of any model had been computed.

## Data (unchanged from P1)
- Luna moth (taxon 47916), iNat places WI IL MN IA MI IN OH, 2015-2025. P1's frozen record filters (`hatch_p1.prep.clean`): research grade, not captive, not obscured, accuracy ≤ 5 km or blank, no non-adult life-stage annotation.
- **One record per observer + res-4 hex + local date** (`observed_on`, the observer's local date, keyed by ISO date, never UTC).
- Records after day-of-year 240 are never first brood.
- State = the state polygon (from `src/data/midwest-states.json`) that contains the record; nearest polygon if none does.
- Temperature: Daymet v4 daily Tmin/Tmax at each hex centre; double-sine degree-days, **base fixed at 10 °C**, upper cutoff 30 °C, from 1 March.
- **Effort background:** daily verifiable iNat records of moths (Lepidoptera 47157 minus butterflies 47224) per state, from the histogram endpoint, plus 1 per day as a floor. Night-time filtering and per-hex pooling are not possible through that endpoint and are deferred.

## Model (primary, "P3")
- Each place-year's moths have warmth targets that follow a **skew-normal** curve in degree-days: location μ, spread σ, skew α.
- **μ = μ0 + β·(hex latitude − 42)** + u_year (the "lat" model), *or* the **daylength alternative** ("photo"): no β, but each day's degree-days are multiplied by (daylength / 12 h)^γ before summing (photothermal units, one parameter γ). Exactly one of the two is used; the choice rule is below.
- **Year effect** u_year on μ for training years, shrunk with a normal prior SD 30 degree-days. A held-out year, and every spatial-holdout prediction, uses u = 0.
- An adult flies **7 days** after reaching its target, so the share of a place's moths in the air on day t is F(DD(t)) − F(DD(t − 7)).
- **Likelihood of a record on day t** (window 1 March to the band's brood cut-off): 0.99 × flight share(t) × effort(state, t) / Σ over the window + 0.01 × effort(state, t) / Σ effort (a 1% contamination term). Records are weighted **1/√(that observer's record count)**, rescaled to mean 1.
- Fitted by maximum penalised likelihood (L-BFGS-B).

### Choosing lat vs photo (once, before the main scoring)
Leave-one-year-out **on IL/IN/OH records only**: fit each on 10 years, compute the log-likelihood of the held-out year's IL/IN/OH records (u = 0). The one with the higher total wins and is "P3" everywhere below. WI/MN records play no part in this choice, so the spatial holdout stays clean.

### Variants (reported, never used to pick the headline)
- **flat:** no latitude or daylength term. This answers "does the latitude term help?"
- **no effort:** effort = 1 every day.
- **bell:** α = 0 (normal curve).
- The loser of lat vs photo.

## Brood cut-offs, per fold
P1's rule (smoothed day-of-year histogram, dip between days 150 and 220, split if the dip is below 80% of both humps), computed **from each fold's training records only**, per latitude band (37-39, 39-41, 41-43, 43-45, 45-49 °N). A band with fewer than 20 training records, or no dip, gets day 240. The same cut-off defines the held-out year's first-brood targets and truncates the model's prediction window.
In the spatial holdout the WI/MN targets use cut-offs from WI/MN records of the *other* years (a target definition; the model never sees WI/MN records).

## Targets and metric (as P1)
- Band-year with **≥ 20 first-brood records**: onset = 10th percentile day, peak = median day.
- **Metric: mean absolute error in days of onset and of peak, and their average ("MAE")**, over band-years.
- Predicted onset/peak = the days the band's predicted sighting curve crosses 10% / 50%. The band curve is the mix of each hex's curve (flight share × that state's typical effort shape averaged over training years, truncated at the cut-off), weighted by the hex's share of the band's training records.
- Also reported: mean signed error per band (forecast − real), to see whether the south-early / north-late bias shrank.

## Comparisons
- **Calendar:** the band's mean onset/peak over training band-years (falls back to the quantiles of the band's pooled training records if it has no scored training year).
- **P1 exploratory model** (what P2's map shows): base 10 °C, the empirical spread of degree-days at training sightings, hex-weighted, no effort, no truncation, rerun on the same per-fold cut-offs and targets.
- **Spatial holdout only:** also a calendar learned in IL/IN/OH and slid north by latitude (band-year dates regressed on latitude). The plain "calendar" in the holdout is WI/MN's own other years, a deliberately tough comparison, since it uses local data the model never sees.

## Evaluations (run once)
1. **Leave-one-year-out, all 7 states:** for each year, fit on the other 10 years and predict that year's band-years.
2. **Spatial holdout:** fit on IL/IN/OH records (all years), predict every WI/MN band-year with ≥ 20 records. Fitted parameters are frozen before any WI/MN record is touched.

## Uncertainty
- **Error intervals:** 2,000 bootstrap draws resampling years, then observers inside each band-year (targets recomputed, predictions held fixed); 95% percentile intervals for each MAE and for MAE(other) − MAE(P3).
- **Noise floor:** bootstrap SD of each target (500 draws; records, and separately observers); a perfect predictor would still score about SD·√(2/π). Reported next to every error.
- **Parameter intervals:** refits on 60 bootstrap resamples of years and 60 of observers (β or γ, and the median warmth target at 38/42/46 °N).

## What counts as what (decided now)
- **P3 beats X** = lower average MAE. It is "clearly" better when the 95% interval of MAE(X) − MAE(P3) excludes 0.
- **Spatial holdout passes** if P3's MAE on WI/MN is lower than both the P1 model's and the latitude-slid calendar's. Beating WI/MN's own calendar is reported but not required.
- **The latitude (or daylength) term helps** only if P3 beats *flat* on leave-one-year-out MAE *and* has the higher held-out log-likelihood in the selection step's terms. Otherwise the write-up says it does not.
- **The bias shrank** if P3's mean signed peak error is closer to 0 than P1's in both the southern (37-39) and northern (45-49) band.
- The map uses P3's leave-one-year-out fits whatever the result, and the write-up says plainly what failed.

## Deferred (and why)
- **Air vs soil degree-days:** needs ERA5-Land via Open-Meteo, which is blocked from this environment.
- **Weekday term and event flags:** the daily effort background already carries weekends, Moth Week and BioBlitz spikes; a separate term is not added.
- **Research grade + needs-ID fit, urban vs rural split, night-only background, a fresh 2026 season:** not in this round.

## Change log
- **2026-10-22, run 1 (as pre-registered), results kept in `results/run1_as_preregistered/`.** Daylength ("photo") won the selection step. Leave-one-year-out: P3 4.27 d, P1 4.05 d, calendar 7.31 d. Holdout: P3 9.79 d, P1 6.26 d, latitude-slid calendar 10.71 d, so it **failed**.
- **2026-10-22, optimiser bug fix (not a choice change), then run 2.** Run 1's parameters showed two kinds of fit: a strongly skewed curve (α ≈ 10) in most folds, and a wide near-symmetric curve, sometimes with σ stuck at its 800 DD bound, in the 2022 fold, the holdout fit and 13 of 120 bootstrap refits. Refitting those data sets from a second start found the skewed fit with a clearly better likelihood every time (2022 fold, flat model: 7591.5 vs 7646.1; holdout, photo model: 5183.7 vs 5209.2). So run 1 did not find the maximum likelihood the pre-registration specifies. The fitter now starts from several points (its old default, α = 10, α = 0.5, and the flat fit for lat/photo) and keeps the best. Nothing else changed: same model, rules, folds and metric. Run 2 is the run of record for the map, and **both runs are reported** in RESULT.md. Run 2's holdout comes after seeing run 1's, so it is weaker evidence than a first look.
- **2026-10-22, run 2 logistics.** The first attempt at run 2 was stopped by the environment's 2-hour job limit during the bootstrap refits. `run_p3.py` now caches each stage, and bootstrap refits start from the all-data fit (one start each, to keep the run under the limit). Fold fits, selection and scoring are unchanged and multi-start. 11 of 120 bootstrap refits still went to the degenerate wide-curve fit. They are kept in the CSV and left out of the parameter ranges quoted in RESULT.md.
