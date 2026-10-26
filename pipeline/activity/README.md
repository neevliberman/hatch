# Night activity ("Moths tonight: busy")

One line on the live hex card: is tonight slow, typical or busy for moths, from the weather. Rules for shipping were
written first in [PLAN.md](PLAN.md); numbers are in `results/headline.json`.

Analogy: the season curve is a tide table (this date, this place, this many people out: this many sightings is
normal). Weather says how far above or below the table tonight runs.

## Result (11 metro boxes, 2017-2025, each year held out in turn)
| Group | Years weather beat the date alone | Top third vs bottom third | Ships |
|---|---|---|---|
| Moths | 8 of 9 | 1.56x (90% range 1.41 to 1.63, resampling the 9 years) | yes |
| Butterflies | 5 of 9 | 1.35x | no (fails the 8-of-9 rule) |
| Fireflies | 5 of 9 | 1.24x (range 1.07 to 1.37) | no (5 of 9 years, lift under 1.25; most box-days have 0 or 1 sighting) |

What matters for moths: warmth (peaks near 18-20 C overnight lows, falling off above), calm air, a darker moon.
Humidity, cloud and rain add little once those are in. Busy nights log about 1.6x the sightings of slow nights of the
same week and place.

## What it is not
- Not a count of moths. The model predicts the moth share of all sightings logged that day in the box, which removes
  weekends, holidays and the growth of iNaturalist (so "1.6x" means moth share, not raw sightings). A warm night
  also sends more people out; read it as "a good night to look".
- Only checked on weather as it happened (Open-Meteo archive), never on a forecast. The card therefore calls only
  tonight and tomorrow and says so under More. Forecast checking needs archived day-ahead runs (Open-Meteo's
  historical-forecast archive holds near-nowcast values, so it would not answer this either); the nightly file
  archives its own calls from now on, which would let a later check be honest.
- Night-to-date mapping is approximate: a night's weather (21:00 to 04:59) is matched to sightings dated that
  evening; moths photographed after midnight are dated the next day.
- The slow / typical / busy marks are the 1/3 and 2/3 points of the same years the model was fitted on, so they
  are slightly in-sample (edge weeks have about 18 nights per box).
- Moths as a whole, not luna alone (too few luna records). Shown on luna's card only, May to mid-October.
- 11 of the 14 planned boxes (PLAN.md says 14): Columbus, Cleveland and Cincinnati hit the weather API's daily cap.
  `ACTIVITY_REGIONS=a,b,c` limits any step to those boxes; `fetch` resumes where it stopped. Fill-in forecast points
  borrow the nearest fitted box's marks.

## Run
```
pip install statsmodels patsy scipy           # research only; the nightly job needs just numpy and pandas
python3 -m pipeline.activity.fetch            # cache in notebooks/data/activity (resumable; the weather API throttles)
python3 -m pipeline.activity.evaluate         # the leave-one-year-out test, writes results/headline.json
python3 -m pipeline.activity.ship             # fit on everything, writes moth_static.json (coefficients, per-week marks)
python3 -m pytest pipeline/activity
```
Nightly: `build_live.py` calls `live.build`, which adds `activity` to `live/latest.json` (2 nights x about 38 places,
under 1 KB; a night with missing hours is `null`, never shifted). If anything fails the block is simply absent.
