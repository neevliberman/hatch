# Tryout result: ground warmth instead of air warmth (2026-10-26)

**Short answer: no. Reading the clock from the ground made the forecast worse, so it earns no bench spot.** The plan
and the rule ([SOIL_PLAN.md](SOIL_PLAN.md)) were committed before any soil score. Code: [`soil.py`](soil.py);
numbers: `results/soil/`.

| Arm (Midwest leave-one-year-out, 31 band-years) | Days off (onset and peak) | vs air |
|---|---|---|
| **Air, P3 refit (control)** | **3.89** | reproduces P3's 3.85 |
| S1: ground, base 10 °C | 4.81 | +0.92 (95% CI +0.09 to +1.83) |
| S2: ground, base picked per fold (picked 4 °C every time) | 4.69 | +0.81 (CI -0.14 to +1.71) |
| Ground, base 6 °C (not a candidate, shown for completeness) | 4.53 | +0.65 |
| Calendar (usual date) | 7.31 | |

The rule needed 0.2 days *better*; every ground arm is clearly worse. S1 puts first moths about 5 days too early on
average (air: 0.3 days), so the ground clock shifts the timing instead of sharpening it. The best ground arm won only 9
of 31 band-years.

**Why it might lose, in plain words.** ERA5-Land's ground is a 9 km average of bare soil, not the leaf litter a cocoon
sits in, and Daymet's air is a 1 km grid. Litter in the open may track the air more closely than the soil beneath it.
P4's "leaf-litter smoothing" stand-in lost for the same reason (5.08 days). Whatever the moths feel, the air
thermometer predicts them better.

**Other data checked (no tryout possible).** USA-NPN's luna yes/no surveys: 25,808 status rows from 2017 to 2026, but
only 63 are "yes" (any stage, all states). Usable first-adult dates come from one Indiana site in a few years. That is
far too thin to train on or to test "when moths fly" against "when people find them". It can be rechecked once a
few more Midwest sites report.

**What it changes.** Nothing on the map or the bench. The result goes in the league README's tryout list. Open-Meteo's
archive is reachable from here now (it was blocked before), which helps future tryouts and new regions.
