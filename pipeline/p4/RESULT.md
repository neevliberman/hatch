# P4 result: is the luna model as good as it gets? (2026-10-24)

**Short answer: for the Midwest, close to it. Nothing we tried beat P3 by a margin worth shipping, so the map and the
live pipeline stay on P3.** Rules were written before any score: [FROZEN_P4.md](FROZEN_P4.md) (with a change log of
everything adjusted after seeing a result). Code: `run_p4.py`, `model4.py`, `jaxlik.py`; numbers: `results/`.

## Why there is little room left
On the Midwest leave-one-year-out test (31 band-years, the same one P3 used), P3 is off by about 3.9 days and the
**noise floor is about 3.0 days**: each "real" date is itself only known to about ±3 days from a few hundred
sightings. Picture a bathroom scale that wobbles by 3 lbs. A perfect forecaster would still read 3 off, so the most any
idea can gain is about 0.85 day, and gains of 0.1 to 0.3 day are smaller than the wobble.

## Scoreboard (mean of onset and peak error, days; lower is better)

| Idea | Midwest LOYO | Verdict |
|---|---|---|
| Calendar (usual date) | 7.31 | baseline |
| P1 (older heat model) | 4.06 | |
| **P3 refit here (control)** | **3.86** | the map's model; reproduces P3's 3.85 |
| Winter-warmth term (mild winter shifts the target) | 3.81 | tiny gain, inside noise (fitted effect: about 2 to 7 degree-days per °C) |
| Latitude slide on the target | 3.94 | no help |
| Daylength gate (clock starts only once days are long) | 3.90 | no help (gate not used) |
| Fitted base/upper temperatures (6-12 °C, 24-33 °C) | 3.90 | picked 6/24, scores the same |
| Leaf-litter warmth (smooth temperatures, slow pupae) | 5.08 | worse: picked the slowest option |
| Two clocks (warmth moths + date moths) | 5.02 | worse, even though it fits the sightings better |
| Longer or shorter flight life (4-21 days) | 4.10 | worse |
| Gradient-boosted trees on weather features | 7.35 | much worse (31 band-years is too few for trees) |
| Ridge regression on the same features | 4.85 | worse |
| Averages: P3 + P1 / P3 + winter / all three | 3.73 / 3.78 / 3.68 | -0.13, -0.07, -0.18 vs P3; 95% CIs all include 0 |

**Average of models:** the three-way average is 0.18 day better, short of the 0.2-day bar we set, and its interval
(-0.70 to +0.25) includes zero. Not shipped. The members were picked after seeing scores (P1 from the free look in FROZEN_P4.md, the winter model as the best Midwest-only candidate), so this figure is optimistic. On 2026 the P3+P1 average was worse than P3 alone (5.48 vs 4.78).

## "Ten times more data" did not help
We pulled 67,000 luna records from all of eastern North America (31-49 °N, 60-100 °W; the Midwest has 3,800 usable
records) and trained one model on everything, with a finer 2 × 4 degree moth-effort map.

| Model | Midwest | Rest of the East (218 cell-years) | Local calendar, East |
|---|---|---|---|
| Wide warmth model | 5.65 | 7.07 | 6.27 |
| + latitude slide | 5.71 | 7.13 | |
| + winter term | 5.68 | 7.10 | |
| + P3.1's bounds | 6.31 | 8.00 | |
| trained only north of 38 °N | 6.57 | 9.11 | |
| Midwest-only data, finer effort map | 4.19 | n/a | |
| **Gradient-boosted trees on weather features** | 5.36 | **5.85** | |

Plainly: **one warmth curve for the whole East is worse than a local calendar.** Moths in Georgia, Ohio and Maine do
not turn warmth into flight the same way (the south has several broods and flies before our 1 March start; the fit
drifts into a wide, mushy curve when it tries to cover them). Even the Midwest got worse when it shared a model with
the East. Part of that is the finer effort map alone (3.86 → 4.19 with no extra data). The trees did beat the calendar
in the East (5.85 vs 6.27), but lose in the Midwest (5.36 vs 3.86).

A bug caught on the way: the first brood cut-off per small cell failed in one Pennsylvania/Ohio cell (it mixed both
broods, a 25-day apparent miss). Cut-offs are now per 2° latitude band (change log; first results in `results/v1_cutoff/`).

## The 2026 season (nobody saw it; PRISM weather; 5 Midwest band-years)
P3-style refit **4.78**, with winter term 4.68, calendar 7.86, P1 6.98. The wide model: Midwest 7.54, East 9.46 vs
calendar 7.80. So 2026 agrees: P3 holds up on a fresh season (the southern-strip miss is already written up in
[../fit/SOUTH_BIAS.md](../fit/SOUTH_BIAS.md)).

## Decision
Under the rule, no candidate beat P3 by 0.2 day on the headline test (rule 1), so **no model change**. Rules 2 to 4 (spatial holdout, warm-spring stress test, full 2026 comparison) were not run for any candidate: they only matter for a candidate that passes rule 1, and none did. The wide-model rows above are shown both unbounded and with P3.1's bounds (the version the rule applies to; worse on both). Honest limits:
- 31 band-years cannot separate models that differ by less than about half a day (see the intervals).
- The leaf-litter, two-clock and flight-life results show a trap: they improve how well the model explains sightings but
  worsen the dates. Judge by held-out dates, not by fit.
- Several candidates were added after the Midwest-only round (flight life, bounds, northern-only); they are labelled in
  the change log, and none would have shipped on them anyway.

## What is worth doing next (plain)
1. **Wait for 2027.** The live scorecard grades P3 on a real, unseen season; that is the cleanest test we can get.
2. **More years, not more regions.** The wobble comes from few sightings per band-year. Each new season adds about
   3 band-years; two more seasons will make 0.2-day differences visible.
3. **Per-region models** (Southeast, Northeast) each trained on its own region, in place of one big curve. The trees'
   East result hints regional models can beat a calendar there; that is the road to new regions, not to a better Midwest.
4. **Averaging with P1** helped a little on past Midwest years and hurt on 2026, so it is a hint only. If we want it, write the rule down before the 2027 season and let the scorecard decide.
