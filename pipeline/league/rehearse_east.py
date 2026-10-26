#!/usr/bin/env python3
"""Rehearse the eastern shadow track on 2026, a season east_static.json never saw (it is built from 2015-2025).

Like the luna 2026 dry run (pipeline/live/rehearse.py): one sealed forecast per night from 3 March, each using only
PRISM weather up to two days before its issue date, then the 2015-2025 endings (no 7-day forecast: there is no
honest archived one, so this is a little harder than a real night). Graded every Monday by east.grade, exactly as
2027 will be, on the 2026 eastern records known by each Monday. Result -> pipeline/league/EAST_REHEARSAL_2026.json.

Caveat: PRISM's 2026 values are read as they stand now, not as provisional on each night.

Run: python3 pipeline/league/rehearse_east.py   (~5 min: one season of PRISM per hex, cached)
"""
import datetime as dt
import json
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from league import east as E  # noqa: E402
from live import scorecard as S, sources  # noqa: E402

SEASON, LAG = 2026, 2
OUT = HERE / "EAST_REHEARSAL_2026.json"


def season_prism(static, season, end):
    """Whole-season PRISM per hex (by weather day), once: {hex: (dates, tmin, tmax)}."""
    import h3
    start = dt.date(season, 1, 1) + dt.timedelta(days=static["first_day_index"])
    hexes = static["offsets"]["hexes"]
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(lambda h: sources.prism_point(*h3.cell_to_latlng(h), start, end), hexes))
    return start, {h: g for h, g in zip(hexes, got)}


def main():
    static = E.load_static()
    model = E.model_of()
    last = dt.date(SEASON, 10, 5)
    start, wx = season_prism(static, SEASON, last)
    import h3
    by_ll = {tuple(round(v, 6) for v in h3.cell_to_latlng(h)): wx[h] for h in static["offsets"]["hexes"]}
    from p4 import wide as W
    raw = W.fetch_records()
    raw = raw[raw.observed_on.astype(str).str[:4] == str(SEASON)]
    with tempfile.TemporaryDirectory() as tmp:
        live = Path(tmp)
        issue = dt.date(SEASON, 3, 3)                  # as_of 1 March, the first model day
        while issue <= last:
            as_of = issue - dt.timedelta(days=LAG)
            n = (as_of - start).days + 1

            def fetch_obs(lat, lng, _n=n):       # the season's PRISM cut to as_of (asked per hex by its centre)
                tmin, tmax = by_ll[(round(lat, 6), round(lng, 6))]
                return np.asarray(tmin, float)[:_n], np.asarray(tmax, float)[:_n]
            e = E.sealed_entry(static, SEASON, as_of, issue, model, use_forecast=False, fetch_obs=fetch_obs)
            p = live / "archive_east" / str(SEASON) / f"{issue.isoformat()}.json"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(e))
            issue += dt.timedelta(days=1)
        weeks = []
        monday = S.week_start(dt.date(SEASON, 6, 1))
        while monday <= S.week_start(last):
            t = E.grade(live, SEASON, monday, raw, E.STATIC)
            weeks.append({"score_date": t["score_date"], **t["tally"]})
            monday += dt.timedelta(days=7)
    out = {"season": SEASON, "model": model, "lag_days": LAG, "forecast_days": 0,
           "note": "east_static.json (built from 2015-2025) run on 2026: sealed nightly from 3 March on PRISM to "
                   "issue - 2 days, graded weekly by east.grade",
           "final": {"score_date": t["score_date"], **t["tally"]}, "places": t["places"], "weeks": weeks}
    OUT.write_text(json.dumps(out, indent=1, allow_nan=False) + "\n")
    print(json.dumps(out["final"], indent=1))
    sc = [r for r in t["places"] if r.get("status") == "scored"]
    for r in sc:
        print(f"{r['band']:12s} n={r['n']:4d} clock {r['miss']:5.1f}  calendar {r['calendar_miss']:5.1f}")


if __name__ == "__main__":
    main()
