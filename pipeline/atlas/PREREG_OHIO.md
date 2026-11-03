# Ohio butterfly trends: method written before any fit (3 Nov 2026)

A per-species long-term trend for the Atlas butterflies that the Ohio Lepidopterists' monitoring also counted, for one
line in the species card's "How sure?". Committed before the first fit, like [FROZEN_ATLAS.md](FROZEN_ATLAS.md). Any
change after the first fit is an amendment, dated and listed at the bottom, with the original result still reported.

**What I had seen before writing this:** the deposit's file list and column names; the paper's headline numbers
(total abundance B = -0.0203 per year, SE 0.00496, i.e. about -2.0%/yr; 9 species up, 32 down, 40 not significant of
81); and the first two rows of its `speciesTrends.csv` (Aphrodite Fritillary -0.233, Baltimore -0.224). No fit of
mine had been run.

## Data
Wepprich et al. 2019, PLoS ONE 14(7): e0216270. Dryad doi:10.5061/dryad.cf78420, CC0, read from Dryad's Zenodo copy
(record 4993851) by `ohio_fetch.py`, which pulls only the files below out of the 1 GB zip with HTTP range requests.

The deposit does **not** hold the per-walk counts (those are by request from the North American Butterfly Monitoring
Network; only a cabbage-white sample is included). It holds `allpops.csv`: for each species × site × year, the
authors' population index (`Index`: the season's weekly counts integrated over the weeks, with missed weeks filled in
by their phenology GAM), the raw total counted (`YearTotal`), the number of surveys (`SurvPerYear`), mean survey
minutes (`meanTime`) and mean list length (`meanLL`). So the effort correction is built from those.

- Years 1996-2016. Sites and site-years as the paper: site-years with ≥ 10 surveys, at sites with ≥ 3 such years.

## The model (primary; this is what ships)
- Response y: the site-year population index (`Index`), which already accounts for missed weeks.
- Effort: offset log(total survey minutes) = log(`meanTime` × `SurvPerYear`), as the paper did (a rate per minute).
- log E[y] = site effect + β·year + offset. Quasi-Poisson: fitted by Poisson maximum likelihood with a fixed effect
  per site (profiled out exactly, so only β is fitted), which is consistent for non-integer y.
- Annual change = 100·(e^β − 1) %/yr.
- **95% CI: two-way pairs bootstrap**, 1,000 resamples, fixed seed: resample sites with replacement and years with
  replacement, independently, keep the site-years in both, refit, take the 2.5th and 97.5th percentiles. Resampling
  sites covers sites that run high or low together over time; resampling years covers good and bad years shared by
  every site (the paper's year random effect). Resamples where the species is never counted are refit as missing and
  dropped; if more than 5% are dropped, no CI and no line.
- **Class**: "declining" if the CI's upper end < 0, "increasing" if its lower end > 0, else "no clear trend".
- List length is **not** a covariate in the primary fit: fewer butterflies of every kind makes lists shorter, so it
  would soak up part of a real community-wide decline. It is a sensitivity check below.

## Thresholds (below either, the species gets no line)
- Counted (YearTotal > 0) at ≥ 10 sites, and in ≥ 10 distinct years, within the filtered site-years.
- Only site-years at sites where the species was ever counted enter its fit (sites that never saw it carry no
  information on β with a site effect).

## Matching to the Atlas
- Ohio common name → scientific name from the deposit's `species_names.csv`, then exact match to `species.json`.
- Where iNaturalist's taxonomy (the Atlas's) uses another name for the same species, a hand-written synonym table in
  `ohio_trends.py`, each entry a straight rename of one species. Species complexes (e.g. "Azures", spring + summer
  azure combined) are **not** mapped to a single Atlas species.

## Validation against the paper (before shipping; failing either stops the ship)
1. **Total abundance**: sum `Index` over all species per site-year, same model. Pass if my annual % change is within
   1.0 percentage point of the paper's -2.0%/yr.
2. **Per species**: over the species fitted by both, Pearson r between my β and the paper's `estimate` ≥ 0.8, and
   among species whose CI excludes 0 in both (paper: p < 0.05), at most 1 with opposite signs.

Reported, not used for shipping: (a) raw count per survey (`YearTotal`, offset log `SurvPerYear`), same model;
(b) quasi-Poisson model-based CIs (SE × √dispersion) for the primary fit; (c) the primary fit plus centred mean list
length, closest to the paper's model; (d) counts of declining / increasing / no clear trend against the paper's 32 / 9 / 40.

## Shipping
`species.json` gets `"ohio": [pct, lo, hi, nSites, nYears]` (%/yr and CI to one decimal, from the primary fit) for
matched species that pass the thresholds. The app shows one line in "How sure?", labelled Ohio only and 1996-2016,
a past baseline and not current status, crediting Ohio Lepidopterists / Wepprich et al. with a link.

## Amendments
- **3 Nov 2026, after the gate failed** (RESULT_OHIO.md): nothing from this fit ships. The card instead shows the
  paper's own published per-species trends (`speciesTrends.csv`, the paper's Table 2): coefficient ± 1.96 SE as %/yr,
  "declining" or "increasing" only where that interval excludes 0, and the same thresholds (≥ 10 sites, ≥ 10 years,
  the deposit's `nsite` and `yrs`). Field `trend` in species.json, from `ohio_published.py`. This fit stays as research.
