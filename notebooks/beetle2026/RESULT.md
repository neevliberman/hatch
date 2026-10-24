# Why the Japanese beetle forecast lost to the usual date in 2026 (exploratory, 2026-10-24)

**Nothing is refit.** The frozen model (`japanese-beetle-v0`, fits hash `8c8449d6de38`) is only read. Inputs: the
2026 rehearsal archive (`pipeline/live/archive/japanese-beetle/2026/`), `public/live/scorecard.json`, the beetle
replay, the 2026 live file, and 3,687 research-grade 2026 records fetched on 24 Oct 2026 (2,746 first-wave after the
scorecard's filters). `run.py` reproduces everything below into `results/summary.json`.

## Short answer
- **The scorecard reproduces exactly** from today's records: 3.5 days off for the forecast against 2.4 for the usual
  date, every strip the same as published.
- **The 1.1-day gap is not significant.** Resampling the records inside each strip (4,000 times) gives a 95% interval
  of -0.6 to +3.1 days (the forecast is worse in 89% of resamples). Over the 10 dates: 95% interval -0.2 to +2.8,
  exact sign-flip p = 0.22. Over the 5 strips: -0.5 to +2.9, p = 0.44.
- **One strip makes most of it.** Without 37-39 °N the gap is +0.3 days (strip gaps: +4.4, -0.7, +2.2, -0.6, +0.1).
- **Losing a year is normal for this model.** In the leave-one-year-out backtest the usual date won 3 of 10 scored
  years (2020 by 1.1 days, 2022 by 0.8, 2025 by 1.3). 2026's 1.1 is the same size. The year-to-year gap has a
  standard deviation of 1.65 days. The backtest overall still favours the forecast (2.85 against 3.81 days), and so
  does the WI/MN holdout (3.38 against 4.30).
- **2026 was an easy year for the usual date.** It was off by 2.4 days, against 3.8 in a typical backtest year: the
  beetle came out close to its average date everywhere. The forecast was off by 3.5, against 2.85 typical: a bit worse
  than usual, not broken.

## Why it lost
1. **It ran early everywhere.** All 10 graded dates were early or on time (onset -12, -5, -5, -1, -1; peak -5, -1,
   -3, -2, 0 days, south to north). The usual date was mostly late, by up to 5 days (9 of 10 dates), so 2026 beetles were
   only slightly early, and the forecast overshot.
2. **The far south (37-39 °N) is a known weak spot, not a 2026 surprise.** In the backtest that strip already ran
   early (onset -6.6, peak -2.4 days on average over 7 strip-years) and was the only strip where the usual date beat
   the forecast (4.7 against 5.5; it is in the app's fine print). In 2026 it was onset -12, peak -5.
3. **The early start is mostly the stretched season.** The model assumes a one-week adult life (built for moths) and
   makes up for the beetle's weeks-long life by spreading the season out. In the south that puts the forecast onset
   23 days before its peak; real 2026 beetles took 16 (39-41 °N: 22 against 16). Further north the spans match
   (17-18 against 18-19) and the misses are small.
4. **The warm spring pulled the southern forecast a few days earlier still.** The 37-39 °N peak forecast was day 182
   in March and slid to 177-178 by late April as 2026's warm spring banked degree-days early; it stayed there. The
   real peak was day 183, and the usual date 186.5. This is the same warm-spring lean the luna and firefly showed at
   their southern strips (`pipeline/fit/SOUTH_BIAS.md`, `pipeline/live/SCORECARD_2026.md`).
5. **Not lead time.** The last forecast, with all of 2026's real weather (as of 25 Sep), has the same errors to
   within a day (37-39 °N onset -12, peak -5).
6. **Not range or where people looked.** 2026 records sat in the same hexagons the strip forecasts are weighted by:
   under 1% in hexagons with no past sighting in the middle strips, 11.5% at 37-39 °N and 4% at 45-49 °N. Weighting
   each strip's hexagon medians by 2026's records instead of 2015-2025's moves them by 0.5 days or less, except +1.2
   at 45-49 °N (which would make that strip slightly later, not earlier). The mean latitude of records moved by at
   most 0.12 degrees.

## What this means for the app
Keep the forecast. One losing season, by a gap this noisy and driven by a strip already flagged, is weak evidence
against a model that wins its backtest and holdout. But the app should not say "closer than the usual date" without
saying it lost in 2026. The "How sure?" card now carries one generated line per species, for example:

> Mixed record so far: beat the usual date on past years and in two states it never learned from, but not in 2026
> (3.5 days off against 2.4; one season, 5 strips).

Fixing the early lean (a beetle-specific season length, or capping the degree-day bank as tried for luna in
`notebooks/southbias/`) is model work for a later, preregistered version, not for the frozen 2026-27 model.
