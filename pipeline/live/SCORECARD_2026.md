# Live scorecard, rehearsed on 2026 (built 2026-10-24; rebuilt the same day with the live job's real weather lag)

The scorecard the nightly job will keep from 2027 (`scorecard.py`), run on the 2026 season as if the live pipeline
had been running then. `rehearse.py` rebuilt the forecast as it would have stood every Monday morning from 9 March to
28 September, filed as issued that Monday (`archive/2026/`, 30 files), then published the scorecard week by week from
May, each week starting from the last one's file. Each forecast has real PRISM weather through the Friday before
(3 days back, the newest day the morning job really has: ACIS posts PRISM through about two days ago, and that day's
high belongs to the day before), then past years' weather; no 7-day forecast, since none was archived that spring.
Model: P3 (`p3-v1`, fits hash `7dc3c4c0887b`), frozen; it never saw a 2026 moth. Sightings: 2026 research-grade
iNaturalist luna records, pulled 24 Oct 2026, same filters as the fit (wild, exact location, adult, one per observer,
hex and day), first wave only.

## The rules (written into the scorecard file)
- A strip (2-degree latitude band) is scored only once its first wave is over and its last day is 14 days old.
  Before that it is **pending**, however many sightings it has. Records younger than 14 days are counted as pending.
- Real onset / peak = the day 10% / 50% of the strip's first-wave records were in (at least 20 records), as P3 scores.
- The forecast graded for each date is the newest one issued **at least 7 days before** that date really happened,
  and only from the season's model (the model id and hash of its first forecast).
- The comparison is the calendar: each strip's mean onset and peak over 2015-2025.
- The miss for a strip is the mean of its onset miss and peak miss, in days. Scores update once a week (Mondays).
- **A strip's score is frozen the week it is first given** (`scored_on`): later weeks copy it from the last published
  file, so late uploads never move a published score.

## Result, as of Monday 19 October 2026: all 5 strips scored

**The forecast missed by 5.6 days on average, against 8.2 for the calendar.** 6 of the 10 dates fell inside the
forecast's "likely" range.

| Strip | Scored on | Records | Onset: real / forecast / calendar | Peak: real / forecast / calendar | Miss | Calendar miss |
|---|---|---|---|---|---|---|
| 37-39 N | 13 Jul | 65 | 5 Apr / 13 Apr / 17 Apr | 10 May / 25 Apr / 15 May | 11.3 | 8.2 |
| 39-41 N | 13 Jul | 208 | 12 Apr / 17 Apr / 28 Apr | 9 May / 8 May / 23 May | 3.1 | 15.1 |
| 41-43 N | 13 Jul | 128 | 23 Apr / 3 May / 10 May | 28 May / 29 May / 30 May | 5.5 | 9.8 |
| 43-45 N | 27 Jul | 50 | 3 May / 14 May / 17 May | 7 Jun / 7 Jun / 7 Jun | 6.0 | 7.5 |
| 45-49 N | 14 Sep | 124 | 7 Jun / 4 Jun / 7 Jun | 21 Jun / 20 Jun / 21 Jun | 2.2 | 0.4 |

In plain words:
- **It beat the calendar overall and in three of five strips**, most clearly in central Illinois, Indiana and Ohio
  (39-41 N), where 2026 ran about two weeks ahead of a usual year and the forecast saw that coming.
- **The far south is the big miss again.** It called the 37-39 N peak for 25 April; the real peak was 10 May, two
  weeks later, and the calendar did better there. The 2026 dry run found the same miss with a different summary. Why:
  `pipeline/fit/SOUTH_BIAS.md` (a spring far warmer than any the model was fitted on).
- **First moths came earlier than forecast in four strips** (by about 5 to 11 days), even where the peak was right. The
  forecast's spread is shaped well around the peak but starts too late.
- **In the north the calendar was as good or better** (45-49 N: 0.4 days). 2026 was an ordinary year up there, which
  is exactly when the usual date is hard to beat.

**What changed in the rebuild (2026-10-24), on the same weather download and records:**
- *PRISM date fix.* PRISM's daily high, as RCC-ACIS files it, belongs to the day before (PRISM's day ends at 7 am), so
  the first build banked each afternoon's warmth a day late. `sources.py` now takes each day's high from the next ACIS
  date, and `prism_offsets.json` was rebuilt the same way. Alone, it moved 74 of the 300 archived strip dates by one day
  and left the average at 5.0 against 7.8.
- *Real weather lag.* The first build gave each forecast real weather through the day before it was issued; the
  morning job only has it through 3 days before. With that lag: 5.1 against 7.8, 6 of 10 inside (was 8).
- *Frozen scores.* Scoring each strip once, the week it settles, instead of rescoring every week with every record
  posted since: 5.6 against 8.2. The calendar misses grow too, because the early real dates are what was knowable then.

## How it would have read during the season

| Monday | Scored | Pending | Forecast miss | Calendar miss |
|---|---|---|---|---|
| 4 May to 6 Jul | 0 | 5 | - | - |
| 13 Jul | 3 | 2 | 6.6 | 11.0 |
| 27 Jul | 4 | 1 | 6.5 | 10.1 |
| 14 Sep to 19 Oct | 5 | 0 | 5.6 | 8.2 |

The first strips settle in mid-July (the "July scorecard" of plan v2), 43-45 N at the end of July, and the far north
only in mid-September because it has no second wave and keeps the fallback window to day 240. Once scored, a strip's
row does not move: each row is what was knowable the Monday it was scored (records with a later upload date are left
out), apart from records confirmed since.

## Caveats
- One season, five strips: 10 dates. 5.6 vs 8.2 days is encouraging, not proof.
- Rebuilt forecasts are weekly here; the live job archives one every night, so each date is graded on a forecast
  up to 6 days fresher than this rehearsal could use. No 7-day weather forecast was in any rehearsal run.
- The model is scored on Daymet-like weather built from PRISM (offsets in `prism_offsets.json`); 2026 Daymet is not out yet.
- Strip forecasts weight each hex by its share of the replay's openly licensed first-wave sightings (about 2 in 3 of
  the fit's records), not the full fit set.
- Research-grade status is today's, not what it was on each Monday.

Reproduce: `python3 pipeline/live/rehearse.py --records <2026 research-grade parquet> --today 2026-10-24`
(`--skip-build` to rescore the committed archive only).
