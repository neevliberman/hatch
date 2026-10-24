# Does the "likely" window catch the real date? (2026-10-24)

A hexagon's card says "busiest day likely X to Y". That window is meant to catch the real date 8 times in 10.
This note checks how often it does. Script: [`calibration.py`](calibration.py). Numbers: [`results/calibration.json`](results/calibration.json).
No refit, and the forecast model (P3) is unchanged.

**Answer.** Close to 8 in 10 everywhere it can be checked fairly. None of the checks is clearly off, so the
window's width was **not changed**. With 23 to 31 checks per case, the true rate could be anywhere from about 60%
to 90%. With five checks for 2026, it could be 34% to 99%. These ranges treat strip-years as independent; strips in one year share weather and model, so the real ranges are somewhat wider.

| What is checked | Inside the window | Share | 90% range |
|---|---|---|---|
| Luna peak, past years (each year sized without itself) | 25 of 31 strip-years | 81% | 65-91% |
| Luna onset, past years | 24 of 31 | 77% | 62-89% |
| Firefly peak, past years | 18 of 23 | 78% | 60-91% |
| Firefly onset, past years | 17 of 23 | 74% | 55-88% |
| Luna peak, 2026 rerun (live window, weather to 15 May) | 4 of 5 strips | 80% | 34-99% |

"90% range" is a Clopper-Pearson binomial interval. The rule was: if 80% falls outside it, the width is wrong
and gets fixed. 80% is inside every range above.

## How the window is made
- **Past years (replay).** The window is the forecast plus the 10th to 90th percentile of every scored strip-year's
  miss (real minus forecast). Luna: peak −6 to +4 days, onset −5.1 to +6. Firefly: peak −5.4 to +5, onset −4.8 to +4.8.
  A strip-year is one latitude strip (37-39 °N and so on) in one year with at least 20 first-wave records.
- **Live season.** 121 forecasts per hexagon (11 leave-one-year-out fits × 11 past years' weather for the rest of
  the season). The window is the 10th to 90th percentile of every forecast plus every past miss
  (`pipeline/live/build_live.py`, `ensemble_summary`).

## (a) Past years, without peeking
The shipped window is sized from all 31 luna strip-years, including the one being scored. So scoring it on those
same strip-years is partly marking your own homework. It catches 25 of 31 luna peaks that way (the same when rounded to
whole days, as the card shows it).

The fair version works like a split exam. To score year Y, size the window from the misses of **the other scored
years only** (8 of the 9), then check year Y's strips against it. Repeat for every year. This is a leave-one-year-out check (conformal in spirit; it uses interpolated percentiles, not the exact order-statistic rule): it never
uses a fold's own miss to size the window that scores it. The windows it builds are 7 to 12 days wide (10 to 11 for
peaks), about the same as the shipped ones. Results are in the table above.

One small leak is left. The miss for year Z comes from a model fitted on every year except Z, and that includes
year Y. A fully nested check would refit 110 models. The leak only touches how the 10 other misses were made, not
the window's size, so it is small.

The misses are balanced: luna peaks fell 3 times before the window and 3 times after; firefly peaks 3 before, 2 after.

**No fix applied.** Because 80% sits inside every interval, a conformal rescaling would be fitting noise. For
the record: the fair luna peak check already *is* the conformal window, and it gives the same 25 of 31.

## (b) The 2026 dry run
The live pipeline was rerun for 2026 with real PRISM weather only up to an as-of date, then past years' weather.
No 7-day forecast was used, and the model never saw 2026 moths. The "real peak" is the median day of 2026
first-wave sightings in a strip (research grade, exact location, one per observer, hexagon and day, the P3
filters; strip cut-offs from the replay; pulled 24 Oct 2026). The strip's window is the median, over those sightings, of
each sighting's hexagon window. This is the comparison `DRYRUN_2026.md` uses. There are now 558 strip records,
against 422 then, because records are still arriving, and the real peaks moved by at most 1 day.

| As of | 37-39 °N (real 129) | 39-41 (130) | 41-43 (149) | 43-45 (158.5) | 45-49 (169.5) | Caught | Mean width |
|---|---|---|---|---|---|---|---|
| 15 Apr | 108-122 ✗ | 122-143 | 143-155 | 150-163 | 166-182 | 4 of 5 | 15.2 d |
| 1 May | 106-118 ✗ | 116-132 | 140-154 | 149-162 | 166-181 | 4 of 5 | 14.0 d |
| 15 May | 107-118 ✗ | 124-136 | 143-155 | 150-163 | 167-183 | 4 of 5 | 12.8 d |
| 1 Jun | 107-118 ✗ | 124-136 | 142-153 | 149-160 | 167-181 | 4 of 5 | 11.8 d |
| 15 Jun | 107-118 ✗ | 124-136 | 142-153 | 149-160 | 165-176 | 4 of 5 | 11.2 d |
| 30 Sep (the shipped file) | 107-118 ✗ | 124-136 | 142-153 | 149-160 | 168-179 | 4 of 5 | 11.2 d |

Days of year. The window narrows as real weather comes in, as it should. The one miss is the same at every date:
in the far south the forecast is about two weeks early, 11 days past the window's edge. That is a forecast problem
(already noted in DRYRUN_2026.md), not a width problem. Widening every window to catch it would make the
other four needlessly wide. Five strips from one season can't tell 80% from 60% or 95%. The app quotes the
15 May run, a real forecast for the three northern strips, which had not peaked yet.

The rows are not five independent checks of the window over time. They are the same five strips, re-forecast.

## A single hexagon (secondary, and why it is not used to resize)
The card shows the window for one hexagon, but it is sized from whole-strip misses. For hexagon-years with at least
10 first-wave sightings, the hexagon's median sighting day fell inside its own window:
- luna, past years: 3 of 5 (the openly licensed sightings shipped in the app);
- firefly, past years: 7 of 17 (41%, 90% range 21-64%: clearly below 80%);
- luna 2026: 4 of 10 (90% range 15-70%: also clearly below 80%).

Much of that is the target, not the forecast. With 10 to 30 photos, a hexagon's median day itself wobbles by 3.4 to
7.9 days (bootstrap SD, median over hexagons). A strip's wobbles by about 3.4. Widening the card's window to cover
how few people happened to photograph one spot would make it describe the photos, not the moths. So the app keeps
the strip-sized window and says plainly that one spot can miss by more.

## What the app now says
- **"How sure?"** (both species, shared wording, each species' own numbers from `interval.checked` in its replay
  file): "a card's "likely" dates caught the real peak in 25 of 31 strip-years it never saw. The aim is 8 in 10; so few
  checks fit anything from 65 to 91%." (Firefly: 18 of 23, 60-91%.) In live mode: the 2026 rerun's 4 of 5.
- **Fine print:** the replay window bullet adds "Sized without the year being checked, it caught 25 of 31." (18 of 23
  for fireflies). The live bullet used to say the window *leaves out* the model's past misses. It doesn't: it adds them.
  It now says so and quotes the 2026 rerun.

## Reproduce
```
python3 pipeline/live/build_live.py --season 2026 --as-of 2026-05-15 --no-forecast --out /tmp/asof_0515.json  # and 04-15, 05-01, 06-01, 06-15
python3 pipeline/fit/calibration.py --write-replay --live /tmp/asof_0415.json /tmp/asof_0501.json /tmp/asof_0515.json \
    /tmp/asof_0601.json /tmp/asof_0615.json public/live/latest.json
python3 -m pytest pipeline/fit/tests/test_calibration.py
```
The first live run downloads Daymet 2015-2025 for 551 hexagons (cached in `notebooks/data/`, gitignored).
`calibration.py` downloads the 2026 luna records once (~8 iNat pages, also cached there). `--write-replay` writes
`interval.checked` into `src/data/luna-replay.json` and `public/firefly-replay.json`. `build_replay.py` and
`build_firefly.py` write the same field when they rebuild, with luna's 2026 line from `results/calibration.json`.
