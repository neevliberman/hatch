# 2026 dry run (built 2026-10-23)

The nightly pipeline, run after the fact on the 2026 season with real PRISM weather up to an as-of date, then past
years' weather (no 7-day forecast: there is no archived one for spring 2026). The model never saw 2026 moths.

Rough check against 2026 first-brood sightings (research grade, exact location, median sighting day per latitude
strip vs the median forecast 50% day at those sightings' hexes; days of year):

| Strip | Sightings | Real peak | Forecast as of 15 May | Forecast as of 30 Sep | Typical year |
|---|---|---|---|---|---|
| 37-39 N | 58 | 131 | 114 (range 107-118) | 114 | 135 |
| 39-41 N | 178 | 129 | 129 (121-133) | 128 | 144 |
| 41-43 N | 114 | 149 | 150 (143-155) | 148 | 154 |
| 43-45 N | 51 | 161 | 158 (150-163) | 156 | 159 |
| 45-49 N | 72 | 170.5 | 178 (167-183) | 174 | 175.5 |

Sighting-weighted miss: **3.8 days** for the 15 May forecast, against **8.3** for the typical-year forecast.
The southern strip is the big miss (forecast 17 days early). Caveats: this is a quick median comparison, not the
effort-corrected band-year score P3 uses; 2026 records are still arriving (posting lag), and 2026 Daymet (the
model's own weather source) is not out until mid-2027. Treat it as a smoke test that the pipeline is sane, not as a
score.
