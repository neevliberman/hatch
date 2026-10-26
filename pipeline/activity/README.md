# Night activity ("Moths tonight: busy")

One line on the live hex card: is tonight slow, typical or busy for moths, from the weather. Rules for shipping were
written first in [PLAN.md](PLAN.md); numbers are in `results/headline.json`.

Analogy: the season curve is a tide table (this date, this place, this many people out: this many sightings is
normal). Weather says how far above or below the table tonight runs.

## Result (11 metro boxes, 2017-2025, each year held out in turn)
| Group | Years weather beat the date alone | Top third vs bottom third | Ships |
|---|---|---|---|
| Moths | 8 of 9 | 1.56x (90% range 1.46 to 1.64) | yes |
| Butterflies | 5 of 9 | 1.35x | no (fails the 8-of-9 rule) |
| Fireflies | 5 of 9 | 1.25x | no (too few sightings per box-day) |

What matters for moths: warmth (peaks near 18-20 C overnight lows, falling off above), calm air, a darker moon.
Humidity, cloud and rain add little once those are in. Busy nights log about 1.6x the sightings of slow nights of the
same week and place.

## What it is not
- It is sightings people log, not how many moths exist. The model divides by how many sightings of anything were
  logged that day in the box, which removes weekends, holidays and the growth of iNaturalist, but a warm night also
  sends more people out. Read it as "a good night to look".
- Validated on weather as it happened (Open-Meteo archive). The live line uses the forecast; see `forecastcheck.py`.
- Moths as a whole, not luna alone (too few luna records). Shown on luna's card only, May to mid-October.
- Three of the 14 boxes (Columbus, Cleveland, Cincinnati) were not downloaded before the weather API's daily cap;
  `fetch.py` resumes where it stopped. Fill-in forecast points borrow the nearest box's "typical night" marks.

## Run
```
pip install statsmodels patsy scipy           # research only; the nightly job needs just numpy and pandas
python3 -m pipeline.activity.fetch            # cache in notebooks/data/activity (resumable; the weather API throttles)
python3 -m pipeline.activity.evaluate         # the leave-one-year-out test, writes results/headline.json
python3 -m pipeline.activity.ship             # fit on everything, writes moth_static.json (coefficients, per-week marks)
python3 -m pytest pipeline/activity
```
Nightly: `build_live.py` calls `live.build`, which adds `activity` to `live/latest.json` (4 nights x about 38 places,
under 1 KB). If anything fails the block is simply absent.
