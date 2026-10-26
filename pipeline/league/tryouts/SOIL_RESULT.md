# Tryout result: ground warmth instead of air warmth (2026-10-26)

**Short answer: no. Reading the clock from the ground made the forecast worse on average, so it earns no bench spot.** The plan
and the rule ([SOIL_PLAN.md](SOIL_PLAN.md)) were committed before any soil score. Code: [`soil.py`](soil.py);
numbers: `results/soil/`.

| Arm (Midwest leave-one-year-out, 31 band-years in 9 years) | Days off (onset and peak) | vs air | 95% interval, resampling years |
|---|---|---|---|
| **Air, P3 refit (control)** | **3.89** | reproduces P3's 3.85 | |
| S1: ground, base 10 °C | 4.81 | +0.92 | -0.19 to +2.29 |
| S2: ground, base picked per fold (4 °C every time) | 4.69 | +0.81 | -0.32 to +2.27 |
| Ground, base 6 °C (not a candidate, shown for completeness) | 4.53 | +0.65 | -0.27 to +1.89 |
| Calendar (usual date) | 7.31 | | |

The rule needed 0.2 days *better*. Every ground arm is worse on average, so none qualifies. How much worse is uncertain:
resampling whole years (the honest unit, since one year's weather moves every strip together) gives intervals that
include zero. Much of the gap is 2019, when the ground clock put first moths about 13 days early in four strips;
without 2019 the ground arms are still 0.2 to 0.4 days worse. S1 beats air in 10 of 31 band-years (S2 8, base 6 °C 9).
(`soil.py`'s own interval in `loyo.json` resamples band-years and is narrower; the year intervals above are computed
from `loyo_rows.csv`.)

**Two caveats.**
- S2 picked 4 °C, the lowest base in the grid, in every fold, and its fit kept improving as the base dropped, so a
  lower base was never tried. With 4 °C the ground fits the sightings better than air does (training negative
  log-likelihood about 35 to 70 lower in every fold), yet dates them worse: the same trap P4 found with its "two clocks"
  model. With 10 °C the ground fits worse too (about 60 to 110 higher).
- The plan's other two checks (the WI/MN holdout and 2026) were not run, because the main test had already failed.

**Why it might lose, in plain words.** ERA5-Land's ground is a 9 km average of bare soil, not the leaf litter a cocoon
sits in, and Daymet's air is a 1 km grid. Litter in the open may track the air more closely than the soil beneath it.
That is a guess, not something this test shows. P4's "leaf-litter smoothing" stand-in also lost (5.08 days). Whatever
the moths feel, the air thermometer predicts them better here.

**Other data checked (no tryout possible).** USA-NPN's luna yes/no surveys: 25,808 status rows from 2017 to 2026, but
only 63 are "yes" (any stage, all states). Usable first-adult dates come from one Indiana site in a few years. That is
far too thin to train on or to test "when moths fly" against "when people find them". It can be rechecked once a
few more Midwest sites report.

**What it changes.** Nothing on the map or the bench. The result goes in the league README's tryout list. Open-Meteo's
archive is reachable from here now (it was blocked before), which helps future tryouts and new regions.
