# Southern heat clock, 2026-27: the rule, written before the season (2026-10-26)

**Why.** Hatch is meant to work in new regions. In the East a local heat clock beat each place's calendar by about
1.6 days on past data ([../league/tryouts/REGIONAL_RESULT.md](../league/tryouts/REGIONAL_RESULT.md)). Australia is in
spring now, so a southern species gives a real scored season in a new hemisphere this winter, before the March 2027
Midwest start. The species is **Christmas beetles** (*Anoplognathus*, research-grade iNaturalist records): about 2.4k a
year since 2022, a season from October to January.

**What runs.** Every night from 1 July 2026 to 22 February 2027 (`south.py`, the south-forecast workflow): the clock
frozen in `south_static.json` forecasts the onset (10% of records) and peak (median) for each of its 19 cells (2° × 2°,
each with 3+ seasons of 20+ records in 2018-2025), on Open-Meteo archive weather to three days before, the 7-day
forecast, then each 2018-2025 season as an ending. Warmth = degree-days above base 6 °C (daily mean of min and max, each
capped at 30 °C) since 1 July. Only the dates are kept, sealed per night in `archive_south/2026/`. Nothing appears
on the map.

**Grading.** Weekly, once a cell has 20+ records. The real onset and peak are the cell's 10th percentile and median
of research-grade records (day 60-260 after 1 July, posted by that Monday). The forecast is the newest sealed one issued
at least 7 days before the real date. The rival is the cell's calendar (mean past onset and peak, frozen in the file).
A cell whose real onset comes before the first sealed forecast is 7 days old is not scored, for either side. Each week's
records pull is kept with its sha256 (`records/2026/south/`).

**The verdict** (week of Monday 15 February 2027; later records never count):
- D = record-weighted mean miss (mean of onset and peak miss) of the clock minus the calendar.
- Fewer than **8** scored cells or **800** records: no verdict.
- D ≤ **−1.0** day and the clock has the strictly lower miss in **at least half** of the scored cells: the clock works
  in a new region. Otherwise the calendar stays, which means the clock did not prove itself, not that it is worse.
- Reported beside it, never deciding: the unweighted cell mean D and a 95% interval resampling cells. One season shares
  one year's weather, so a pass is one good year.
- The frozen file and these numbers do not change after 1 July 2026. No retries.

**Frozen.** `south_static.json` sha256 prefix: `a538f1160c90` (19 cells, 8,360 records, built by `build_south.py`).
`test_south.py` holds the file and the rule's numbers to this text.

**Rehearsal** (`rehearse_south.py`; for each of 2022-2025 the file is rebuilt without that season, then sealed nightly
1 Oct - 15 Feb on archive weather to three days before, no 7-day forecast, and graded as above):

| Held-out season | Cells | Records | Clock miss | Calendar miss | D | Cells won |
|---|---|---|---|---|---|---|
| 2022 | 14 | 1,426 | 6.0 | 13.2 | −7.2 | 12 |
| 2023 | 15 | 1,657 | 7.4 | 6.1 | +1.3 | 5 |
| 2024 | 15 | 2,054 | 5.0 | 10.7 | −5.7 | 13 |
| 2025 | 15 | 2,069 | 8.6 | 9.0 | −0.4 | 8 |

Two seasons clear the bar clearly, one fails, one is a tie: the clock helps most when the year runs far from normal
and loses in a normal one, as in the East. Misses of 5-9 days are twice luna's, because beetle emergence also follows
rain and observer effort. Caveats: each fold is trained on the other three seasons, including later ones; the clock's
base (6 °C) was picked from a 0-12 °C sweep on all seasons together, though the gain was flat from 0 to 6 °C
(`rehearsal_*.json` hold the rows).

**What this does not test.** The Midwest map (its 2027 test is [../fit/PREREG_2027.md](../fit/PREREG_2027.md)) or any
species other than Christmas beetles.
