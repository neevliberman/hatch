# South bias: candidate fixes, rules written before scoring (2026-10-24)

**What had been seen before writing this.** Everything in `pipeline/fit/SOUTH_BIAS.md`, `pipeline/live/DRYRUN_2026.md`
and `pipeline/live/SCORECARD_2026.md`: the 2026 southern strip (37-39 °N) forecast peak was about day 116 against a real
130, the strip banked about 252-255 degree-days by 15 April against 54-144 in 2015-2025, the warmest place-year behind
any fitted record had 197, and a post-hoc half-and-half mix of forecast and usual date would have called day 126. The
middle strip (39-41 °N) was also far past its own past range (198 vs 114) and its forecast was right. No score of any
candidate below had been computed. The candidates were picked *because of* 2026, so **2026 is a second look, not a
test, for every one of them**. Leave-one-year-out (LOYO) and the WI/MN holdout are the less-contaminated checks; 2027
is the only clean one.

## Reference
**P3** as frozen (`p3_photo`), using the stored fold fits (`pipeline/fit/results/loyo_params.json`, identical to
`pipeline/replay/fold_fits.json`) and the stored holdout fit (`headline.json`). No refit.

## The fit's range ("the envelope")
For a fold, the envelope E(t) is, on each day t, the **largest banked degree-days (Daymet, base 10 °C, from 1 March)
at any training place-year**, where a place-year is a hexagon and year with at least one first-brood training record.
It pools all latitudes: the model has no idea which strip a bank balance came from, only how much is in it. (Using
each strip's own past range instead would flag 2026's middle strip, whose forecast was right.)

## Candidates
- **A1 "cap" (no new parameter).** Every hexagon's bank is capped at the envelope: banked(t) = min(real banked(t), E(t)),
  then the model runs as usual. In words: never believe a bank balance richer than the richest one the model has seen
  on that date. Warm side only (the far north in every LOYO fold is inside the range by construction).
- **A2 "flag and half-blend" (one constant, 0.5, fixed here).** A hexagon is *flagged* if its real bank is above
  E(t) on any day from 1 April (day index 90) to the strip's P3 peak day. The strip's onset and peak become
  P3 + w (calendar − P3), with w = 0.5 × the strip's weighted share of flagged hexagons. Calendar = the comparison
  each evaluation already uses (LOYO: the band's training-year mean; holdout: the latitude-slid IL/IN/OH calendar,
  since WI/MN's own dates are not known to the model; 2026: the 2015-2025 strip means, as the scorecard). Flagged
  strips also get their "likely" range widened to reach the calendar date (scored as coverage, secondary).
- **B "P4, daylength gate".** P3 (daylength-weighted degree-days) where a day's warmth counts only once daylength at
  the hexagon is at least L* hours. L* is chosen inside each fold, by the training penalised likelihood, from
  {off, 11.5, 12.0, 12.5, 13.0, 13.5, 14.0} h; the other parameters are refitted at each value (starts: the fold's P3
  fit, the fitter's default start, and the skewed start at α = 10).
- **C "two clocks" (mixture).** A share π of moths follows P3's warmth curve; the rest come out on a calendar clock:
  a normal curve in day of year with mean m0 + b (latitude − 42) and spread s, flying 7 days like the rest. Fitted
  (π, m0, b, s with P3's parameters) by maximum penalised likelihood, same data, effort, weights and year effect
  (the year effect moves the warmth clock only). Starts: the fold's P3 fit with π = 0.9 and π = 0.6.
- **Reference only, not a candidate: "always half"**: P3 and the calendar averaged in every strip-year. It shows what
  unconditional blending costs where nothing is out of range.

## Scores (all from the same code; days)
1. LOYO, all 7 states, the 31 scored band-years of P3: MAE (mean of onset and peak absolute errors), and the same over
   the 37-39 °N band-years. 95% interval of MAE(X) − MAE(P3) by `pipeline/fit/evaluate.bootstrap` (2,000 draws).
2. WI/MN holdout (fit on IL/IN/OH, 8 band-years), MAE.
3. 2026 (PRISM weather, whole season, median over the 11 fold fits, the live strip weights, as `south_bias.py`):
   MAE over the 5 strips and the 37-39 °N strip's error. Second look only.
4. How often A1/A2 change anything in LOYO and the holdout (count of band-years touched).

## What counts as a win (decided now)
A candidate **clearly wins** only if all of these hold:
- LOYO MAE no worse than P3's by more than 0.1 d, and the 95% interval of MAE(X) − MAE(P3) does not lie above 0;
- holdout MAE no worse than P3's by more than 0.25 d;
- 2026: the 37-39 °N error at least 5 days smaller than P3's, and the 5-strip MAE not worse.
Because 2026 is a second look, a clear win still only earns a **shadow run in 2027** (scored by the live scorecard next to
P3, rule frozen before 1 March 2027), not a map change now. If two candidates both clearly win, the one with fewer new
fitted parameters is preferred (A1: 0, A2: 0, B: 1, C: 4).
