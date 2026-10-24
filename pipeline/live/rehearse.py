#!/usr/bin/env python3
"""Rehearse the live scorecard on a past season (2026): rebuild the forecast as it would have been issued each week,
archive it, then score the season week by week as the nightly job would have.

Each rebuilt forecast is a backfill run (build_live.py with --as-of, no 7-day forecast: none was archived for that
spring), filed as issued the day after its last day of real weather. PRISM is fetched once for the whole season and
sliced per as-of date, so the weeks share one download.

Run: python3 pipeline/live/rehearse.py --season 2026 --first 2026-03-08 --last 2026-09-27 \
         --records notebooks/data/luna_2026_inat.parquet --today 2026-10-19
"""
import argparse
import datetime as dt
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from live import build_live as L, scorecard as S, sources  # noqa: E402

import h3  # noqa: E402

CACHE = L.ROOT / "notebooks" / "data"


def cached_prism(season, cells):
    """Whole-season PRISM at every hex centre as ACIS dates it (sources.prism_acis), one download, kept in
    notebooks/data (gitignored). It runs to 1 October, so a 30 September weather day still has its high."""
    path = CACHE / f"prism_{season}.npz"
    start, end = dt.date(season, 1, 1) + dt.timedelta(days=L.START_DOY - 1), dt.date(season, 10, 1)
    if path.exists():
        z = np.load(path)
        if z["tmin"].shape[1] >= (end - start).days + 1:
            return start, z["tmin"], z["tmax"]
    ll = [h3.cell_to_latlng(c) for c in cells]
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(lambda p: sources.prism_acis(p[0], p[1], start, end), ll))
    tmin, tmax = np.array([g[0] for g in got]), np.array([g[1] for g in got])
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, tmin=tmin, tmax=tmax)
    return start, tmin, tmax


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--first", type=dt.date.fromisoformat, default=dt.date(2026, 3, 8))
    ap.add_argument("--last", type=dt.date.fromisoformat, default=dt.date(2026, 9, 27))
    ap.add_argument("--every", type=int, default=7, help="days between rebuilt forecasts")
    ap.add_argument("--archive", type=Path, default=HERE / "archive")
    ap.add_argument("--records", type=Path, help="season records parquet (default: fetch from iNaturalist)")
    ap.add_argument("--today", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    ap.add_argument("--out", type=Path, default=L.ROOT / "public" / "live" / "scorecard.json")
    ap.add_argument("--weeks", type=Path, help="also write the week-by-week scorecards here (one JSON list)")
    ap.add_argument("--skip-build", action="store_true", help="score the archive as it is")
    a = ap.parse_args(argv)

    if not a.skip_build:
        cells = json.loads(L.REPLAY.read_text())["cells"]
        start, tmin, tmax = cached_prism(a.season, cells)
        index = {(round(lat, 6), round(lng, 6)): i for i, (lat, lng) in enumerate(h3.cell_to_latlng(c) for c in cells)}

        def prism_acis(lat, lng, s, e):           # slice of the season download, same contract as sources.prism_acis
            i, a0 = index[(round(lat, 6), round(lng, 6))], (s - start).days
            return tmin[i, a0:a0 + (e - s).days + 1].copy(), tmax[i, a0:a0 + (e - s).days + 1].copy()
        sources.prism_acis = prism_acis           # sources.prism_point still applies the weather-day rule
        L.season_sightings = lambda *_: []        # the archive keeps strip dates only; the dots are not needed
        d = a.first
        while d <= a.last:
            live = L.build(a.season, d, False, a.today)
            print(f"archived {S.add_to_archive(a.archive, live, (d + dt.timedelta(days=1)).isoformat(), rehearsal=True)}",
                  flush=True)
            d += dt.timedelta(days=a.every)

    entries = S.load_archive(a.archive, a.season)
    raw = pd.read_parquet(a.records) if a.records else S.fetch_records(a.season, a.today)
    out = S.scorecard(a.season, raw, entries, a.today)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {a.out}: {json.dumps(out['layers']['luna']['summary'])}")
    if a.weeks:
        weeks, d = [], S.week_start(dt.date(a.season, 5, 4))
        while d <= a.today:
            weeks.append(S.scorecard(a.season, raw, entries, d))
            d += dt.timedelta(days=7)
        a.weeks.write_text(json.dumps(weeks, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
