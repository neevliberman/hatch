# Ohio butterfly trends: result (3 Nov 2026): validation failed, not shipped

Method: [PREREG_OHIO.md](PREREG_OHIO.md), committed before the first fit. Code: `ohio_fetch.py`, `ohio_trends.py`
(`python3 pipeline/atlas/ohio_trends.py` writes `results/ohio/` and exits 1 while the gate fails). Tests: `test_ohio.py`.

## The gate
| Check (pre-registered) | Mine | Paper | Pass? |
|---|---|---|---|
| Total abundance, %/yr, within 1.0 point of the paper | **-0.8** (bootstrap 95% CI -2.6 to +0.6; quasi-Poisson -1.4 to -0.3) | -2.0 (GLMM, SE ±0.5) | **No** (off by 1.2) |
| Per species: Pearson r of the year coefficients ≥ 0.8 | **0.76** (Spearman 0.80; 81 species) | | **No** |
| Per species: at most 1 opposite sign where both are significant | 0 of 11 | | Yes |

So nothing from this fit reaches `species.json` or the app.

## Why they differ (looked at after the gate failed; not used to change anything)
- **Main cause: fixed against random site and year effects, with sites joining over time.** The paper's Poisson GLMM
  *without* its site-year effect still gives -1.83%/yr, so its per-observation effect (how it weights sites) explains
  only about 0.2 points of its -2.0. The rest of the gap to our -0.8 is in how sites and years enter: here each site
  has its own fixed level and there is no year effect; there, sites and years are random effects. That matters here
  because sites joined over time (11 in 1996, 50 to 68 from 2002) and later sites are poorer (r = -0.23 between a
  site's first year and its mean log count), so a model that pools site levels reads part of the newcomers'
  lower counts as decline, and a fixed-site model does not.
- **Close to TRIM, not the same.** A Poisson model with fixed site effects is close to TRIM, and the paper's TRIM
  check gave -0.87%/yr for the total (ours -0.83) with species trends "notably more positive" than its GLMM's (ours
  average 2.3 points/yr less negative). TRIM there had no effort offset and modelled serial correlation; ours has an
  offset and no serial term, so the match is partly luck.
- **Weighting still moves our own fit.** On the log scale with fixed site effects our total is -1.6%/yr; with no site
  effects, -2.0%/yr. The two causes are not cleanly separable with these data.
- **Intervals.** The two-way bootstrap (sites and years) is far wider than the GLMM's model-based errors: 13 of 87
  species clear zero here against 41 of 81 in the paper. Directions agree wherever both are confident.

## What ships instead
The card ships the paper's own per-species trends from the deposit's `speciesTrends.csv` (`ohio_published.py`), not
this refit. This refit stays in the repo as research; the app never reads it.

## Numbers for the record (not shipped)
87 Ohio species pass the thresholds (≥ 10 sites, ≥ 10 years); 75 of them are Atlas species: 10 declining, 2
increasing, 63 no clear trend. Clearest declines: Aphrodite Fritillary -15%/yr (-23 to -3), Monarch -6% (-10 to
-1.5), European Skipper -7.5% (-15 to -2). Increases: Least Skipper +4% (+0.6 to +8.5), Common Checkered-Skipper
+9.5% (+1.5 to +22). Full table: `results/ohio/species.csv`.
