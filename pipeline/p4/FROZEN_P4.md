# P4 model search: frozen choices (written 2026-10-24, before any P4 score was computed)

Neev asked: "Is our model as good as it gets? Can we beef it up as much as possible before adding more insects?"
Same rule as P1 and P3: write the candidates and the decision rule down first, then look. Anything changed after
scoring goes in the change log at the bottom, with both results kept.

**What had been seen before writing this.**
- Everything in P3/P3.1 ([../fit/RESULT.md](../fit/RESULT.md)), the 2026 dry run, the south-strip note
  ([../fit/SOUTH_BIAS.md](../fit/SOUTH_BIAS.md)) and the pooled-moth research (PR #54).
- One free look at P3's existing leave-one-year-out rows: averaging P3's and P1's dates scores 3.73 d against P3's
  3.85 (`results/loyo_rows.csv`). That is why "P3 + P1 average" is a candidate, and it is flagged as seen.
- Record counts only (no dates looked at): about 55,600 research-grade luna records 2015-2025 across North America,
  against 5,100 in the seven Midwest states. 28-31 °N: about 5,400; 31-49 °N: about 50,000.
- The P3 noise floor is about 3.0 d and P3 scores 3.85 d, so on the Midwest past-years test **no model can gain
  more than about 0.85 d**. That limits what this search can show there; the other tests below matter as much.

## The headline test (unchanged from P3, so numbers compare directly)
- **Midwest leave-one-year-out:** the same 31 Midwest band-years, targets, brood cut-off rule, hex weights and
  metric (mean of onset and peak absolute error, days) as P3. Every candidate is refit per fold without the held-out
  year, from *any* region it trains on.
- Ranked against **P3 (p3_photo) refit in this harness** (must reproduce 3.85 ± 0.05 d, else the harness is wrong
  and gets fixed before anything else is scored).

## Supporting tests
1. **Eastern leave-one-year-out:** for models trained on the wider region, the same score over every
   region-cell-year outside the Midwest (2° latitude band × 6° longitude sector, ≥ 20 first-brood records). Far
   more band-years, so far more power; it shows whether a gain is real or Midwest luck.
2. **Spatial holdout:** fit without WI/MN (and, for wide models, without anything north of 43 °N in 85-98 °W),
   predict WI/MN band-years, as P3.
3. **Warm-spring stress test:** eastern region-cell-years whose degree-days by 15 April are above the
   warmest Midwest fitted spring for their band (the 2026-south situation, but from past years). Scored LOYO.
4. **2026 season (Midwest, PRISM weather):** a second look only. 2026's southern strip miss is already known.

## Candidates
Same core as P3 (skew-normal warmth targets, 7-day flight life, effort background, observer weights, shrunk year
effect, 1% contamination) unless stated.

| Id | What changes | The idea, plainly |
|---|---|---|
| C0 | Nothing: P3 refit in this harness | the control |
| C1 | Train on eastern North America (31-49 °N, region below), with an effort background on a 2° × 4° grid instead of per state | ten times the moths, and springs as warm as 2026's south, every year |
| C1s | C1's model but state effort, Midwest-only training, grid effort | is any gain from the finer effort map alone? |
| C2 | C1 + latitude slide on the target (local adaptation) | southern moths may be wired differently |
| C3 | C1 + daylength gate: each day's warmth counts × a smooth step that turns on as daylength passes a fitted threshold | moths don't "start the clock" until days are long enough |
| C4 | C1 + leaf-litter warmth: degree-days from temperatures smoothed with a fitted time constant (0, 2, 4, 7, 14 days, chosen by training likelihood) | pupae sit in leaf litter, which warms more slowly than the air |
| C5 | C1 + fitted development thresholds: base 6/8/10/12 °C and upper cap 24/27/30/33 °C (grid, chosen by training likelihood) | maybe 10 °C/30 °C is not the moth's real dial |
| C6 | C1 + winter term: the target slides with that place's Dec-Feb warmth (chill) anomaly | a mild winter can change how much spring warmth a pupa needs |
| C7 | C1 + two clocks: a fitted share of moths follows warmth, the rest a date (normal in day of year, sliding with latitude) | the 2026 south: a third came early with the heat, most waited |
| C8 | Average of the best of C1-C7 (by headline score) and P1's dates; also P3 + P1 | ensembles usually beat their parts |
| C9 | Gradient-boosted trees (LightGBM) on band-year weather features (degree-days banked by fixed dates, latitude, daylength, winter warmth), trained on eastern region-cell-years, LOYO | "would a machine-learning model do better?" |

C1's region: 31-49 °N, 60-100 °W (luna's range minus Florida and the Gulf coast, where the first flight is in
February, before the 1 March window). Records outside the Midwest keep P1's filters. Brood cut-offs: P1's rule, but
the search window for the dip slides with latitude (the dip between broods comes earlier in the south); written as
code in `wide.py` before any score.

## Decision rule (what ships to the live map)
A candidate replaces P3 only if **all** of these hold:
1. **Headline:** lower Midwest LOYO MAE than C0 by at least 0.2 d.
2. **Not luck:** on eastern LOYO, it is at least as good as C1 (for C2-C7) or as good as C0 transferred (for C1).
3. **No new failure:** spatial holdout and warm-spring test no worse than C0 by more than 0.5 d.
4. **2026 second look:** no worse than C0 by more than 0.5 d (sighting-weighted strip miss).
If several pass, the lowest headline score wins; ties within 0.1 d go to the simpler model. If none passes, P3 stays
and the write-up says so plainly. With ~10 candidates, the winner's headline gain is optimistic (we picked the best
of many); the eastern and 2026 tests are there to catch that.

## Change log
- **2026-10-24, before any score: winter term uses January-February, not December-February.** The cached Daymet
  starts on 1 Jan 2015, so December 2014 is missing. The term is that place-year's Jan-Feb mean temperature minus
  the place's 2015-2025 average.
- **2026-10-24, before any score: leaf-litter warmth (C4) smooths daily lows and highs separately** with the same
  exponential time constant, then takes double-sine degree-days as usual.
- **2026-10-24, after C0 reproduced P3 (3.90 with P3's own optimiser, 3.86 with exact gradients): Midwest-only
  versions of C2-C7 added** (`m2`..`m7`), reported only, never decision candidates. They answer "does the idea help
  without more data?"
- **2026-10-24, after seeing the Midwest-only round: adult flight life chosen by training likelihood
  (4/7/10/14/21 days)** added as exploratory variants `m8` (Midwest) and `c8l` (wide). Reason: the two ideas that
  most improved the training likelihood (litter smoothing, two clocks) made dates clearly worse, which suggests the
  likelihood is chasing the *shape* of each season (a long tail of late records) rather than its *timing*. A longer
  flight life is a shape-only change. It was thought of after seeing scores, so it can be reported but not shipped
  on the headline alone.
- **2026-10-24, before any wide score:** 68 of 1,513 eastern hexes (centres over the Atlantic or Long Island Sound)
  have no Daymet pixel; their records are dropped.
- **2026-10-24 (Neev's standing rules, relayed):** Sonnet and Haiku wherever possible, work paced rather than fanned
  out, one reviewer for small PRs. No effect on the scores.
- **2026-10-24, after the first wide score (c1 v1: Midwest 6.24, East 7.66 vs East calendar 6.51): brood cut-off v2.**
  v1 computed the cut-off per 2 x 6 degree cell; one cell (39-41 N, 82-76 W, 1,978 records) got no dip, fell back to
  day 240, and its "first-brood" targets were really the second brood (peak ~day 180, mean forecast error -25 days).
  v2 pools all longitudes of a 2-degree latitude band, as the Midwest bands do. This is a harness bug fix, not a model
  change. v1 results are kept in `results/v1_cutoff/`.
- **2026-10-24, after wide c1/c2/c6 (v2 cut-offs): P3.1's bounds added as the `p` variants (c1p, c2p, ...).** The wide
  fits (c2, 2020 fold) sat at mu0 = -500 with a very wide curve, the degenerate basin P3.1 documented (mu0 >= 0 and
  alpha >= 0 keep the fit out of it). The southern cells (31-35 N, several broods) pull the fit there. Unbounded
  results are kept; `p` variants are the ones the decision rule is applied to, since the bounds are P3.1's, fixed in
  advance for exactly this failure.
