# Tryout 2: forecasting new regions (2026-10-25)

**Result.** The pre-registered pooled model (R1, [REGIONAL_PLAN.md](REGIONAL_PLAN.md)) fails its bar. A simpler idea
found afterwards, a **local heat clock**, beats the local calendar across the East by about 1.5 days. Because it was
found after seeing R1's result, it is a lead to test on 2027, not a proven model.

Data: 32,926 first-brood luna records, 2015-2025, 31-49 °N, 1,813 hexes, 52 regions (2° × 6° cells). Scores are the
mean miss in days of onset (10th percentile) and peak (median), on cell-years with at least 20 records.

## Test 1: leave one year out

| Mean miss, days | East (215 cell-years) | Midwest (31 strip-years) |
|---|---|---|
| Local calendar (each place's average dates) | 6.27 | 7.31 |
| One warmth curve for everything (P4) | 7.15 | 5.63 |
| R1: one curve, each region shifted (pooled) | 6.64 | 6.01 |
| **Local heat clock** (exploratory) | **4.73** | 4.04 |
| P3 on the Midwest alone, for reference | | 3.85 |

- R1 beats the single curve in the East (interval of the difference −0.88 to −0.07 d) but not the calendar
  (−0.75 to +1.33 d). Bar not met. Its region spread hit the pre-set cap (200 degree-days) in every fold, and it is
  still 7 days late at 31 °N and 6 days early at 45-47 °N: one shared curve shape does not fit Georgia and Maine.
- The clock beats the calendar in the East by 1.54 d (interval −2.76 to −0.68 d) and wins in 25 of 29 cells, at every
  latitude except 39-41 °N. It is about 1 day late on average everywhere (no latitude trend).
- Test 3 (south-to-north early warning, k = 0.5): R1 6.64 → 6.55, clock 4.73 → 4.73, Midwest clock 4.04 → 4.05.
  Once a place's own weather is in the forecast, the South's miss adds nothing: the "shared year" signal was weather.

## Test 2: a region never seen (32 regions hidden in turn, 217 cell-years)

| Mean miss, days | |
|---|---|
| Calendar slid by latitude from other regions | 9.70 |
| **One warmth curve** | **7.14** |
| R1 (region unseen, so no shift) | 7.36 (vs one curve: −0.10 to +0.58) |
| Heat clock, warmth target slid by latitude | 7.99 |

With no local data, the single warmth curve is best. R1 adds nothing, so it fails this half of its bar too.

## How many seasons does a place need? (East, k past seasons picked at random)

| Past seasons | 1 | 2 | 3 | 5 |
|---|---|---|---|---|
| Heat clock | **6.15** | **5.36** | **4.95** | **4.88** |
| Local calendar | 8.01 | 7.10 | 6.70 | 6.43 |
| One warmth curve | 7.15 | 7.11 | 7.11 | 6.57 |

One scored season (20+ records) is already enough for the clock to beat everything else.

## The clock, in plain words

Like a kitchen timer each kitchen sets for itself. For each place, look at its past seasons and ask how much warmth
(degree-days above 10 °C since 1 March, P3's measure) had piled up by the day the moths showed up. This year's forecast
is the day this year's warmth reaches that same pile. Nothing is shared between places, so Georgia's moths never
pull on Maine's. The calendar knows *where*, this year's weather knows *when*. Code: [clock.py](clock.py).

## What this means for expansion

A two-step recipe for any new region: start on the shared warmth curve (best with no local data), and switch to the
local heat clock once the place has one scored season. This is post hoc, so it goes into the league as an eastern
shadow track (forecasts nightly, graded weekly on 2027) before anything reaches the map. The Midwest map stays on P3
(the clock ties it, 4.04 vs 3.85) and the 2027 P3 vs P3.1 test is untouched.

One small leak, in the clock's favour: its cold-start warmth targets come from the year-test rows, whose brood
cut-offs were set with the hidden region's 2° band included. It still loses there. The year test has no such leak:
each fold's clock targets are rebuilt from that fold's training data only.

Reproduce: `regional.py loyo`, `regional.py cold` (~3 h on 4 cores, cached), `clock.py`, `clock.py learning`.
Rows and summaries: [results/](results/).
