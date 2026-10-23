# 2026 dry run (built 2026-10-23)

The nightly pipeline, run after the fact on the 2026 season with real PRISM weather up to an as-of date, then past
years' weather (no 7-day forecast: there is no archived one for spring 2026). The model never saw 2026 moths.

Rough check against 2026 first-brood sightings (research grade, exact location, median sighting day per latitude
strip vs the median forecast 50% day at those sightings' hexes; days of year; 2026 records pulled 23 Oct 2026):

| Strip | Sightings | Real peak | Forecast as of 15 May | Forecast as of 30 Sep | Typical year |
|---|---|---|---|---|---|
| 37-39 N | 50 | 128.5 | 114 (likely 107-118) | 114 | 135.5 |
| 39-41 N | 166 | 129 | 129 (121.5-134) | 129 | 144 |
| 41-43 N | 96 | 149 | 150 (143-155) | 148 | 154 |
| 43-45 N | 44 | 159.5 | 158 (150-163) | 155 | 159 |
| 45-49 N | 66 | 169.5 | 178 (167-183) | 174 | 175.5 |

Sighting-weighted miss: **3.4 days** for the 15 May forecast (3.1 with the whole season's weather), against **8.9**
for the typical-year forecast. Four of five strips land inside the "likely" range; the southern strip is the big
miss (forecast about two weeks early). Caveats: this is a quick median comparison, not the effort-corrected
band-year score P3 uses; 2026 records are still arriving (posting lag), and 2026 Daymet (the model's own weather
source) is not out until mid-2027. Treat it as a smoke test that the pipeline is sane, not as a score.
