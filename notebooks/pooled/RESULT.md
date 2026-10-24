# Pooled moth model: a first look (exploratory, 2026-10-24)

**This is exploratory research, not a pre-registered test.** I wrote the species rules and the design before fitting, but nothing was frozen and reviewed the way P3 was ([FROZEN_P3.md](../../pipeline/fit/FROZEN_P3.md)). It was run once. Some speed-only settings changed after a 5-species smoke run. Nothing on the map changes.

**The question.** The build plan's season-two idea is a model pooled across ~100 moths ("the real ML upgrade"). A review estimated that 150-250 species could get their own model and that pooling could add another 350-450. The idea is that data-poor species borrow strength from data-rich ones. Does that work on real Midwest data?

**Short answer: not in a useful way, at least in this form.**
- Pooling makes data-poor fits *sensible*. With 10 records, 62% of fits made species by species with P3's code put the curve's skew at its limit. Pooled, none did.
- But forecasts barely move: pooling saves **0.17 days** at 10 records (95% CI 0.00 to 0.33) and about 0.1 day at 25 and 50 records. Adding traits (family, size, voltinism, larval food) helps no further.
- With all of each species' records, the heat model **does not beat the calendar on average** for these 52 moths. It is about 1 day worse (7.1 vs 6.1 days off, CI 0.2 to 2.0 worse). The heat model wins for only 21 of the 50 scored species (22 pooled). Luna is one of them.
- So the binding constraint for adding species is not data-poor species. It is that heat accumulation from 1 March explains many moths' timing no better than their usual dates do.

![Error vs records per species, and the gain from pooling](figures/pooled_vs_n.png)

*Left: average days off (onset and peak) for each way of guessing, against how many of a species' records it learned from. Right: days saved by pooling compared with fitting the species alone, with 95% intervals across species.*

## The numbers

Leave-one-year-out over 2015-2025. There were 651 scored band-years (latitude strip × year with ≥ 20 records) across 50 of the 52 species. Each score is the mean days off for onset (10th-percentile day) and peak (median day), averaged within each species and then across species. With 10/25/50 records, I drew 2 random subsamples from the training years and averaged them.

| Records used for training | 0 | 10 | 25 | 50 | all (~150-2,200) |
|---|---|---|---|---|---|
| Calendar: those records' own dates, per latitude strip | – | 11.3 d | 9.5 d | 8.0 d | **6.1 d** |
| Heat model, species alone (P3's fitter, P3.1 bounds) | – | 8.3 d | 8.0 d | 7.5 d | 7.1 d |
| Heat model, pooled across species | 19.4 d | **8.2 d** | **8.0 d** | 7.5 d | 7.0 d |
| Heat model, pooled, prior shaped by traits | 21.1 d | 8.4 d | 8.0 d | 7.5 d | 7.1 d |
| *Pooled minus species-alone (same fitter), 95% CI* | | *−0.17 (−0.33 to 0.00)* | *−0.11 (−0.25 to +0.03)* | *−0.04 (−0.14 to +0.07)* | *−0.20 (−0.45 to −0.03)* |

Other baselines are in `results/summary.json`. A calendar slid by latitude does worse with all records (7.0 d) and better with 10 (10.6 d). P1's empirical heat model scores 10.0 / 8.6 / 8.2 / 7.7 d. Per-species scores are in `results/per_species.csv`.

## What it means, in plain words

- **Think of each species as a bank account with a savings target.** Pooling assumes the targets of all moths come from one shared spread, so a new species' first few receipts get averaged with what is typical. That only helps if moths are alike. They aren't very alike here. The fitted median targets range from near 0 to over 1,000 degree-days (middle half 120-590), a factor of about 4 either way (SD 1.4 on the log scale). Traits barely narrow that (SD 1.27). The spread and skew of the curve vary just as much. So the shared prior is weak.
- **Ten records already pin a species' timing.** What they can't pin is the *shape* of the curve (how long the tail of late moths is). Pooling fixes the shape, which is why 0% of pooled fits hit the skew limit. The forecast dates depend mostly on timing, though, so they hardly change. The synthetic test in `test_pooled.py` shows the same thing: pooling improves the planted curve's 10/50/90% targets but not its median.
- **Heat beats the calendar when data are thin** (10 records: 8.2 vs 11.3 days off, about 3 days better, CI 2.0 to 4.2). Warmth carries information across years and latitudes that 10 dates can't. By about 50 records the calendar catches up, and with all records it pulls ahead on average.
- **Where heat does worst.** The worst species are many-brooded or long-flying moths with no clean first-brood split: *Argyrotaenia velutinana* 21 d vs 3 d calendar, *Dryocampa rubicunda*, *Paonias excaecata*, *Automeris io*. Also some species whose first flight may follow daylength more than warmth. Where heat does best, it clearly wins: *Phalaenophana pyramusalis* (3.9 vs 9.2 d), *Lymantria dispar*, *Trichodezia albovittata*, *Eubaphe mendica*, and luna.
- **Luna here vs P3.** Luna scores 6.7 d (heat) vs 8.0 d (calendar) in this run, worse than P3's 3.9 vs 7.3. This run differs from P3 in its data and scoring: adult-annotated, openly licensed records only; no year effect; flat model; a different calendar rule; and every band-year with ≥ 20 records scored. So the two numbers can't be compared directly.
- **Zero records doesn't work.** Forecasting a species from the shared prior alone is 19-21 days off. A species needs its own records.

## What it would take to add N species to the map

Census (`results/census.json`): Midwest moth species by research-grade, adult, openly licensed records 2015-2025, scaled by the 0.70 that survive cleaning and the 1 March-28 August window.

| Records after cleaning | ≥ 50 | ≥ 100 | ≥ 200 | ≥ 400 | ≥ 1,000 |
|---|---|---|---|---|---|
| Moth species (of ~2,000) | ~695 | ~485 | ~277 | ~129 | ~41 |

1. **A gate per species, not pooling, decides N.** Run this script's leave-one-year-out for every candidate. Show a species only where heat beats its own calendar. Here that was 21-22 of the 50 scored species with ≥ 400 records, about 40%. Applied to the ~129-277 species with ≥ 200-400 records, that suggests **roughly 50-110 species with an honest heat forecast**, before any hand review. That is well under the review's 150-250. The review's +350-450 from pooling is **not supported** by this test: pooling bought about 0.1-0.2 days.
2. **For data-poor species (25-100 records)** the heat model beats the calendar learned from the same records, but it is still 8 days off. That is a "roughly when" band, not a forecast worth a map layer.
3. **Hand review stays.** Migrants, moths that overwinter as adults, and indoor moths were left out by name before fitting (`fetch.py`). That list has to grow with N. The trait table (`traits.csv`) was typed from memory, is approximate and is unchecked. It doesn't help anyway, so it can be dropped.
4. **Cost.**
   - Downloads: about 3 minutes per 1,000 records at iNat's polite rate. The 52 species took about 40 minutes over two connections.
   - Daymet: already covers the region (597 res-4 hexes).
   - Fitting: leave-one-year-out took 68 minutes wall-clock for 52 species, on a 4-core box shared with other jobs. That is about 35 s per species per fold for the full fit.
   - Map: per-species replay files of luna's size (~270 KB) would need lazy loading per species, as fireflies already do.
5. **Better bets than pooling:** separate broods for many-brooded moths, a daylength-triggered model for species where heat loses, and a check on 2026 (the only season nothing here has seen).

## How it was done

- **Species** ([select.py](select.py), [species.csv](species.csv)):
  - Started from the most-recorded moths by research-grade, adult-annotated, CC0 / CC BY / CC BY-NC iNat records in WI IL MN IA MI IN OH, 2015-2025.
  - Left out 15 migrant, adult-overwintering or indoor species by name before fitting, then downloaded the top 80 that remained.
  - Kept species with ≥ 400 cleaned records by 28 Aug, a median sighting day of 10 May-24 Jul, and ≥ 70% of records in that window.
  - That left 52 species from 10 families: 57,500 records and 597 hexes. Raw downloads stay in `notebooks/data/` (gitignored).
- **Model** ([pooled.py](pooled.py)): P3's likelihood, imported unchanged from `pipeline/fit/model.py`:
  - skew-normal warmth targets;
  - base 10 °C from 1 March;
  - 7-day flight;
  - the state moth-effort background;
  - 1% contamination;
  - observer weights;
  - brood cut-offs per fold.

  No latitude, daylength or year term. Photoperiod sensitivity was not pooled, so that is untested.
- **Pooling, by empirical Bayes:**
  1. Fit each *other* species alone (posterior uncertainty by the Laplace approximation).
  2. Learn a shared Gaussian over (log median target, log spread, skew), optionally with the log median depending on traits (random-effects meta-analysis).
  3. Refit the target species with that Gaussian as its prior.

  The prior never sees the target species or the held-out year. numpyro/PyMC weren't installed, and empirical Bayes was enough to answer the question. A full Bayesian fit would mostly change the intervals, not these point forecasts.
- **Speed.** The skew-normal CDF is tabulated once over (z, skew), with error under 2e-5, and used by every arm, including P3's fitter.
- **Tests** ([test_pooled.py](test_pooled.py)): the reparametrised fit matches P3's fitter, and simulate-and-recover shows pooling improves curves planted from a shared distribution.

**Known weak spots.**
- The data-poor test subsamples data-rich species. Truly rare species may differ, for example in being spread more thinly or misidentified more often.
- Brood cut-offs and the hex weights that define each band-year come from the full training set in every arm, a small leak shared by all arms.
- The effort background includes the target species itself.
- 2015-2017 contribute few scored band-years.

## Rerun
```
python3 notebooks/pooled/fetch.py        # ~40-80 min of polite iNat calls + Daymet (cached in notebooks/data/)
python3 notebooks/pooled/select.py       # species.csv
python3 notebooks/pooled/census.py       # results/census.json
python3 notebooks/pooled/run.py          # ~1-2 h: results/rows.csv.gz, fits.csv.gz, params_all_years.csv, run.json
python3 notebooks/pooled/report.py       # results/summary.json, per_species.csv, figures/pooled_vs_n.png
python3 -m pytest notebooks/pooled       # ~2 min, no network
```
