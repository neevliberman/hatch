# Tryout plan: ground warmth instead of air warmth (written 2026-10-26, before any soil score)

**Idea.** Luna moths spend the winter as pupae in cocoons in the leaf litter, on the ground. P3 counts warmth from the
air 2 m up (Daymet). The ground warms later in spring and is buffered by snow, so a clock read from the ground might
match when moths come out better. P4 tried a stand-in ("leaf-litter smoothing" of air temperatures, 5.08 d, worse);
this tests real ground temperatures.

**Data.** ERA5-Land soil temperature, top layer (0-7 cm), hourly, from the Open-Meteo archive (free, no key; reachable
from here since 2026-10-26), at the centre of each of P3's 405 hexagons, 1 March to 31 August, 2015-2026. Each day's
lowest and highest hourly values replace Daymet's tmin and tmax in P3's own degree-day code (`accumulate`: double sine,
base 10 °C, cap 30 °C, from 1 March). Days are local (America/Chicago). Nothing else changes: records, first-brood
cut-offs, effort, hexagon weights, fitting and scoring are P3's (`pipeline/fit/evaluate.py`, `loyo_fold`).

**Candidates (fixed now).**
- **S1**: P3's spec (`p3_photo`) on ground degree-days, base 10 °C.
- **S2**: the same, with the base picked inside each fold by training likelihood from {4, 6, 8, 10} °C (the ground in
  spring is cooler and steadier than air, so 10 °C may count too little).
- **Control**: P3 refit in the same run on Daymet air (should reproduce P3's 3.85 d).

**Scores.** Midwest leave-one-year-out (2015-2025, 31 band-years), mean of onset and peak absolute error, the P3 score.
Also reported, not decisive: the WI/MN spatial holdout, and 2026 (ERA5-Land 2026 for S, PRISM for P3 as in
`pipeline/p4/score_2026.py`, if that comparison can be made like for like; otherwise not reported).

**Rule (fixed now).** A candidate earns a bench spot (a 2028 shadow, since 2027's bench closes with this plan's
results unknown to the 2027 rules) only if its Midwest LOYO is at least **0.2 d better** than the control, and it is
not more than 0.5 d worse on the holdout. Otherwise it is written up and dropped. As P4 found, the noise floor is
about 3.0 d, so at most about 0.85 d can be gained; a fit that matches sightings better but dates worse does not count.

**Feasibility, also required for a bench spot.** A live feed: Open-Meteo's forecast API serves the same soil layer for
the next 7 days and the archive catches up within about a week, so a nightly forecast can be made; checked before any
bench entry is written.
