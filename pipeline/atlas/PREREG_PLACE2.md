# Place features, round 2: finer environment and seed noise (written 4 Nov 2026, before any data pull or training)

Research only. Nothing here changes the site, the shipped model or [FROZEN_ATLAS.md](FROZEN_ATLAS.md).
This file is committed and pushed before any record is fetched or any model is trained. Any change after that is an
amendment: dated, explained, listed at the bottom, with the original rule and its result still reported.
The only thing run before writing it: a 1° x 1° RCC-ACIS GridData probe (bbox, yearly sums) to check that the
res-6 route below is feasible. Its values are not used.

## Why a round 2
[RESULT_PLACE.md](RESULT_PLACE.md): environment + summer day length (E+P) beat the calendar for 70.7% of species in
unseen states against lat/lng's 51.8%, and was better in all 3 folds, but in-region (2025, training states) it lost
0.037 nats per record against a 0.02 allowance, so lat/lng stayed. Suspected cause: environment is one value per
~45 km H3 res-4 cell, while lat/lng gives each record's exact spot. The independent review asked for (a) a cheap
diagnostic of that cause, (b) a border buffer, since held-out and training states share border cells, (c) several
seeds, so a 0.02-nat call is not a coin flip, and (d) finer environment cells. This prereg does all four.

## Variants (only the place input changes)
Every variant uses the same network, warmth clock (res-4 PRISM, as round 1), optimiser, 6 passes, batch, species list
and records. A seed sets the weight initialisation, dropout and the shuffling order.

| Variant | Place input | Role | Seeds |
|---|---|---|---|
| **L** | today's 19 features from each record's exact lat/lng (`model.place_features`) | baseline | 0, 1, 2 |
| **D** | L, but each record's lat/lng replaced by the centre of its res-4 warmth cell | **diagnostic** | 0, 1, 2 |
| **EP6** | E+P with every feature at **H3 resolution 6** (~7 km across; below) | **the gated candidate** | 0, 1, 2 |
| H | EP6 + the coarse lat/lng waves L uses: sin and cos of scaled lat and lng at L's two lowest frequencies (1 and 2), 8 inputs, from the record's exact spot | exploratory | 0 |
| EP4 | round 1's E+P exactly (res-4 features, `place/env.npz`), for a same-snapshot res-4 vs res-6 comparison | exploratory | 0 |

Only EP6 can pass the gate. D, H and EP4 are reported but cannot pass, whatever they score (one candidate, chosen
now). EP6 is the candidate rather than H because H gives back some of the "where" that the region test punishes;
it is run to see whether a coarse offset wins back in-region skill without losing the unseen-region gain.

### Res-6 environment features (EP6, H)
Same ten features and day length as round 1, at every res-6 cell that holds a record or is a child of one of the 1,217
res-4 grid cells. A record takes the res-6 cell of its exact lat/lng. Standardised with the mean and spread over the
grid's res-6 children (no records involved).
- **Route.** Round 1 made one RCC-ACIS daily call per res-4 cell; at res 6 that is ~60,000 calls. Instead, PRISM's
  native 4 km grid (grid 21) is pulled for the whole box with RCC-ACIS GridData **bbox** calls and ACIS's own
  reductions (one call per variable per tile, ~tens of calls), and each res-6 cell takes the value of the PRISM grid
  point nearest its centre. PRISM points with no data (Ontario, open water) are skipped, so such cells take the
  nearest covered point (round 1's borrow rule). No coarser fallback (res 5) is needed unless this route fails; if it
  does, that is an amendment.
- **Typical warmth**: ACIS growing degree-days, base 50 °F (average method), summed 1 Mar - 30 Jun, mean of
  2015-2024, in °C-days. (Round 1 used a double-sine method capped at 30 °C on the res-4 grid; standardised, the
  two differ little in shape. This is a declared difference, applied to EP6 and H only.)
- **Winter cold**: mean daily minimum over January-February and December, 2015-2024 (as round 1).
- **Precipitation**: log of the mean annual total, and log of the mean April-September total, 2015-2024.
- **Elevation**: PRISM's own grid elevation (ACIS grid metadata), not round 1's Copernicus DEM via Open-Meteo,
  which would need ~600-5,000 calls at res 6 and has a daily quota.
- **Land cover**: the same ESA WorldCover 2021 overviews (~300 m, round 1's cached tiles), shares of the five groups
  among each res-6 cell's 49 res-8 child centres.
- **Day length** at the summer solstice, from the res-6 cell centre's latitude.

## Data and splits (unchanged from PREREG_PLACE.md unless stated)
- **Records**: GBIF iNaturalist research-grade insects, same box, years 2015-2025 and filters, re-pulled now with
  `fetch_gbif.py` (round 1's pull was deleted). Burst filter as `data.py`. A new snapshot, so all variants here are
  compared only with each other, not with round 1's numbers.
- **Warmth clock**: round 1's PRISM-via-RCC-ACIS `warmth.npz` (res 4, 2015-2025), reused unchanged for every variant.
- **Folds** as round 1: N = Wisconsin + Minnesota, E = Michigan + Ohio, S = Missouri + Kentucky. Train on 2015-2024,
  every other state/province in the box.
- **Species list**: >= 100 records in the fold's training split, plus "other". **Calendar**: alpha 300, neighbouring
  weeks blended, fit on the fold's training split. **Scorer**: `score.py`, unchanged. **Scored species**: >= 400
  training records and >= 20 test records in that test set.
- **Passes**: 6 for every network (round 1's run length, kept for comparability). Batch 4,096, AdamW, lr 2e-3
  one-cycle, no decay on the clock blend.

## Tests
- **Region test, buffered (primary for checks 1-4).** The held-out states, every year 2015-2025, *minus* records in
  border cells. A res-4 cell is a border cell if it lies within one res-4 ring (`grid_disk(c, 1)`) of any res-4 cell
  that holds a training record of that fold. This removes held-out cells that share a cell, or touch a cell, with
  training data.
- **Region test, unbuffered** (round 1's definition): reported for every check alongside, not used by the gate.
- **In-region, unseen-year test**: 2025, the fold's training states (as round 1).

## Metrics (as PREREG_PLACE.md, per network)
Win share (species beating the calendar on per-species yes/no log-likelihood), all-records multi-class log-likelihood
per record, and median days error (onset 10th + peak 50th percentile day). For each variant and seed, the pooled value
over the three folds is computed exactly as in round 1; the gate then uses the **mean over seeds** of each pooled
value. Seed spread (SD over seeds, and the range of the per-seed paired difference EP6_s - L_s) is reported for every
metric.

## The gate: EP6 passes only if all five hold, on seed means (3 seeds each), against L
1. **Region skill**: buffered region win share of EP6 >= L's + **5.0 points**.
2. **Consistency**: EP6's buffered region win share (seed mean, per fold) >= L's in **at least 2 of 3 folds**.
3. **Region, all records**: EP6's buffered region log-likelihood per record > L's.
4. **Region days error**: EP6's buffered median days error <= L's + **1.0 day**.
5. **In-region regression allowed**: on 2025 in the training states (pooled over the three fold models), EP6's win
   share >= L's − **3.0 points**, and its log-likelihood per record >= L's − **0.02 nats**.

The seed spread is reported but adds no extra condition. **Decision rule** (as round 1): all five pass, EP6 is worth
a full FROZEN-style run (its own frozen rules, a fresh test season) before any site change, and nothing ships from
this gate alone; any one fails, keep lat/lng. Thresholds are not moved after results are seen.

## The diagnostic (D), read by a rule fixed now
Let ΔD = seed-mean in-region log-likelihood per record of D minus L's (negative = D worse). Round 1's E+P lost 0.037.
- ΔD <= −0.025: res-4 coarseness explains **most** of round 1's in-region loss.
- −0.025 < ΔD <= −0.010: it explains **part** of it.
- ΔD > −0.010: it does **not** explain it; the loss comes from something other than the 45 km resolution.
Reported with ΔD's per-seed range, and next to EP4's in-region loss against L (seed 0, same snapshot) and EP6's.

## Compute and resumability
Each network is checkpointed after every pass (weights, optimiser, schedule, random states), and each (fold, variant,
seed) result is saved as it finishes (`notebooks/data/atlas/place2/`), so a container restart loses at most one pass.
Order: for seed 0, 1, 2: every fold's L, EP6, D; then H and EP4 (seed 0). Two networks may train at once with 2
threads each if the smoke run shows that is faster; this changes nothing but wall time. If the session cannot finish
all 33 networks, the exploratory ones are dropped first in the order EP4, H, D seed 2, D seed 1; the 18 gated
networks (L and EP6, 3 seeds x 3 folds) are required for a verdict, and fewer seeds or passes would be an amendment.

A 2% smoke run (2 passes, seeds 0 and 1, every variant) checks the code end to end first. Its numbers are not used.
Before any full result exists, the smoke run and the measured timing are recorded below under "Run log" and committed.

## Outputs
`pipeline/atlas/results/place2/full/gate.json` and `per_species.csv` (one row per fold, test, species, variant, seed;
floats at full precision). Big scratch files (GBIF chunks, records, checkpoints, PRISM grids) are deleted at the end.

## Run log (filled in before results)
Written 4 Nov 2026 ~20:45 UTC, after the smoke run and before the full run started. No full-run network existed.
- **Records**: re-pulled 4 Nov 2026 (19:40-20:33 UTC; one transient GBIF failure, resumed from the saved ranges):
  2,923,717 raw records, 2015-2025, within 0.01% of round 1's 2,923,938.
- **Res-6 features**: PRISM grid pulled in 20 ACIS bbox calls (4 tiles x 5 variables), 109,176 covered 4 km points,
  59,633 res-6 grid cells, ~2 min. Check against round 1's res-4 features (mean of each res-4 cell's res-6 children,
  every 5th cell): correlation 0.98-1.00 for the climate and land-cover features, 0.90 for elevation (PRISM's DEM vs
  Copernicus).
- **Smoke run** (2% sample, 2 passes, seeds 0-1, all 5 variants, 2 workers): ran end to end in 2.5 min, wrote
  gate.json and per_species.csv. Numbers not used. It showed the pre-declared buffer drops a lot of the region
  test: about 20% of held-out records in fold N, 42% in E and 60% in S (on the 2% sample). This is a property of the
  rule as declared, not a reason to change it; the unbuffered test is reported alongside.
- **Resume check**: a 3-pass fit stopped after pass 1 and resumed (with the global random state disturbed) gives
  bit-identical weights to an uninterrupted fit.
- **Timing**: a training step on the full-size network takes 472 ms with 1 worker x 4 threads, and 757 ms per worker
  with 2 workers x 2 threads (378 ms effective). So the full run uses 2 workers (as allowed above): about 30 min per
  network per worker, ~15 min effective, ~8.5-9 h for all 33 networks.

## Amendments
(none)
