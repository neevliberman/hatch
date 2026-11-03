"""One-off input for the weekly Atlas rebuild (weekly.py), committed next to this file so the job needs no weather
history, no warmth.npz and no torch: pipeline/atlas/weekly_static.npz.

For every map cell, in public/atlas/cells.json order:
- inc: the typical year's daily degree-days (base 10 °C, upper 30 °C, double sine, from 1 March), PRISM 2015-2025
  (via RCC-ACIS, read by weather day as the live job reads it: live/sources.prism_point) averaged, in hundredths
  (uint16). Their running total is the typical curve this year's warmth is read against ("days ahead").
- src: the cell whose PRISM it reads: itself, or the nearest cell PRISM covers (Canada, open lake).

Why PRISM for the typical year too, when the network learned on Daymet (warmth.npz): the weekly job reads this year
from PRISM, and "days ahead" only compares this year with a typical one, so reading both off the same thermometer
cancels the gap between the two (as build_warmth_2026.py's offsets did). Daymet's own server is not reachable from
every build machine either. Check (test_weekly.py and weekly.py --check-2026): rebuilt this way, 2026's days ahead
match the shipped ahead-2026.bin (Daymet typical year, offset PRISM) closely.
Analogy: to say how far ahead of schedule a runner is, time them and the record with the same stopwatch.
  python3 pipeline/atlas/weekly_static.py       # ~1,200 ACIS calls, ~15 min the first time (cached after)
"""
import datetime as dt
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import h3
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "notebooks"))
from hatch_p1.degree_days import double_sine  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR, LAST_YEAR, OUT  # noqa: E402
from pipeline.live.build_live import fill_gaps  # noqa: E402
from pipeline.live.sources import prism_point  # noqa: E402

STATIC = Path(__file__).resolve().parent / "weekly_static.npz"
CACHE = DATA / "prism_hist"
BASE, UPPER, START_DOY = 10.0, 30.0, 60


def daily_dd(tmin, tmax):
    """Daily degree-days along the last axis, zero before 1 March (degree_days.accumulate without the running total)."""
    d = double_sine(tmin, tmax, BASE, UPPER)
    d[..., :START_DOY - 1] = 0
    return d


def by_year(x, y0, y1):
    """Daily values from 1 Jan y0 on -> [years, 365]: each year's calendar days 1-365 (a leap year drops 31 Dec, as
    Daymet's calendar does)."""
    out, at = [], 0
    for y in range(y0, y1 + 1):
        n = 366 if dt.date(y, 12, 31).timetuple().tm_yday == 366 else 365
        out.append(x[at:at + 365])
        at += n
    return np.array(out)


def history(cell):
    """PRISM Tmin/Tmax by weather day, [years, 365] each, FIRST_YEAR..LAST_YEAR (cached raw)."""
    f = CACHE / f"{cell}.npz"
    if f.exists():
        z = np.load(f)
        return z["tmin"], z["tmax"]
    lat, lng = h3.cell_to_latlng(cell)
    tmin, tmax = prism_point(lat, lng, dt.date(FIRST_YEAR, 1, 1), dt.date(LAST_YEAR, 12, 31))
    tmin, tmax = by_year(tmin, FIRST_YEAR, LAST_YEAR), by_year(tmax, FIRST_YEAR, LAST_YEAR)
    np.savez(f, tmin=tmin, tmax=tmax)
    return tmin, tmax


def nearest(ll, have, i):
    j = np.where(have)[0]
    return int(j[np.argmin(((ll[j] - ll[i]) ** 2).sum(1))])


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    rows = json.loads((OUT / "cells.json").read_text())
    cells = [c["h"] for c in rows]
    ll = np.array([h3.cell_to_latlng(c) for c in cells])
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(history, cells))
    has = np.array([np.isfinite(g[0]).mean() > 0.99 and np.isfinite(g[1]).mean() > 0.99 for g in got])
    src = np.array([i if has[i] else nearest(ll, has, i) for i in range(len(cells))])
    inc = []
    for s in src:
        tmin, tmax = got[s]
        # a rare missing day borrows its neighbours' (the live job's fill_gaps)
        tmin, tmax = fill_gaps(tmin.reshape(1, -1)).reshape(tmin.shape), fill_gaps(tmax.reshape(1, -1)).reshape(tmax.shape)
        inc.append(daily_dd(tmin, tmax).mean(0))
    inc = np.array(inc)
    assert np.isfinite(inc).all(), "PRISM gaps left"
    q = np.round(inc * 100).astype(np.uint16)
    np.savez_compressed(STATIC, cells=np.array(cells), inc=q, src=src.astype(np.int16))
    gap = np.cumsum(q / 100, 1)[:, 180] - np.array([c["dd"] for c in rows])
    print(f"{len(cells)} cells ({int((~has).sum())} borrow PRISM); typical warmth by 30 June, PRISM minus the network's "
          f"Daymet (cells.json): median {np.median(gap):+.0f} DD, middle half {np.percentile(gap, 25):+.0f}..{np.percentile(gap, 75):+.0f}; "
          f"{STATIC.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
