# Why is the far south forecast two weeks early in 2026? (2026-10-24)

The 2026 dry run, the calibration rerun and the scorecard all found the same miss: in the southern strip
(37-39 °N: southern Illinois, Indiana and Ohio) the forecast put the first-wave peak around 25 April (day 116), and
the real peak was 10 May (day 130). The usual date (15 May) did better there. This note tests the likely causes one
by one. Nothing here refits the frozen P3 model or changes the map.

**Answer.** The miss is specific to 2026, and the most likely cause is that **the 2026 spring in the far south was
far warmer than anything the model was fitted on**, and the moths did not keep pace with the extra warmth. By
15 April the strip had banked 252 degree-days; the warmest of the 11 fitted springs had 144. Every one of the 63
southern 2026 records came from a place that was warmer by mid-April than any place and year behind any record the
model learned from. Where 2026 stayed inside that range, the forecast was right; in the hottest places (southern
Illinois and Indiana) it was about three weeks early. The other candidates add up to a few days at most.

## The candidates, with numbers

All dates are days of the year (day 116 = 26 April, day 130 = 10 May). "Forecast" is the strip's peak (the day half
its expected first-wave sightings are in) from the live pipeline's own code; for 2015-2025 each year uses the fit
that left that year out, exactly as the replay. Records: research grade, the fit's filters, first wave only.

| Candidate | What was checked | Result | Share of the 14-day miss |
|---|---|---|---|
| **Specific to 2026?** | The same strip in the leave-one-year-out years (Daymet weather, 5 scored years) | Peak off by −5.5, +3, 0, +9, −4 days (2021-2025, the replay's scores), average +0.5 (slightly late). Onset average −0.1. 2026: peak −14, onset −1.4 (same summary, whole season's weather). | Only 2026 |
| Few records, one metro | 2026 strip: 65 records, 63 people, 21 hexagons; biggest hexagon 16 records (25%), in Ohio, where the forecast was right | Dropping that hexagon makes the real peak later (135), not earlier. Resampling people, the real peak could be 116 to 136 (SD 5 days). | Noise could hide up to about 5 days; concentration none |
| Second brood mixed into the first wave | Strip cut-off is day 177 (26 June). 2026 records by 10-day bin show a clear gap at days 158-172 and the second wave peaking at days 190-210 | Only 3 of the 65 first-wave records fall after day 157. Cutting at day 150 moves the real peak from 130 to 128. | At most 2 days |
| Daylength (photoperiod) term | Same folds with the no-daylength fits (`p3_flat`) | Forecast 112 instead of 116: four days *earlier*. The term already pulls the south later. | None (it helps) |
| PRISM instead of Daymet | 2023-2025 run both ways (2026 Daymet is not out yet) | PRISM-based peak 1 to 2 days earlier than Daymet-based (138 vs 140, 126 vs 127, 132 vs 134); with the PRISM date fix below, 1.3 days on average | About 1.5 days |
| Strip weighting by openly licensed sightings | Weight hexagons by all 2015-2025 records (any licence), or by 2026's own record hexagons | 115 either way, against 116 | About 1 day |
| When people go looking (effort) | 2026 moth records, April vs May, against the typical-year shape the model uses | April was busier than usual (Illinois 0.56 vs 0.46, Indiana 0.82 vs 0.57, Ohio 0.73 vs 0.47 April-to-May ratio). That would pull sightings *earlier*. | None |
| **Beyond the fit's temperature range** | Degree-days banked by 15 and 30 April, 2026 vs the fitted years; forecast error by how warm each place was | Strip by 15 April: 252 degree-days vs 54-144 in 2015-2025; by 30 April: 364 vs 99-253. The warmest place-year behind any fitted record had 197 by 15 April; all 63 hexagon-matched southern 2026 records were above that. Across 2026's three southern strips (37-43 °N), records from places with 200-250 by 15 April came about 5 days after their hexagon's forecast (median); above 250, about 23 days after. Past records in every warmth band: −4 to +3.5 days. The southern hexagons' forecast peaks (days 108-114) are earlier than any past record hexagon's (119 or later). | **Most of it** |

## What the 2026 moths did

The southern strip's 2026 records came in two pulses: 23 between days 91 and 110 (early April, right after a run of
summer-like nights around day 90), almost none between days 110 and 120, then 37 between days 120 and 160. So about
a third of the strip's records came by 15 April (7-27% in past years), which is the model's forecast onset coming
true (forecast 94, real 95). But the bulk waited until May, roughly when it usually comes, even though by then the
places had banked far more warmth than usual. One curve of warmth targets cannot make that shape: it has to put the
whole wave early when the warmth comes early.

By place: southern Ohio's hill country (median sighting day 113, cooler, inside the fitted range) matched its forecast
to a day. Southern Illinois (137) and southern Indiana (131), the warmest places in the strip, ran 20 to 30 days after
theirs.

## Why not the other ideas
- **The strip in 2015-2025 was fine.** The south's average peak error over the fitted years is about +1 day. The
  bias the README describes as fixed stayed fixed, until a spring outside the fitted range.
- **The middle strip was also very warm and came out right**, which is why the cause is "how far beyond", not "warm
  at all". 39-41 °N had 193 degree-days by 15 April (record before: 114) and its forecast peak was 3 days late. But
  in its own warmest places (200-250 degree-days) the moths already came about 6 days after the forecast; only the
  south had places past 250.
- **A later start date does not obviously help.** If warmth before April did not count, the degree-days at each
  year's real peak should be more alike from year to year. In the fitted years they are not: in the south the spread
  (standard deviation over mean) grows from 0.22 counting from 1 March to 0.28 from 1 April and 0.37 from 15 April.
  So "start counting later" is a hypothesis for 2026, not something past years support.

## Most likely cause
**Extrapolation.** The model learned how luna moths respond to warmth from springs that banked up to about 145
degree-days by mid-April in this strip. 2026 banked 252, and the model assumed every extra degree-day brings the moths
out in proportion. About a third did come out early; most did not. Whether that is because warmth before some
daylength or date does not count, or because a part of the population waits whatever the weather, one season cannot
tell. Target noise (about 5 days), PRISM vs Daymet (about 1.5) and strip weighting (about 1) explain a little of the
rest; second-brood mixing, the daylength term and effort do not.

## What would fix it, to test in season two
1. **An out-of-range flag in the live pipeline (no model change).** When a strip's banked warmth on a date is past the
   fitted range (here: more than the warmest fitted spring by 15 April), say so on the card and widen the "likely"
   range toward the usual date. Pre-register the rule before March 2027 and grade it with the scorecard. Seen after
   the fact, a half-and-half mix of forecast and usual date would have called the 2026 south peak for day 126, 4 days
   off instead of 14; that is a hint, not evidence, since it was chosen after seeing 2026.
2. **A model variant for P4, written down before scoring:** warmth counts only once daylength passes a threshold (fitted),
   or a share of moths that emerges on warmth alone and the rest closer to a set date. Fit on 2015-2025, score
   leave-one-year-out as P3 was, then on 2026 (a second look, now seen) and 2027 (the clean test). P3 stays on the map
   unless the variant wins by the frozen rules.
3. **More southern springs.** The strip has 5 scored years, 27 to 65 records each. Every warm spring added makes the
   fitted range wider and the check fairer.

## Also found: PRISM highs were a day late
The lead-time note found that PRISM's daily high, as RCC-ACIS files it, belongs to the day before (PRISM's day ends at
7 am). It is confirmed here (2023-2025 daily highs vs Daymet: 0.6 °C apart shifted a day, 3.0 °C as filed; lows line
up as filed) and fixed in the live pipeline (`pipeline/live/sources.py`). It is not the southern miss: the 2026
southern strip forecast does not move (onset 94, peak 116), and the season's average miss stays 5.0 days (see `pipeline/live/DRYRUN_2026.md` and `SCORECARD_2026.md`).

## Reproduce
The checks are short scripts over the same inputs the live pipeline uses (`fold_fits.json`, `prism_offsets.json`,
`effort_profile.json`, the Daymet and PRISM caches in `notebooks/data/`, the fit's iNaturalist pull and the 2026
research-grade pull of 24 Oct 2026). They were not added to the repo; the numbers above are the record.
