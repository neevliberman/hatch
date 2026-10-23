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

## Amendment: P3.1, 2026-10-22 (written before any P3.1 score was computed)

**This choice was made after seeing the P3 holdout.** P3's pre-registered pick (daylength, "p3_photo") failed the spatial holdout, and the no-term variant ("p3_flat") did well there (5.1 d). Review also found that nothing kept warmth targets above zero. So P3.1 is chosen *because of* those results. Its holdout score is a second look, not a confirmation. The only clean test of P3.1 is a season it has never seen (2026).

**What had been seen.** Every P3 score in RESULT.md, including p3_flat's leave-one-year-out (3.81 d) and holdout (5.1 d), and the 11 degenerate bootstrap refits (location at its −500 bound, median target near −225 DD). No P3.1 score had been computed.

**The model ("p31_flat").** P3's flat variant with warmth targets kept at or above zero:
- No latitude term and no daylength term. μ = μ0 + u_year.
- **Bounds: location μ0 ≥ 0 DD and skew α ≥ 0** (P3 allowed μ0 down to −500 and α down to −15). With α ≥ 0 the curve's median is at or above its location, so the median target can't go below 0. The share of the curve below 0 is at most a half at α = 0 and about 3% at α = 10. That share is dropped (the curve is conditioned on target > 0), which the likelihood already does, see below.
- **Why the bound, not conditioning alone.** Conditioning the skew-normal on target > 0 changes nothing in this likelihood: a moth whose target is below 0 has "flown" before 1 March, never shows in the window, and the curve is renormalised per place-year. Conditioning only rescales what is left by a per-place-year constant, which cancels. That is exactly why the degenerate fits were free to sit at −500. So conditioning would fix the label but not the fit. The bound changes the fit. It is inactive in every P3 leave-one-year-out fold of the flat model (μ0 61-70 DD, α 8-15), so it only stops the degenerate basin.
- The year effect u (shrunk, SD 30 DD) is unchanged and is not bounded. Predictions use u = 0, so every forecast uses μ0 ≥ 0.
- Everything else is P3 as frozen above: base 10 °C from 1 March, 7-day flight life, effort background, observer weights 1/√n, contamination 1%, per-fold brood cut-offs, ≥ 20 records per band-year, onset 10% / peak 50%, the MAE metric, the same 11 leave-one-year-out folds, the same IL/IN/OH → WI/MN holdout and its baselines, 2,000-draw error bootstrap and 60 + 60 bootstrap refits. The fitter is the same multi-start fitter, with starts clipped into the new bounds.
- No selection step: the spec is fixed here.

**Comparisons.** Calendar, P1, P3 (photo, refit on the same folds) and p3_flat (to show the bound is inactive).

**What counts as what.**
- P3.1 replaces P3 on the map if its leave-one-year-out MAE is no worse than P3's, or worse by less than the 95% interval of the difference allows (a tie counts). If P3 is clearly better (the interval of MAE(P3.1) − MAE(P3) is above 0), the map keeps P3.
- Holdout: reported with the same pass rule as P3 (beat P1 and the latitude-slid calendar), and against WI/MN's own calendar, always labelled a second look.
- Degenerate fits: a bootstrap refit with μ0 at its 0 bound is counted and reported, not dropped.
- **2026-10-22, P3.1 run (after the amendment).** `run_p3.py --model p31_flat --compare p3_photo p3_flat`, same folds and caches. Leave-one-year-out: P3.1 3.77 d, P3 3.85 d (a tie), so P3.1 replaces P3 on the map. Holdout (second look): 5.08 d, a pass. 9 of 120 bootstrap refits sat at the new μ0 = 0 bound with a wide curve. Refitting those 9 from all starts found no better fit, so they are kept, as the amendment says. P3's run 2 results moved to `results/p3_run2/`.

- 2026-10-22 (after P3.1 scoring, review note): the line above saying the bound "only stops the degenerate basin" is not quite right. The bound relabels that basin rather than removing it: 9 of 120 bootstrap refits now sit at mu0 = 0 with alpha 12-15 and a median target of 410-469 DD, about twice the main fit's 206. They are kept in the intervals, as this amendment requires. The "no better fit from other starts" check on those 9 was run ad hoc and is not saved as an artifact.

- 2026-10-23, outcome: **P3.1 is not adopted; the map stays on P3 (p3_photo).** The live pipeline's 2026 dry run (PRISM weather, 2026 sightings, neither model saw 2026 moths) was rebuilt with the P3.1 fold fits. Sighting-weighted strip miss as of 30 Sep: P3 2.1-3.1 d, P3.1 4.4-6.9 d, depending on the summary (see pipeline/live/DRYRUN_2026.md). P3.1 runs earlier in the south and later in the north, the lean the daylength term was there to remove. One season, rough check, but it is the only test either model has not touched, so the pre-registered pick stays on the map. This overrides the amendment's tie rule above, using a check that was not pre-registered (its summaries were chosen after seeing the results). P3.1's numbers are kept in `results/p3_1/`.

