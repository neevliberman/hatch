# Tryout 1: learn from this year's first sightings (2026-10-25). Result: does not earn a bench spot for luna.

**Idea.** A GPS that reroutes as you drive. P3 treats an unseen season as an average year until it is over. Here, on
each forecast's issue date, the year's sightings so far nudge the warmth target (one number per year, in
degree-days, shrunk toward 0 with prior SD tau), and the forecast is rerun.

**Honest replay** (`assim.py`): P3's 11 leave-one-year-out fold fits, the 31 Midwest band-years P3 is scored on, the
scorecard's issue date (real date minus 7 days, onset and peak separately), and only records observed AND posted by
that date. Same real weather in both arms. The u = 0 arm reproduces P3's 3.85 d exactly.

| Mean miss, days | Onset | Peak | Average |
|---|---|---|---|
| P3 (no nudge) | 4.02 | 3.69 | **3.85** |
| nudge, tau 15 DD | 4.18 | 3.44 | 3.81 |
| nudge, tau 30 DD | 4.74 | 3.44 | 4.09 |
| nudge, tau 60 DD | 5.28 | 3.44 | 4.36 |
| nudge, no shrinkage | 7.38 | 4.37 | 5.87 |
| tau 15, straggler share 5 / 10 / 20% (not 1%) | 4.15 / 4.05 / 3.98 | 3.47 / 3.63 / 3.82 | 3.81 / 3.84 / 3.90 |

**Why it fails here.** A week before a strip's onset, almost none of its own first wave has flown (a median of 1
record from that strip, 9 from all strips together), and those few sit on the curve's sharp leading edge, where the
fit is least sure. They pull the nudge too far, so onsets get worse. By a week before the peak more is known (a median of 12 from the strip, 66 in all), and peaks improve
about 0.25 d, which is inside the noise on 31 band-years. Luna's strips are only 1-2 weeks apart, so the south has
not finished when the north is forecast.

**What it does tell us for new regions.** About 40% of P3's error is shared by every strip in a year (2024 ran late
everywhere, 2019 early). Using only strips whose peak was at least 10 days before the issue date and moving the
forecast by half their mean error cuts the average miss from 3.85 to 3.62 d, but only 16 of 62 forecasts had such a
strip. Across the whole East, where Georgia flies two months before Maine, that early-warning signal is available for
almost every northern forecast. It is tested there, in the regional tryout, not here.

Decision: no luna challenger from this tryout. Rules for a bench spot: [README.md](../README.md).
