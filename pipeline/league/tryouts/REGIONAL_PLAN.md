# Tryout 2 plan: regions that share but don't copy (written 2026-10-25, before any fit)

**Question.** Can one model cover the whole East if each region keeps its own warmth target, pulled toward what its
latitude predicts? P4 found one shared curve is worse than a local calendar there (7.07 vs 6.27 d) and drags the
Midwest from 3.86 to 5.65 d. Its rows show why: the shared curve runs 11 days late at 32 °N and 4-5 days early north of
42 °N, and removing each region's average miss cuts the error variance from 64 to 29 days².

**Analogy.** Estimating a rookie's batting average: start at what similar players hit, then trust their own at-bats
more as they pile up. Here the "similar players" are regions at the same latitude, and the at-bats are sightings.

**Data, as P4 (`pipeline/p4/wide.py`, `run_p4.load`).** Luna records 31-49 °N, 60-100 °W, 2015-2025, P1's filters;
P4's cut-offs (Midwest per strip, the East per 2° band, slid by latitude); P4's 2 × 4° effort grid; Daymet base 10 °C.
Targets exactly as P4: Midwest strip-years and eastern cell-years (2° latitude × 6° longitude) with at least 20 records.

**Model R1.** P3's likelihood (daylength-weighted degree-days, skew-normal targets, 7-day life, effort background,
observer weights, 1% strays, shrunk year effect), with each place-year's target location
`mu = mu0 + beta * (lat - 42) + v_region + u_year`, `v_region ~ Normal(0, S^2)`. Regions = the 2 × 6° cells, the
Midwest included. S is set inside each training set by empirical Bayes: fit with S = 200 DD, take the SD of v over
regions with at least 200 training records (floor 10, cap 200), refit with that S. Nothing is tuned on held-out data.

**Tests (all three reported, whatever they show).**
1. Leave-one-year-out (P4's 11 folds): East cell-years and Midwest strip-years. Compared with P4's one-curve model
   and the local calendar from the same rows.
2. Cold start: each eastern region with a scored cell-year is hidden entirely (all years) and forecast from latitude
   alone (v = 0). Compared with the one curve refitted without it and with a calendar slid by latitude from the
   other regions' cell-years.
3. South-to-north early warning (from tryout 1): on each issue date, half the mean bias-corrected miss of same-year
   regions whose peak was at least 10 days earlier, applied to R1's forecast.

**What would earn a bench spot (for an eastern layer, not the Midwest map).** R1 beats the local calendar in the East
on test 1 with a bootstrap interval over years that excludes zero, and beats the one-curve model on test 2. For the
Midwest map, R1 would have to beat P3 by 0.2 d (P4's bar) to become a luna challenger; that is not expected.
