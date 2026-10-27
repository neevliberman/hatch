# Living Atlas gate, run 1 (27 Oct 2026): NO-GO as frozen

Rules: [FROZEN_ATLAS.md](FROZEN_ATLAS.md), committed before training. Numbers: `results/gate.json`, `results/per_species.csv`.
Run: `python3 pipeline/atlas/run_gate.py` (74 min on 4 cores).

**Short answer: the network passes both big tests by a wide margin and fails the luna check by 0.3 days, so the
frozen verdict is no-go.** Warmth also hasn't earned its place yet: the same network without the warmth clock scores
the same.

| Check | Atlas | Calendar | Pass? |
|---|---|---|---|
| A. 2025, a year it never saw: species won | **620 of 652 (95%, CI 93-97%)** | | yes |
| A. all records, log-likelihood per record | **−5.37** | −5.65 | yes |
| B. Wisconsin + Minnesota, never seen: species won | **325 of 553 (59%, CI 55-63%)** | | yes |
| B. all records | **−5.61** | −5.98 | yes |
| Luna 2025 onset/peak, mean days off (5 band-years) | 5.6 d | 4.9 d (P3: 4.3 d) | **no** (needs ≤ 5.3) |

## What it means, in plain words
- **"Who's out here this week" works.** Given a place and a day, the network's guess of each species' share of insect
  photos beats each species' own strip-by-week calendar for 95% of species in a year it never saw, and for 59% in two
  states it never saw. It learns 1,736 species at once with about a million numbers.
- **The luna miss is one band.** In 43-45 °N it put first moths 18 days late (P3: 7 days). The other four bands are
  within a few days. Five band-years is a small check, but it was the rule.
- **The warmth clock didn't learn.** Each species' blend of the three clocks stayed near the starting even mix
  (median 31/33/35%). Cause found after the run: the optimiser's weight decay also pulled those blend weights back to
  even every step, so the clock could barely move. The no-warmth version ties the full one (−5.36 vs −5.37 on 2025;
  it wins 377 of 652 species head to head).
- **Biggest loss on 2025: the periodical cicada** (*Magicicada septendecim*), a 17-year brood that emerged in 2025.
  No calendar or warmth model can know that; it needs the brood map as an input.
- **Data:** GBIF's copy of iNaturalist (openly licensed photos only), 2.92 M records, 2.54 M after the burst filter.
  That's fewer species (1,736 with 100+ training records) than the 2,654 counted from the iNaturalist API.

## First maps
![Luna moth](figures/Actias_luna.png)
![Japanese beetle](figures/Popillia_japonica.png)

The luna wave moves north from May to June and a second brood shows in the south in August, all learned, not coded.
The speckle (single hot cells) suggests the finest place features overfit busy spots.
