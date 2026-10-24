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

## P3.1 on the same season (added 2026-10-23)
The same run with the P3.1 fold fits (no daylength term, targets at or above zero; `pipeline/fit/RESULT.md`), as of
30 Sep. P3.1 tied P3 on past years, so this season was the tie-breaker. It is worse in every summary we tried:

| Summary (sighting-weighted over the 5 strips) | P3 (the map's model) | P3.1 |
|---|---|---|
| Median forecast at sightings' hexes vs real median (the table above) | 3.1 d | 6.9 d |
| Mean forecast at sightings' hexes vs real median | 2.2 d | 4.8 d |
| Median of (sighting day minus its hex's forecast) | 2.1 d | 4.4 d |

P3.1 runs earlier in the south (37-41 N, about 3 to 7 days) and later in the north (45-49 N, about 2 days), the
lean the daylength term was there to remove. As of 15 May P3.1 scored 4.7 to 7.0 d (P3: 3.4 on the first summary).
So the map and the live pipeline stay on P3. The first summary jumps when a strip's median switches hexes, so the
other two are steadier.


## Rebuilt 2026-10-24 for the scorecard
`public/live/latest.json` was rebuilt as of 30 Sep with the model hash and strip dates the scorecard needs. PRISM
had revised some 2026 days since the 23 Oct build (up to about 30 degree-days banked at a hex by 30 Sep), which moved
about 1 in 5 hex dates, most by a day or two (at most 10). The tables above are from the 23 Oct build. The proper
week-by-week score of this season is in `SCORECARD_2026.md`.
