# More species: one list, one recipe

Species beyond the luna moth and the firefly (which keeps its own scripts in `pipeline/firefly`) are listed once in
`__init__.py` and built by the same three scripts. Each is the firefly's recipe: luna's P3 model (`pipeline/fit`),
one generation a year (every strip's window runs 1 March to day 240), no latitude term (`p3_flat`), and an effort
background of the species' own group with the species itself left out.

```
python3 pipeline/species/fetch.py japanese-beetle        # iNat records, effort, Daymet (cached in notebooks/data/)
python3 pipeline/species/build.py japanese-beetle        # leave-one-year-out fits, scores -> public/species/<key>/replay.json
python3 pipeline/species/build_fine.py japanese-beetle   # res-5 hexes -> public/species/<key>/fine/ (checks res 4 first)
```

`build.py <key> --score-only` prints the scores without writing anything. `<key>.result.json` holds the
leave-one-year-out and holdout tables, the noise floor and the per-fold parameters that `build_fine.py` reuses.

Adding a species to the map: an entry in `__init__.py`, the three scripts, then a `SpeciesConfig` in
`src/species/<key>.ts` (its words, dot colour and sketch) and one line in `src/species.ts`.

**Every fit here is exploratory.** Nothing was written down before scoring, unlike luna's P3. The app says "first try"
next to every number.

## The species check (October 2026): why the Japanese beetle

Three candidates, research-grade iNaturalist records in the 7 states, 2015-2025, each scored leave-one-year-out
(days off, onset and peak averaged, per latitude strip and year with at least 20 records):

| Species | Records | Strip-years | Heat model | Usual date | IL/IN/OH -> WI/MN holdout (heat vs usual date) |
|---|---|---|---|---|---|
| Giant burrowing mayfly (*Hexagenia limbata*) | 392 | too few | not fit | | |
| Cecropia moth (*Hyalophora cecropia*) | 1,210 fit | 26 | 5.94 | 6.32 | 7.94 vs 4.86 (10 strip-years) |
| **Japanese beetle (*Popillia japonica*)** | 11,217 fit | 44 | **2.85** | 3.81 | 3.38 vs 4.30 (25 strip-years) |

- **Mayfly:** the most famous Midwest hatch, but only 392 research-grade records in eleven years (466 for the whole
  genus), too few to score most strip-years, and its hatch follows
  water temperature, which Daymet's air temperatures stand in for poorly.
  Worth revisiting with radar (the swarms show up on weather radar).
- **Cecropia:** a giant silk moth like the luna, but the heat model barely beats the calendar and loses the holdout.
- **Japanese beetle:** the heat model beats the calendar by a quarter (2.85 against 3.81 days off, and 4.34 for luna's
  first, simpler model) and also wins the holdout that luna's own model failed (3.38 against 4.30, or 4.07 for a
  latitude-adjusted calendar). Its emergence is the textbook degree-day case, it has by far the most records, and the
  story suits a conservation-minded reader: an invasive beetle whose timing lets gardeners hand-pick the first ones
  instead of spraying. It loses to the calendar only in the southernmost strip (37-39°N: 5.5 against 4.7 days, 7
  years), which the app says. Half come out after about 950 degree-days (°C above 10 from 1 March).

The noise floor (how far off a perfect forecaster would be, given how few sightings a strip-year has) is 1.6 days
for the beetle.
