# Ohio butterfly trends: result (3 Nov 2026): validation failed, not shipped

Method: [PREREG_OHIO.md](PREREG_OHIO.md), committed before the first fit. Code: `ohio_fetch.py`, `ohio_trends.py`
(`python3 pipeline/atlas/ohio_trends.py --report` writes `results/ohio/`). Tests: `test_ohio.py`.

## The gate
| Check (pre-registered) | Mine | Paper | Pass? |
|---|---|---|---|
| Total abundance, %/yr, within 1.0 point of the paper | **-0.8** (bootstrap 95% CI -2.6 to +0.6; quasi-Poisson -1.4 to -0.3) | -2.0 (GLMM, SE ±0.5) | **No** (off by 1.2) |
| Per species: Pearson r of the year coefficients ≥ 0.8 | **0.76** (Spearman 0.80; 81 species) | | **No** |
| Per species: at most 1 opposite sign where both are significant | 0 of 11 | | Yes |

So `species.json` gets no `"ohio"` and the app is unchanged. The fit code refuses to write it while the gate fails.

## Why they differ (looked at after the gate failed; not used to change anything)
- **My model is the paper's own TRIM check.** A Poisson model with fixed site effects is what TRIM fits. The paper
  reports TRIM at **-0.87%/yr** for the total and says TRIM's species trends were "notably more positive" than its
  GLMM's. Mine: -0.83%/yr, and my species slopes are on average 2.3 points/yr less negative than the GLMM's.
- **Scale.** A Poisson fit follows the total count, so the busiest sites and species weigh most. The paper's GLMM
  (one random effect per site-year) follows something closer to the typical site's log count. On the log scale with
  fixed site effects the total is **-1.6%/yr**; ignoring sites, **-2.0%/yr**.
- **Sites joined over time** (11 in 1996, 50 to 68 from 2002). Later sites are poorer (r = -0.23 between a site's
  first year and its mean log count), so models that pool site levels, as random effects do, lean more negative.
- **Intervals.** The two-way bootstrap (sites and years) is far wider than the GLMM's model-based errors: 13 of 87
  species clear zero here against 41 of 81 in the paper. Directions agree wherever both are confident.

## What a shipped version needs
A choice, made before refitting, of which quantity the card means: "the total counted" (this fit, matches TRIM) or
"the typical site" (log-scale model, closer to the paper). Then a new gate against the matching published number.

## Numbers for the record (not shipped)
87 Ohio species pass the thresholds (≥ 10 sites, ≥ 10 years); 75 of them are Atlas species: 10 declining, 2
increasing, 63 no clear trend. Clearest declines: Aphrodite Fritillary -15%/yr (-23 to -3), Monarch -6% (-10 to
-1.5), European Skipper -7.5% (-15 to -2). Increases: Least Skipper +4% (+0.6 to +8.5), Common Checkered-Skipper
+9.5% (+1.5 to +22). Full table: `results/ohio/species.csv`.
