# P3: the fit

Code for Hatch's luna moth model (first brood, US Midwest). Rules: [FROZEN_P3.md](FROZEN_P3.md), written before scoring.
Result: [RESULT.md](RESULT.md). Numbers: `results/headline.json` (P3 run 2, the map's model). P3.1, the amendment in FROZEN_P3.md, is in `results/p3_1/`: it tied P3 on past years but did worse on the 2026 season, so the map stays on P3.

## Run
From the repo root (Python 3.13, `pip install -r notebooks/requirements.txt`):
```
python3 -m pytest pipeline/fit                    # no network; includes simulate-and-recover and a timezone test
python3 pipeline/replay/build_replay.py           # once: downloads iNat + Daymet into notebooks/data/ (gitignored)
python3 pipeline/fit/run_p3.py --boot-refits 60   # P3 as pre-registered; about an hour on 4 cores; writes results/ and figures/
python3 pipeline/fit/run_p3.py --model p31_flat --compare p3_photo p3_flat --out results/p3_1   # P3.1 (~40 min); not the map's model
python3 pipeline/replay/build_replay.py           # refits the leave-one-year-out models, checks headline.json, writes src/data/luna-replay.json
```
`run_p3.py` also downloads the moth effort background (77 iNat histogram calls, 1 s apart, cached).

## Files
| File | What it does |
|---|---|
| `data.py` | records (P1's frozen filters), state lookup, daylength, effort background |
| `context.py` | loads records + Daymet degree-days + effort into one object |
| `model.py` | the curve, the likelihood, the fitter, predictions |
| `evaluate.py` | per-fold brood cut-offs, targets, baselines, scores, noise floor, bootstrap |
| `simulate.py` | a fake Midwest for simulate-and-recover |
| `run_p3.py` | the one pre-registered run |
| `figures.py` | the PNGs in `figures/` |
| `calibration.py` | how often the "likely" window catches the real date ([CALIBRATION.md](CALIBRATION.md)) |

## The likelihood, in plain words
Think of each spot as having a **warmth bank account**. From 1 March, every day pays in its degree-days: the warmth above 10 °C, capped at 30 °C.

1. **Each moth has its own savings target.** Targets are spread along a lopsided curve (skew-normal): a firm lower edge, then a long tail of moths that need more warmth. The curve has a location, a spread and a skew.
2. **A moth flies for about a week once it hits its target.** So the share of a spot's moths in the air on day *t* is "reached the target by *t*" minus "reached it by *t* − 7".
3. **Sightings need moths *and* people.** The chance that a sighting lands on day *t* is the flying share × how many moths (any species except butterflies) people logged in that state that day. That second number is the *effort background*. It soaks up weekends, Moth Week and bioblitzes, and the growth of iNaturalist itself. A 1% "anything goes" term absorbs the odd stray record.
4. **Only the first brood counts.** The window runs from 1 March to that latitude band's brood cut-off, worked out from the training years alone.
5. **The north/south question.** The target's location can slide with latitude (one slope). The alternative is that daylength speeds development: each day's degree-days are multiplied by (daylength/12 h)^γ. The two were compared on held-out IL/IN/OH data, and the better one (daylength) is used. On past years neither term helps much; P3.1 drops it, but the 2026 season favoured keeping it (RESULT.md).
6. **Years differ a little** beyond what temperature explains. Each training year gets a small, shrunk nudge to the target. A year the model has never seen gets no nudge.
7. **No observer dominates.** Each record counts 1/√(its observer's record count).
8. **No negative targets (P3.1 only, not the map's model).** The curve's location and skew can't go below 0, so the (conditioned) median target is above 0 degree-days.

The fitter picks the curve that makes the real sighting days most likely. Then, for any spot and year, it reads the bank account forward and says when 5/25/50/75/95% of the season's moth-flying days have happened. Those are the map's colours.

**Why trust the fitter?** `tests/test_model.py` plants known values in a fake Midwest (made-up temperatures, a weekend effort rhythm), draws fake sightings from the model, and checks that the fit finds the plant again. It recovers a −12 DD/° latitude slope to within ±1 and the median target to within 6 DD.
