# P3 result: the fit (2026-10-22)

**Verdict.**
- **Beats the calendar: yes, clearly.** The P3 model calls luna onset and peak about 3.9 days off on average, against 7.3 days for the calendar (2.8 days better, 95% CI 1.0 to 4.7). Each year was guessed without seeing that year's moths.
- **Beats the old map model (P1): no, it ties.** P1's model scores 4.05 days. The 0.2-day difference is noise (CI −0.6 to +1.0).
- **South-early / north-late bias: mostly fixed.** The P2 map's peak ran 6.1 days early at 37-39 °N and 3.9 days late at 45-49 °N. P3 runs 0.5 and 1.2 days late there. It does lean 2-3 days late in the middle bands.
- **Latitude / daylength term: does not help.** The same model *without* it scores 3.81 days, as good as with it. The bias fix comes from the rest of the model, not from that term.
- **Spatial holdout (learn IL/IN/OH, guess WI/MN): FAILED** for the model chosen in advance. It scored 7.4 days. P1's model scored 6.3 and Wisconsin/Minnesota's own calendar 6.9. It did beat the "slide the southern calendar north" baseline (10.7 days).

Rules were written down before scoring: [FROZEN_P3.md](FROZEN_P3.md). How the model works: [README.md](README.md).

## The numbers

**Leave-one-year-out, all 7 states** (31 latitude band-years, ≥ 20 records each):

| Model | Onset error | Peak error | Average | vs P3 (95% CI) |
|---|---|---|---|---|
| Calendar for that band | 7.9 d | 6.7 d | 7.3 d | P3 better by 2.8 (1.0 to 4.7) |
| P1 model (what the map showed) | 3.9 d | 4.2 d | 4.05 d | P3 better by 0.2 (−0.6 to +1.0): a tie |
| **P3 (daylength version, the pre-registered pick)** | **4.0 d** | **3.7 d** | **3.85 d** | |
| P3 without the latitude/daylength term | 3.8 d | 3.9 d | 3.81 d | a tie (−0.3 to +0.2) |
| P3 with a bell curve instead of the skewed one | 6.7 d | 3.9 d | 5.3 d | P3 better by 1.3 (0.2 to 2.4) |

**Noise floor: about 3.0 d.** Each target is itself only known to about ±3.4 days (fewer than 200 records per band-year). So a *perfect* forecaster would still score about 3.0 days, and P3 sits about 0.8 days above that.

**Spatial holdout** (fit on IL/IN/OH only; 8 WI/MN band-years, 7 of them at 45-49 °N; noise floor 2.3 d):

| Model | Onset | Peak | Average |
|---|---|---|---|
| **P3 (daylength, the pre-registered pick)** | 4.6 d | **10.2 d** | **7.4 d: fails** |
| P1 model | 5.3 d | 7.2 d | 6.3 d |
| WI/MN's own calendar (uses local data the models never saw) | 6.9 d | 7.0 d | 6.9 d |
| IL/IN/OH calendar slid north by latitude | 12.0 d | 9.4 d | 10.7 d |
| *P3 without the latitude/daylength term (not the pick)* | 6.1 d | 4.2 d | *5.1 d* |

**Bias by band** (mean forecast − real peak, days; below 0 = too early):

| Band | 37-39 °N | 39-41 | 41-43 | 43-45 | 45-49 °N |
|---|---|---|---|---|---|
| P1 / P2 map | −6.1 | −3.4 | −0.6 | +1.7 | +3.9 |
| P3 | +0.5 | +1.8 | +2.2 | +3.0 | +1.2 |

![bias](figures/bias_by_band.png)
![predicted vs real](figures/predicted_vs_real.png)

## What it means
- **Picture a bank account.** From 1 March, each warm day pays in degree-days, and each moth has its own savings target. The targets sit on a lopsided curve: nobody comes out before about 70 degree-days, half are out by about 220, and a long tail needs more. (In the daylength version these are daylength-weighted degree-days, within about 10-15% of plain ones in May-June.) Making the curve lopsided matters: a symmetric bell curve is 1.3 days worse.
- **Why the south/north bias shrank.** P1 assumed a moth is seen *at* its target. P3 adds three things:
  - an adult then flies for a week;
  - people log moths unevenly (weekends, Moth Week, the summer rise in moth-lighting), so the effort background is built in;
  - the first-brood window ends at a cut-off.

  In the hot south a week of flying banks far more warmth than in the north. That is the likely reason southern sightings "show" more saved-up warmth. The model without any latitude term shrinks the bias too (−1.1 d south, +2.8 d north), so the moths don't seem to need different targets.
- **Daylength / latitude.** The daylength version won the pre-registered choice on IL/IN/OH by a hair, in likelihood terms. It doesn't forecast dates any better than leaving the term out. Fitted on IL/IN/OH alone, its daylength effect flips sign (γ = −1.9, against +0.66 in the all-states fit). Carried north into Minnesota, that pushed the peak about 10 days late. That is why the holdout failed. Like a ruler calibrated on three states, it bends when you carry it north.
- **Two runs, both reported.** Run 1 (as pre-registered) found a poor local optimum in some fits. Fixing the optimiser changed the result to the one shown here (the change log has details). Run 1 scored 4.27 d leave-one-year-out and 9.8 d in the holdout. The fix came after seeing run 1, so treat run 2's holdout as a second look, not a first.
- **The map** now uses P3's leave-one-year-out forecast. Each year comes from a fit that never saw it. Each hex shows when its expected *sightings* happen, the quantity that was scored. Without the effort shape and the cut-off, the hidden "moths flying" curve runs up to two weeks earlier in the south, and nothing in the data can check it. It also carries an 80% band from past errors: peak −6 to +4 days, onset −5 to +6.

## What's still unproven
- **A season the model has never seen.** 2026 is the real test, once Daymet 2026 is out (around mid-2027).
- **Whether the effort background is fair.** "All moths logged that day" also rises with moth *abundance* in July, not just with observers. The fit without effort scores about the same (3.96 d leave-one-year-out).
- **The north.** The holdout has only 8 band-years, almost all from 45-49 °N. The no-term model did well there (5.1 d), but it was not the pick, so that is a hint, not a result.
- **Deferred:**
  - air vs soil warmth (needs ERA5-Land via Open-Meteo, blocked here);
  - a night-only, per-hex effort background (the histogram endpoint can't do it);
  - research grade + needs-ID;
  - urban vs rural.
- **Recommendation for P4:** drop the latitude/daylength term (simpler, ties on leave-one-year-out, did better in the holdout), and re-confirm on 2026.

## Parameter intervals (bootstrap refits, 60 over years and 60 over observers)
- Median warmth target: about 220 degree-days (95%: 200-238 resampling years, 185-252 resampling observers).
- Daylength exponent γ: 0.55 (−0.42 to 0.93 over years; −0.94 to 1.37 over observers). It is consistent with zero.
- 11 of 120 refits went to a degenerate fit and are left out of those ranges. They are kept in `results/bootstrap_refits.csv`. (Note that `headline.json` `param_intervals` still includes them, so its ranges differ from these.) Review found what they are: the curve's location parameter stuck at its −500 bound with a median target near −225 degree-days. Nothing in the likelihood keeps targets above zero, because the curve is renormalised per place-year. All 11 have γ < 0, so leaving them out is not neutral. Fix for P4: bound targets at ≥ 0 (or condition the curve on target > 0) and refit.
- `headline.json` `mae_ci` (resampling observers) does not contain the point estimates, because resampling also adds noise to the targets. Don't quote it. Use the CIs in the tables above.
- Two places where held-out data touches the method, both small: (1) the daylength-vs-latitude choice used IL/IN/OH likelihoods from all 11 years, so the LOYO score of the chosen model isn't strictly nested (3.86 vs 3.85 d either way). (2) In the holdout, the WI/MN brood cut-offs, hex weights and effort shape come from WI/MN's other years (for P1 too). "Never sees a WI/MN record" holds for fitting only.
