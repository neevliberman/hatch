# P1 frozen choices (written 2026-10-21, before any model results were looked at)

Plan step 1 says: write the choices down first, then look. These are not tuned afterwards.
If one has to change, the change is logged at the bottom with the reason, and both results are kept.

## Data
- **Region:** iNaturalist places WI, IL, MN, IA, MI, IN, OH.
- **Species:** luna moth *Actias luna* (taxon 47916). Check species: common eastern firefly *Photinus pyralis* (129350).
- **Records kept for fitting:** research grade; not captive; not obscured; positional accuracy ≤ 5 km or blank;
  not annotated with a non-adult life stage (unannotated records are kept; the census reports the share).
- **Date:** iNat's `observed_on` (the observer's local date), keyed by ISO date. Never UTC.
- **Dedupe:** one record per observer, H3 res-4 hex and day.
- **Years:** 2015-2025. 2025 is a full season old (posting lag rule).

## Temperature and degree-days
- **Source:** Daymet v4 daily Tmax/Tmin at each H3 res-4 hex centre (1 km pixel). Daymet drops 31 Dec in leap years; that day is not in our window.
- **Method:** double-sine, horizontal upper cutoff **30 °C**, accumulated from **1 March**.
- **Base:** 10 °C for baselines (b) and (c); learned on a 0-15 °C grid (0.5 °C steps) for (d).

## First (spring) brood only (luna)
- **Bands:** latitude bands 37-39, 39-41, 41-43, 43-45, 45-49 °N.
- **Brood split, per band, from all years pooled:** smooth the day-of-year histogram (Gaussian kernel, 7-day bandwidth).
  The dip is the lowest point between day 150 and 220. If it falls below half the spring peak (and a second hump follows), records after the dip are second brood and dropped. *(Threshold changed to 80%, see change log.)*
  Otherwise the band is treated as one brood. Records after day 240 are always dropped.
- Fireflies are one brood; no split.

## Targets, scored on dates
- Per band-year: **onset** = 10th percentile of first-brood day-of-year; **peak** = median.
- Band-years scored only with **≥ 20 records** (also reported: the subset with ≥ 150, the plan's P3 bar).
- **Noise floor:** bootstrap the records within each band-year (500 draws); the median SD of the statistic is how precisely the target itself is known.
- **Leave-one-year-out:** every prediction for year Y uses only other years.

## Baselines
- **(a) Calendar:** mean of that band's onset (or peak) over the training years.
- **(b) Published rule (fireflies only):** 800 DD, base 10 °C, double-sine from 1 March, as the peak.
- **(c) Heat, base fixed 10 °C:** degree-days at each training sighting (at its hex) → μ = median, σ = IQR/1.349.
  Predicted share of sightings by day t in a band-year = Σ_hex w_hex · Φ((DD_hex,year(t) − μ)/σ),
  with w_hex = that hex's share of the band's training records. Onset/peak = day this crosses 10% / 50%.
- **(d) Full:** as (c) but the base is learned: the grid value with the lowest training-year MAE (onset + peak).
- No effort correction in any baseline (that is P3); all four are on the same footing.

## Go/no-go (from build-plan-v2 P1 step 6)
| Result | Headline |
|---|---|
| (c) beats (a) by ≥ 2 days MAE | "Heat predicts luna moths better than the calendar" |
| (d) beats (c) and sim recovers base within ±1 °C | "The model learned the threshold" |
| (d) ≈ (c) | Fix base at 10 °C, learn μ, σ |
| Nothing beats (a) | "Lunas, replayed", calendar forecast |

"Beats" is judged on the mean of onset and peak MAE, pooled over scored band-years.

## Simulate-and-recover
- Truth: base ∈ {8, 10, 12} °C, μ and σ set to the (c)-style fit at that base, 20 replicates each.
- For every real hex-year with n luna records, draw n fake sightings over days with probability ∝
  φ((DD(t) − μ)/σ) × (Midwest moth records that day), i.e. real temperatures and the real effort pattern.
- Run the (d) fitter. Pass = base recovered within ±1 °C in most replicates.

## Change log
- **2026-10-21, brood-split threshold 50% → 80%.** Looked at the pooled day-of-year curves (no model results yet).
  The 41-43 °N band has an obvious second brood (spring peak ~day 150, summer peak ~day 215, larger because more people look in July),
  but the broods overlap, so the dip only falls to 72% of the spring peak. At 50% that band would be scored as one brood,
  mixing July second-brood moths into the "first brood" peak. 80% splits 37-39 (day 177), 39-41 (180), 41-43 (176), 43-45 (190); 45-49 stays one brood.
  The original 50% rule is still run as a sensitivity check and reported.
- **2026-10-22, bug fixes after review (not choice changes).** (1) Daymet keeps 29 Feb and drops 31 Dec, so its yday is the
  calendar day of year; the code had shifted leap-year sightings by one day. (2) Simulate-and-recover drew days ∝ φ(DD), which is not
  the fitter's own model; it now draws the daily increment of Φ(DD) (the fitter's model exactly), with and without real effort.
- **Known, measured, not fixed:** brood cut-offs are computed from all years pooled, including the held-out year. Recomputing them
  per fold moves cut-offs 0-9 days and changes MAEs by <0.2 d (reviewer check).
