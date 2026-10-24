# Fixing the 2026 far-south miss: what works and what doesn't (exploratory, 2026-10-24)

**This is exploratory.** The rules were written down and committed before any score was computed
([PREREG.md](PREREG.md), first commit on this branch). But every candidate was picked *because of* 2026, so 2026 is a
second look, not a test. Leave-one-year-out (LOYO) on 2015-2025 and the WI/MN holdout are the fairer checks here;
2027 will be the clean test. **Nothing on the map or in the app changes.**

## The problem, in one paragraph
The model is a **warmth bank account**: from 1 March each day pays in its degree-days, and moths come out when the
balance reaches their savings target. In spring 2026 the far south (37-39 °N) banked about 255 degree-days by
15 April. The richest account behind any record the model learned from had 197; the strip's own warmest past spring
had 144. The model assumed every extra degree-day brings the moths out in proportion, and forecast the peak for
26 April (day 116). The real peak was 10 May (day 130). It is like teaching someone to read a speedometer from 0 to
60 mph and asking them what happens at 100.

## Short answer
- **No candidate clearly wins by the rules written beforehand.** So no map change is proposed.
- **The best one is A1, "cap the bank"**: never believe a balance richer than the richest one the model has ever
  seen on that date. It **changed no past date**: no onset or peak in LOYO or the holdout moved by 0.01 day or more.
  (The cap does bind on some banks in past years, the southern ones in 2024 and 2025, but too little to move a whole
  day.) In 2026 it moves the southern peak from day 116 to day 120: the strip's miss falls from 7.7 to 5.3 days (the
  rule needed 5 days of improvement; it gives 2.4), and the 5-strip 2026 average from 4.9 to 4.5.
- **Widening the "likely" range toward the usual date when the bank is out of range** (the interval part of A2)
  would have caught the real 2026 southern peak. Around A1's forecast the southern peak range is about 114-124;
  widened, it reaches the usual date, 135 (around P3's forecast it was 110-120, widened 110-135). What it costs is
  unknown: in past years the flag fired in only 2 of 31 band-years and widened just 1 of 62 ranges (the 2024 southern
  peak, top end 130.5 → 138.1, still a miss because that peak came early, at 117), so past years can't tell. In 2026 it
  also widened the middle strip (39-41 °N): onset 96.9-108 → 96.9-118.4 (10 days), peak 127-137 → 127-142.9 (6 days).
  The range itself (forecast + the 10th to 90th percentile of the other years' LOYO misses) was chosen when scoring,
  not in PREREG.md.
- **Blending the forecast date halfway toward the calendar (A2)** fixes the south more (peak 125.5, miss 4.8) but
  wrecks the middle strip, which was also past the range and was forecast right (miss 2.5 → 6.3). Net 2026 average
  is worse (5.1 vs 4.9). Rejected.
- **P4, the daylength gate (B), is rejected by the data.** In all 11 LOYO folds the training data preferred *no*
  gate (every gate from 11.5 to 14 hours fitted worse). In the holdout it picked a 12-hour gate and did worse there
  (7.9 vs 7.4 days). It does not move the 2026 south at all.
- **"Two clocks" (C), a mix of warmth-driven and calendar-driven moths, fits the sightings much better but forecasts
  worse.** It says only about 38% of moths follow warmth. Its log-likelihood beats P3 by 96-139 points in every LOYO fold
  (lowest 2021) and by 57 in the holdout,
  but its dates are worse on past years (5.0 vs 3.9 days) and terrible in the holdout (16 vs 7.4), because its
  calendar clock learned in Illinois-Ohio does not slide north properly. In the south it predicts a peak around day of year
  134-138 in every past year and 139 in 2026, i.e. it has become a calendar there. Interesting as a hint, not usable.

## The numbers
Days off, averaging the onset (10% day) and peak (median day) misses. LOYO = 31 band-years (5 of them at 37-39 °N);
holdout = 8 WI/MN band-years from a fit on IL/IN/OH; 2026 = the 5 strips, PRISM weather for the whole season, median of
the 11 fold fits, as `pipeline/fit/south_bias.py`. Interval = 95% bootstrap interval of LOYO MAE(X) − MAE(P3).

| | LOYO all | LOYO − P3 (95%) | LOYO 37-39 | WI/MN holdout | 2026 all 5 | 2026 37-39 | 2026 37-39 peak (real 130) |
|---|---|---|---|---|---|---|---|
| **P3** (map today) | 3.85 | – | 4.13 | 7.38 | 4.93 | 7.7 | 116 |
| **A1** cap the bank | 3.85 | 0.00 (0 to 0) | 4.13 | 7.38 | **4.45** | 5.3 | 120 |
| **A2** flag + half-blend | 3.87 | +0.02 (−0.01 to 0.06) | 4.23 | 7.38 | 5.11 | 4.8 | 125.5 |
| **B** P4 daylength gate | 3.87 | +0.02 (−0.05 to 0.10) | 4.13 | 7.94 | 4.83 | 7.7 | 116 |
| **C** two clocks | 5.02 | +1.17 (−0.14 to 2.02) | 6.63 | 16.04 | 4.65 | 4.8 | 139 |
| *always half-blend (reference)* | 5.23 | +1.38 (−0.01 to 2.01) | 6.22 | 8.51 | 5.29 | 4.8 | 125.5 |
| *calendar* | 7.31 | +3.46 (0.96 to 4.74) | 8.31 | 10.71* | 7.86 | 8.2 | 135 |

\*Holdout calendar = the Illinois-Ohio calendar slid north by latitude (the one the blend may use there).

2026 by strip (days off): P3 7.7 / 2.5 / 2.9 / 6.5 / 5.0 from south to north; A1 5.3 / 2.5 / 2.9 / 6.5 / 5.0 (only
the south moves); A2 4.8 / **6.3** / 2.9 / 6.5 / 5.0.

How often each rule moves a date (by 0.01 day or more): A1 0 of 31 LOYO and 0 of 8 holdout band-years; A2 2 of 31 (the south in 2024 and
2025, weight 0.08 each: 2024 got 0.7 days worse, 2025 0.2 better) and 0 of 8; B 4 of 31 (refit noise, the gate was never picked)
and 8 of 8; C everything.

Against the pre-registered win rule (LOYO no worse by 0.1, holdout no worse by 0.25, 2026 south better by 5 days and
2026 overall not worse): A1 passes everything but the 5 days (2.4); A2 fails the 5 days (2.9) and 2026 overall; B
fails the holdout and the 2026 south (0); C fails LOYO, the holdout and the 5 days (2.9).

## What it means, in plain words
- **The cap is a seatbelt, not an engine.** It does nothing in an ordinary spring, which is why past years can't vouch
  for it either way: they only show it costs nothing. In 2026 it helps, but only by 4 days on the peak, because even the
  richest account the model had seen reached the target by late April. The moths waited longer than *anything* in
  the record would predict. None of the warmth-only rules tried here (cap, gate) gets the south near day 130.
- **"Out of range" has to mean out of the model's range, not out of this place's range.** The middle strip (39-41 °N)
  had a spring far warmer than its own past (198 vs 114 degree-days by 15 April), yet the southern strips had been
  that warm before, so the model knew what to do and got it right. Any flag that fires on "unusual for here" would
  have broken the strip that worked. The pooled envelope (any place, any fitted year) is the better of the two
  yardsticks, picked knowing 2026, and even that flags part of the middle strip (29% of its weight), which is why moving the *date* toward the calendar
  hurts there while widening the *range* does not.
- **The daylength gate idea doesn't survive contact with past years.** If moths ignored warmth before some daylength,
  the fit would have preferred a gate in at least some folds. It never did (the previous diagnosis found the same
  thing another way: counting heat from later dates makes past years less alike, not more).
- **Two clocks: the likelihood says "yes, something calendar-like is going on", the dates say "not like this".** It
  explains the scatter of single sightings better, but that does not put the onset and peak dates in the right place. Worth
  keeping in mind as seasons accumulate; not a fix now.

## Proposed (not implemented) for 2027
**This is a post-hoc choice outside the pre-registered rule.** PREREG.md promised a shadow run only to a clear winner,
and there is none; "A1's point forecast plus A2's widening, without A2's blend" was never a pre-registered candidate.
Its pieces come from PREREG.md (the envelope, the 1 April window, A2's widening), but the combination and the
interval method were chosen after seeing the scores. With that said: run it as a **shadow** next to P3 in the live
pipeline, scored by the existing scorecard, with these rules frozen before 1 March 2027:
1. **A1 cap**: each hexagon's banked degree-days are capped at E(t), the largest balance on that day at any
   training place-year (hexagon-year with a first-brood record) of that fold fit. Ship E(t) next to `fold_fits.json`
   (11 arrays of 365 numbers). The forecast then runs unchanged.
2. **Flag and widen, don't move**: if a hexagon's real bank is above E(t) on any day from 1 April to its strip's
   forecast peak, say so on the card ("warmer than any spring the model learned from") and stretch that strip's
   "likely" range to reach the usual date. The point forecast stays A1's.
3. **Name the weather sources.** The envelope is built from **Daymet** (the fit's weather); the live bank it is
   compared with is **PRISM** as the live job reads it (`pipeline/live/sources.py`, with the Daymet offsets). The
   frozen rule must say so, since the two differ by a little.
The map keeps P3 unless the shadow beats it on the 2027 scorecard. One warm southern spring is not enough to move the
map; this setup means the next one will be a real test.

## Caveats
- 2026 was seen before any of this was designed. A1's 2026 gain is a post-hoc observation, as is the widening catch.
- The 2026 scores use PRISM, the fit uses Daymet (PRISM runs about 1.5 days early in the south), and 2026 records
  are still arriving. The southern 2026 strip has 65 records; its real peak could be anywhere from about day 116 to
  136 by resampling observers (SOUTH_BIAS.md).
- The 2026 numbers are whole-season forecasts, not the week-by-week as-issued forecasts the scorecard grades
  (5.6 vs 8.2 days there). The cap and the flag only use weather up to the issue date, so they can run live, but that
  was not rehearsed here.
- 5 southern band-years in LOYO is very few. Two of them (2024, 2025) were slightly out of range on part of the strip
  (A2 flagged about 16% and 15% of their record-weighted LOYO weight), none by anything like 2026's margin, so LOYO says little about how any rule
  handles a far out-of-range spring.
- **Weather mismatch.** In 2026 the cap and flag compare PRISM banks against a Daymet envelope. In the south the margin
  is wide (strip average 254.5 degree-days by 15 April against 197 at the richest training place-year), but the
  middle strip's 29% flagged share could partly be a data-source effect. A quick check: flagging 2023-2025 (live strip
  weights, each year against the envelope of the fold that left it out) on PRISM and on Daymet (`prism_flag.py`). The middle strip and
  everything north of it was never flagged on either source. The south was flagged on 14% / 6% of its weight in
  2024 / 2025 on Daymet and 1% / 17% on PRISM, and 0% in 2023 on both. So PRISM does not fire more often in
  general, but it moves which years fire; one year of 29% in the middle strip is not explained by it, nor ruled out.
  These shares use the live strip weights, so they differ from the record-weighted LOYO shares above. The
  Daymet-to-PRISM offsets are averages over 2015-2025, which includes 2023-2025, so this check is calibrated in-sample
  and slightly optimistic.
- The gate grid was limited to 11.5-14 hours; the mixture had one fixed form (normal calendar clock, linear in
  latitude). Other forms were not tried.

## Reproduce
```
python3 -m pytest notebooks/southbias          # 7 small tests, no network, a few seconds
python3 notebooks/southbias/run.py             # refits B and C in 12 folds (~1.5-2 h on 4 cores, cached), then scores
```
Inputs are the cached files `south_bias.py` uses (`notebooks/data/`, gitignored: Daymet, PRISM 2026, the iNat pulls,
the effort background). Outputs: `results/summary.json` (everything above, plus fitted gates and mixture parameters),
`results/loyo_rows.csv`, `results/holdout_rows.csv`, `results/rows_2026.csv`. P3's stored LOYO predictions are
reproduced exactly (max difference 0 days) as a check, and so is its holdout score (7.38 days, as `headline.json`).
