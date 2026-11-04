# Place features that travel: pre-registered gate (written 4 Nov 2026, before any data pull or training)

Research only. Nothing here changes the site, the shipped model or [FROZEN_ATLAS.md](FROZEN_ATLAS.md).
This file is committed before any record is fetched or any model is trained. Any change after that is an amendment:
dated, explained, listed at the bottom, with the original rule and result still reported.

## The question
The Atlas beats each species' own calendar for 94-95% of species in a year it never saw, but for only 58-59% in
Wisconsin + Minnesota, states it never saw ([RESULT.md](RESULT.md)). Its place input is latitude and longitude as
sines and cosines at four scales (`model.py`, `place_features`), which can memorise the Midwest grid. Do
environmental place features (what a place is like, not where it is) carry over to unseen regions better?

## Variants (only the place input changes)
Every variant uses the same network, warmth clock, optimiser, epochs, seed, species list and records.

| Variant | Place input |
|---|---|
| **L** (baseline) | today's 19 features: scaled lat/lng, their sines and cosines at 4 scales, typical warmth |
| **E** (env only; exploratory) | environment only, no latitude or longitude in any form (list below) |
| **E+P** (env + coarse latitude; **the candidate**) | E plus day length at the summer solstice (hours), a smooth, physical stand-in for latitude |

Environmental features, one value per H3 resolution-4 cell (the Atlas's warmth grid, ~45 km across), standardised
with the mean and spread over all grid cells (no records involved):
1. **Typical warmth**: degree-days banked by 30 June, mean of the training years (already in L).
2. **Winter cold**: mean daily minimum, December-February, training years.
3. **Precipitation normals**: mean annual total (log) and April-September total (log), training years.
4. **Elevation**: mean of the cell centre and its 7 resolution-5 children (Copernicus DEM via the Open-Meteo
   elevation API).
5. **Land-cover shares**: tree, cropland, grass + shrub, built-up, water + wetland, from ESA WorldCover 2021,
   sampled at the cell's 343 resolution-7 child centres.

Only E+P can pass the gate. E is reported to show what latitude adds; it cannot pass on its own (one candidate, so
no picking the best of several after the fact).

## Data (deviations from FROZEN_ATLAS.md, applied identically to all three variants)
- **Records**: GBIF's iNaturalist research-grade insects, same box, years and filters as FROZEN_ATLAS.md, re-pulled
  with `fetch_gbif.py` now (the 27 Oct snapshot is not in this environment). Burst filter as `data.py`.
- **Warmth**: Daymet's server fails TLS verification from this environment, so the warmth clock and all weather
  normals come from **PRISM daily via RCC-ACIS** (grid 21, `pipeline/live/sources.py`'s weather-day rule), as
  `weekly_static.py` already does. Cells PRISM does not cover (Ontario, open lake) borrow the nearest covered cell.
  Daymet's 365-day calendar is kept (a leap year drops 31 December).
- **Species list**: every species with >= 100 records in that fold's training split, plus "other".

## Splits: leave-region-out, three folds of whole states
| Fold | Held-out region (never in that fold's training) |
|---|---|
| **N** | Wisconsin, Minnesota (the frozen gate's unseen states) |
| **E** | Michigan, Ohio |
| **S** | Missouri, Kentucky |

For each fold: train on **2015-2024, every other state/province in the box** (the other two folds' states included).
- **Region test**: the held-out states, every year 2015-2025 (as the frozen test B).
- **In-region, unseen-year test**: 2025, the fold's training states (as the frozen test A).

Recipe (no tuning; taken from the frozen runs): 10 passes (run 2's tuned choice), AdamW with run 2's optimiser (no
decay on the clock blend), batch 4,096, learning rate 2e-3 one-cycle, seed 0. Calendar baseline as FROZEN_ATLAS.md
with the tuned setting from both frozen runs (alpha 300, neighbouring weeks blended), fit on the fold's training
split. 3 folds x 3 variants = 9 networks.

## Metrics
- **Win share** (primary): for each scored species, the Atlas variant wins if its "is this record that species, yes
  or no?" log-likelihood over the test records beats the calendar's (`score.py`, unchanged). Scored species: >= 400
  training records and >= 20 test records in that fold's test set. Pooled win share = wins / scored over all
  (fold, species) pairs of the three folds.
- **All records**: full multi-class log-likelihood per record, pooled over the three folds' test records.
- **Days error**: for each scored (fold, species) pair in the region test, the variant's expected daily count
  (its share for that species, summed over each day's test records in the region, all years pooled) gives an onset
  (10th percentile day) and a peak (median day), interpolated as the luna check does. Days error = mean of
  |onset - observed onset| and |peak - observed peak|, where observed comes from that species' own test records.
  Summary: the median over pairs. The calendar gets the same treatment, for reference.

## The gate: E+P passes only if all five hold (each compared with L, trained the same way)
1. **Region skill**: pooled region win share of E+P >= L's + **5.0 points**.
2. **Consistency**: E+P's region win share >= L's in **at least 2 of the 3 folds**.
3. **Region, all records**: E+P's pooled region log-likelihood per record > L's.
4. **Region days error**: E+P's median days error <= L's + **1.0 day**.
5. **In-region regression allowed**: on the unseen-year test (2025, training states, pooled over the three fold
   models), E+P's win share >= L's − **3.0 points**, and its log-likelihood per record >= L's − **0.02 nats**.

**Decision rule.** All five pass: E+P is worth a full FROZEN-style run (its own frozen rules, a fresh test season)
before any site change; nothing ships from this gate alone. Any one fails: keep lat/lng; write up what each variant
did and why. A failed gate is a valid result; thresholds above are not moved after results are seen.

## Compute and resumability
Each (fold, variant) network and its scores are saved as they finish (`notebooks/data/atlas/place/`), so a restart
resumes. A 2% smoke run checks the code end to end first; its numbers are not used or reported as results.
If the full 9 runs cannot finish in this session, the fallback, decided now, is 6 passes for **all** variants (not
per variant), stated in the result; anything else is an amendment.

## Also reported (not part of the gate)
- Per-fold tables for L, E, E+P and the calendar; E's numbers next to E+P's.
- Fold N's L against the frozen gate's WI/MN result (59%), as a sanity check that this re-pull and PRISM warmth
  reproduce the known gap.

## Amendments
(none)

Note, 4 Nov 2026, before any result: one pass took 3.4 min, so the pre-declared fallback (6 passes for all
variants) was invoked about 3 minutes into the first network; that network was discarded unscored.
