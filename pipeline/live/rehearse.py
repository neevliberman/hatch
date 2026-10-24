#!/usr/bin/env python3
"""Rehearse the live scorecard on a past season (2026): rebuild the forecast as it would have been issued each week,
archive it, then score the season week by week as the nightly job would have. Every live species (registry.py) by
default, each from the same weather, archived and scored on its own (luna in archive/<season>/, the others in
archive/<key>/<season>/).

Each rebuilt forecast is a backfill run (build_live.py with --as-of, no 7-day forecast: none was archived for that
spring), issued on a Monday with real weather through PRISM_LAG_DAYS before it, the newest day the morning job really
has (build_live.PRISM_LAG_DAYS). PRISM is fetched once for the whole season and sliced per as-of date, so the weeks
share one download. The season is then scored week by week from May, each week starting from the last one's file, so
a strip's row is frozen the week it is first scored, exactly as the nightly job publishes it.

Run: python3 pipeline/live/rehearse.py --season 2026 --first 2026-03-09 --last 2026-09-28 --today 2026-10-24 \
         --records notebooks/data/luna_2026_rg.parquet firefly=notebooks/data/firefly_2026_rg.parquet \
                   japanese-beetle=notebooks/data/japanese-beetle_2026_rg.parquet
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
from live import build_live as L, registry, scorecard as S, sources  # noqa: E402

import h3  # noqa: E402

CACHE = L.ROOT / "notebooks" / "data"


def cached_prism(season, cells, through=None):
    """Whole-season PRISM at every hex centre as ACIS dates it (sources.prism_acis), one download, kept in
    notebooks/data (gitignored). It runs to 1 October, so a 30 September weather day still has its high. A cache that
    already reaches `through` (default 1 October) is used as it is."""
    path = CACHE / f"prism_{season}.npz"
    start, end = dt.date(season, 1, 1) + dt.timedelta(days=L.START_DOY - 1), dt.date(season, 10, 1)
    if path.exists():
        z = np.load(path)
        if z["tmin"].shape[1] >= ((through or end) - start).days + 1:
            return start, z["tmin"], z["tmax"]
    ll = [h3.cell_to_latlng(c) for c in cells]
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(lambda p: sources.prism_acis(p[0], p[1], start, end), ll))
    tmin, tmax = np.array([g[0] for g in got]), np.array([g[1] for g in got])
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, tmin=tmin, tmax=tmax)
    return start, tmin, tmax


def season_weeks(season, records, archive, today, first=None, keys=None):
    """The scorecard as published each Monday from `first` (default 4 May) to today, each week built on the last
    (so scored strips stay frozen, as in the nightly job), every species in one file as the nightly job writes it.
    records: {key: season records}. Returns the list; the last is today's."""
    weeks, prev, d = [], None, S.week_start(first or dt.date(season, 5, 4))
    while d <= S.week_start(today):
        prev, failed = S.scorecard_all(season, d, archive, records, prev, keys)
        if failed:
            raise SystemExit(f"scorecard failed for {failed}")
        weeks.append(prev)
        d += dt.timedelta(days=7)
    return weeks


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--first", type=dt.date.fromisoformat, default=dt.date(2026, 3, 9), help="first issue day")
    ap.add_argument("--last", type=dt.date.fromisoformat, default=dt.date(2026, 9, 28), help="last issue day")
    ap.add_argument("--every", type=int, default=7, help="days between rebuilt forecasts")
    ap.add_argument("--archive", type=Path, default=HERE / "archive")
    ap.add_argument("--records", nargs="+", default=[],
                    help="season records parquet: PATH (luna) or KEY=PATH per species (default: fetch from iNaturalist)")
    ap.add_argument("--species", nargs="+", choices=[s.key for s in registry.SPECIES],
                    help="species to rehearse (default: all; luna is always rebuilt, the forecasts share its weather)")
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
        issue = a.first
        while issue <= a.last:
            live = L.build_all(a.season, issue - dt.timedelta(days=L.PRISM_LAG_DAYS), False, a.today, keys=a.species)
            if live["checks"]["species_failed"]:
                raise SystemExit(f"forecast failed for {live['checks']['species_failed']}")
            for p in S.add_all(a.archive, live, issue.isoformat(), rehearsal=True):
                print(f"archived {p}", flush=True)
            issue += dt.timedelta(days=a.every)

    keys = ["luna", *(a.species or [])] if a.species else None
    records = {}
    for r in a.records:
        key, _, path = r.rpartition("=")
        records[key or "luna"] = pd.read_parquet(path)
    weeks = season_weeks(a.season, records, a.archive, a.today, keys=keys)
    out = weeks[-1]
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, separators=(",", ":")))
    for k, layer in out["layers"].items():
        print(f"wrote {a.out} [{k}]: {json.dumps(layer['summary'])}")
    if a.weeks:
        a.weeks.write_text(json.dumps(weeks, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
