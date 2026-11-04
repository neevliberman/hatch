# Place features that travel: result (4 Nov 2026)

**Gate: FAIL, on the in-region check only.** Describing a place by its environment (warmth, winter cold, rain,
elevation, land cover, plus summer day length) instead of its lat/lng made the Atlas much better in states it never
saw: it beat the calendar for **71% of species instead of 52%**, and did better in all three held-out regions. But
in the states it trained on, its all-records score for an unseen year dropped by 0.037 nats per record, and the
pre-registered allowance was 0.02. The rule says all five checks must pass, so lat/lng stays. Rules:
[PREREG_PLACE.md](PREREG_PLACE.md), committed before any data was pulled or any model trained. Numbers:
`results/place/full/gate.json`, `results/place/full/per_species.csv`.

## The five checks (E+P, the one pre-registered candidate, against L, today's lat/lng input)

| # | Check | L (lat/lng) | E+P (env + day length) | Bar | Pass? |
|---|---|---|---|---|---|
| 1 | Unseen regions: species beating the calendar, 3 folds pooled | 844 of 1,630 (**51.8%**, CI 49-54%) | 1,152 of 1,630 (**70.7%**, CI 68-73%) | >= L + 5.0 pts | yes (+18.9) |
| 2 | Better than L in at least 2 of 3 folds | | better in 3 of 3 | 2 of 3 | yes |
| 3 | Unseen regions, all records: log-likelihood per record | −5.666 | **−5.544** | > L | yes |
| 4 | Unseen regions, median days error (onset + peak) | 4.93 d | **4.45 d** | <= L + 1.0 d | yes |
| 5a | In-region, unseen year (2025): species beating the calendar | 97.3% | 97.8% | >= L − 3.0 pts | yes |
| 5b | In-region, unseen year: log-likelihood per record | **−5.323** | −5.360 (−0.037) | >= L − 0.02 | **no** |

The calendar scores −5.813 on the unseen regions (median days error 5.75 d) and −5.604 in-region (4.63 d).

## By fold (region = the held-out states, all years 2015-2025)

| Fold (held out) | L | E (env only) | E+P | Calendar days error | L days | E+P days |
|---|---|---|---|---|---|---|
| N: Wisconsin + Minnesota | 391/554 (70.6%) | 405/554 (73.1%) | **417/554 (75.3%)** | 5.20 | 4.73 | 4.10 |
| E: Michigan + Ohio | 227/527 (43.1%) | 311/527 (59.0%) | **319/527 (60.5%)** | 5.38 | 4.51 | 3.71 |
| S: Missouri + Kentucky | 226/549 (41.2%) | 405/549 (73.8%) | **416/549 (75.8%)** | 6.82 | 5.69 | 5.62 |
| **Pooled** | 51.8% | 68.8% | **70.7%** | 5.75 | 4.93 | 4.45 |
| In-region 2025 (pooled), species won | 97.3% | 97.5% | 97.8% | | | |
| In-region 2025, log-lik per record | **−5.323** | −5.362 | −5.360 | | | |

E (environment only, no latitude at all) is exploratory and could not pass by itself; it does almost as well as
E+P, so most of the gain is from the environment, and day length adds about two points.

## In plain words
- **The idea works where it was meant to.** Lat/lng lets the network memorise "this grid square, this week". In a
  state it has never seen, that memory is wrong, and in Michigan/Ohio and Missouri/Kentucky lat/lng did *worse* than
  a plain calendar for most species (41-43% wins). Describing places by what they are like turned those into 60-76%
  wins, and cut the date error by about half a day overall (0.8 days in Michigan/Ohio).
- **It costs a little at home.** In the states it trained on, E+P still beats the calendar for 98% of species, but
  head to head against lat/lng on 2025 it is better for only 21% of species, and its all-records score is 0.037 nats
  worse. The likely reason (not tested here): env features are one value per ~45 km cell, while lat/lng gives each
  record's exact spot, so lat/lng can learn finer local detail where it has data.
- **Verdict: keep lat/lng in the shipped Atlas.** The pre-registered rule allowed 0.02 nats of in-region loss and
  E+P lost 0.037. Nothing changes on the site.

## Deviations from the frozen Atlas and from the prereg (all applied to every variant alike)
- **6 passes, not 10.** One pass over 1.7 M records took 3.4 min, so 9 networks at 10 passes would not fit the
  session; the run switched to the prereg's pre-declared fallback (6 passes for all variants) about 3 minutes into
  the first network, before any result existed. The partly trained 10-pass network was discarded unscored.
- **Warmth from PRISM (RCC-ACIS), not Daymet** (Daymet's TLS chain fails verification here), as stated in the
  prereg. 273 of 1,217 grid cells (Ontario, open water) borrow the nearest PRISM cell's weather.
- **Records re-pulled 4 Nov 2026** (2.92 M, 2.55 M after the burst filter), not the 27 Oct snapshot.
- **Sanity check against the frozen gate.** Fold N's lat/lng model won 70.6% of species in WI/MN, against the frozen
  gate's 59%. Same idea, but a different data snapshot, PRISM warmth, half the passes, and a calendar fit on
  2015-2024 here; this run can't say which of these explains the gap. The comparison that matters, L vs E+P, is
  like-for-like within this run.
- One seed per network; no estimate of seed noise. The region gain (+19 points, every fold) is far larger than seed
  noise is likely to be; the in-region miss (0.037 against a 0.02 bar) is not that far from the line.

## What next (not done here; any of it needs its own pre-registered gate)
- **Finer environment** (resolution-6 cells, ~7 km), or env features plus a *coarse* within-region offset, to win
  back the in-region loss without memorising the grid.
- A fresh test season (2026) or a region outside the box (e.g. the Northeast) before any site change.

## Reproduce
```
python3 pipeline/atlas/fetch_gbif.py          # records (~1 h; resumable)
python3 pipeline/atlas/place_env.py           # PRISM warmth.npz + env features (~1-2 h of ACIS calls; cached)
python3 pipeline/atlas/place_gate.py --epochs 6   # 9 networks, ~3.3 h on 4 cores; resumable
python3 pipeline/atlas/place_gate.py --summary    # gate.json + per_species.csv from the saved runs
```
Feature sources: PRISM daily via RCC-ACIS (Tmin, Tmax, precipitation), Open-Meteo elevation API (Copernicus DEM
90 m), ESA WorldCover 2021 v200 (CC BY 4.0, read from its cloud-optimised GeoTIFF overviews).
