#!/usr/bin/env python3
"""Rehearsal on the 2025 season (July 2025 - June 2026), which a clock frozen on 2018-2024 never saw.

Sealed every night from 1 October to 15 February on archive weather to three days before, with no 7-day forecast (the
archive has no forecast), then graded as 2026 will be. Rows go to REHEARSAL_2025.json.

    python3 pipeline/south/rehearse_south.py --records records.csv
"""
import argparse
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_south as B  # noqa: E402
import south as S  # noqa: E402

SEASON = 2025
SEASON = int(__import__("os").environ.get("SEASON", SEASON))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", type=Path, required=True)
    a = ap.parse_args(argv)
    here = Path(__file__).resolve().parent
    tmp = Path(tempfile.mkdtemp())
    B.YEARS = [y for y in range(2018, 2026) if y != SEASON]   # leave the season out: the clock has not seen it
    B.main(["--records", str(a.records), "--out", str(tmp / "static.json")])
    static = S.load_static(tmp / "static.json")
    S.SEASONS = (SEASON,)
    S.SETTLE = dt.date(2026, 2, 15)
    wx = {c: S.archive_weather(p["lat"], p["lng"], S.season_start(SEASON), dt.date(SEASON + 1, 3, 1))
          for c, p in static["cells"].items()}
    cur = {}

    def obs(la, ln, start, end):
        k = next(c for c, p in static["cells"].items() if (p["lat"], p["lng"]) == (round(la, 2), round(ln, 2)))
        n = (end - start).days + 1
        return wx[k][0][:n], wx[k][1][:n]

    def fc(la, ln, s, e):
        return np.full(1, np.nan), np.full(1, np.nan)

    live = tmp / "live"
    day = dt.date(SEASON, 10, 1)
    while day <= dt.date(SEASON + 1, 2, 15):
        S.nightly(live, SEASON, day, tmp / "static.json", obs, fc)
        day += dt.timedelta(days=1)
    raw = pd.read_csv(a.records, parse_dates=["date"])
    table = S.grade(live, SEASON, dt.date(SEASON + 1, 2, 16), raw, tmp / "static.json")
    (here / f"rehearsal_{SEASON}.json").write_text(json.dumps(table, indent=1) + "\n")
    t = table["tally"]
    print(json.dumps(t), table["verdict"], table["reason"])


if __name__ == "__main__":
    main()
