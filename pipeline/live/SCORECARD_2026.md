# Live scorecard, rehearsed on 2026 (built 2026-10-24)

The scorecard the nightly job will keep from 2027 (`scorecard.py`), run on the 2026 season as if the live pipeline
had been running then. `rehearse.py` rebuilt the forecast as it would have stood every Sunday from 8 March to
27 September (real PRISM weather up to that day, then past years' weather; no 7-day forecast, since none was archived
that spring), filed each one as issued the next day (`archive/2026/`, 30 files), then scored the season week by week.
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

## Result, as of Monday 19 October 2026: all 5 strips scored

**The forecast missed by 5.0 days on average, against 7.8 for the calendar.** 7 of the 10 dates fell inside the
forecast's "likely" range.

| Strip | Records | Onset: real / forecast / calendar | Peak: real / forecast / calendar | Miss | Calendar miss |
|---|---|---|---|---|---|
| 37-39 N | 65 | 5 Apr / 11 Apr / 17 Apr | 10 May / 25 Apr / 15 May | 10.3 | 8.2 |
| 39-41 N | 222 | 11 Apr / 17 Apr / 28 Apr | 9 May / 6 May / 23 May | 4.5 | 15.5 |
| 41-43 N | 139 | 24 Apr / 4 May / 10 May | 29 May / 29 May / 30 May | 5.1 | 8.9 |
| 43-45 N | 54 | 5 May / 12 May / 17 May | 8 Jun / 7 Jun / 7 Jun | 3.5 | 6.1 |
| 45-49 N | 126 | 7 Jun / 5 Jun / 7 Jun | 22 Jun / 20 Jun / 21 Jun | 1.8 | 0.4 |

In plain words:
- **It beat the calendar overall and in three of five strips**, most clearly in central Illinois, Indiana and Ohio
  (39-41 N), where 2026 ran about two weeks ahead of a usual year and the forecast saw that coming.
- **The far south is the big miss again.** It called the 37-39 N peak for 25 April; the real peak was 10 May, two
  weeks later, and the calendar did better there. The 2026 dry run found the same miss with a different summary.
- **First moths came earlier than forecast in four strips** (by about 6 to 10 days), even where the peak was right. The
  forecast's spread is shaped well around the peak but starts too late.
- **In the north the calendar was as good or better** (45-49 N: 0.4 days). 2026 was an ordinary year up there, which
  is exactly when the usual date is hard to beat.

## How it would have read during the season

| Monday | Scored | Pending | Forecast miss | Calendar miss |
|---|---|---|---|---|
| 4 May to 6 Jul | 0 | 5 | - | - |
| 13 Jul | 3 | 2 | 6.8 | 11.0 |
| 27 Jul | 4 | 1 | 6.6 | 10.2 |
| 14 Sep | 5 | 0 | 5.2 | 7.9 |
| 19 Oct | 5 | 0 | 5.0 | 7.8 |

The first strips settle in mid-July (the "July scorecard" of plan v2), 43-45 N at the end of July, and the far north
only in mid-September because it has no second wave and keeps the fallback window to day 240. Numbers drift a little
after scoring as late posts arrive (records with a later upload date are left out of each week's score, so each row
is what was knowable that Monday, apart from records confirmed since).

## Caveats
- One season, five strips: 10 dates. 5.0 vs 7.8 days is encouraging, not proof.
- Rebuilt forecasts are weekly here; the live job archives one every night, so each date is graded on a forecast
  1 to 7 days fresher than this rehearsal could use. No 7-day weather forecast was in any rehearsal run.
- The model is scored on Daymet-like weather built from PRISM (offsets in `prism_offsets.json`); 2026 Daymet is not out yet.
- Strip forecasts weight each hex by its share of the replay's openly licensed first-wave sightings (about 2 in 3 of
  the fit's records), not the full fit set.
- Research-grade status is today's, not what it was on each Monday.

Reproduce: `python3 pipeline/live/rehearse.py --records <2026 research-grade parquet> --today 2026-10-24`
(`--skip-build` to rescore the committed archive only).
