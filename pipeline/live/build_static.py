#!/usr/bin/env python3
"""One-off inputs for the live pipeline, committed next to this file so the nightly job needs no history pulls.

- effort_profile.json: typical within-season moth-recording effort per state (iNat histograms 2015-2025, the
  same background the P3 fit uses), so the live forecast predicts *sightings* exactly like the replay.
- prism_offsets.json: per res-4 cell and calendar month, mean (Daymet - PRISM) Tmin and Tmax over 2015-2025, with
  PRISM read by weather day (its high moved back to the day it happened, sources.weather_days), as the live job reads it.
  The model was fitted on Daymet; live weather comes from PRISM, which runs a touch different by place. Adding
  the offset puts live weather on the model's scale (like converting a second thermometer to read like the first).

Run once (needs network, ~10 min): python3 pipeline/live/build_static.py   (--offsets-only skips the effort profile)
"""
import datetime as dt
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

import h3  # noqa: E402
from fit import data as fdata, evaluate as EV  # noqa: E402
from hatch_p1.daymet import _fetch_one  # noqa: E402

from live import sources  # noqa: E402

Y0, Y1 = 2015, 2025
REPLAY = ROOT / "src" / "data" / "luna-replay.json"
CACHE = fdata.DATA / "daymet"
PRISM_CACHE = fdata.DATA / "prism_hist_acis"   # raw ACIS dates (the old prism_hist cache was filed as-is)


def effort_profile():
    E = fdata.effort_matrix(fdata.fetch_effort(), np.arange(Y0, Y1 + 1))
    prof = EV.effort_profile(E, list(range(Y1 - Y0 + 1)))     # [state, 365]
    return {"states": fdata.STATES, "years": [Y0, Y1],
            "profile": [[float(f"{v:.4g}") for v in row] for row in prof]}


def _prism_hist(cell):
    """PRISM by weather day (sources.weather_days, as the live job reads it) over Y0..Y1. The cache keeps the raw
    ACIS dates (1 Jan Y0 .. 1 Jan Y1 + 1), so the weather-day rule is applied here, never baked into the cache."""
    f = PRISM_CACHE / f"{cell}.npz"
    if f.exists():
        z = np.load(f)
        tmin, tmax = z["tmin"], z["tmax"]
    else:
        lat, lng = h3.cell_to_latlng(cell)
        tmin, tmax = sources.prism_acis(lat, lng, dt.date(Y0, 1, 1), dt.date(Y1 + 1, 1, 1))
        PRISM_CACHE.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(f, tmin=tmin, tmax=tmax)
    return sources.weather_days(tmin, tmax)


def prism_offsets(cells):
    days = sources.dates(dt.date(Y0, 1, 1), dt.date(Y1, 12, 31))
    key = {(d.year, d.timetuple().tm_yday): i for i, d in enumerate(days)}
    month = np.array([d.month for d in days])
    with ThreadPoolExecutor(6) as ex:
        prism = list(ex.map(_prism_hist, cells))
    with ThreadPoolExecutor(4) as ex:
        daymet = dict(ex.map(lambda c: _fetch_one(c, Y0, Y1, CACHE), cells))
    out = []
    for c, (pmin, pmax) in zip(cells, prism):
        d = daymet[c]
        if d is None:
            raise SystemExit(f"Daymet failed for {c}")
        idx = np.array([key[(y, j)] for y, j in zip(d["year"], d["yday"])])
        dmin = np.full(len(days), np.nan)
        dmax = dmin.copy()
        dmin[idx], dmax[idx] = d["tmin (deg c)"], d["tmax (deg c)"]
        row = []
        for m in range(1, 13):
            sel = month == m
            row.append([round(float(np.nanmean(dmin[sel] - pmin[sel])), 2),
                        round(float(np.nanmean(dmax[sel] - pmax[sel])), 2)])
        out.append(row)
    return out


def main(argv=None):
    offsets_only = "--offsets-only" in (sys.argv[1:] if argv is None else argv)
    cells = json.loads(REPLAY.read_text())["cells"]
    if not offsets_only:
        (HERE / "effort_profile.json").write_text(json.dumps(effort_profile()) + "\n")
        print("wrote effort_profile.json", flush=True)
    off = prism_offsets(cells)
    a = np.array(off)
    print(f"offsets (Daymet - PRISM) Tmin mean {a[..., 0].mean():+.2f} C, Tmax mean {a[..., 1].mean():+.2f} C; "
          f"|max| {np.abs(a).max():.2f}")
    (HERE / "prism_offsets.json").write_text(json.dumps(
        {"what": "per cell, per calendar month 1..12: [Daymet-PRISM Tmin, Daymet-PRISM Tmax] deg C, mean 2015-2025; "
                 "PRISM by weather day (high from the next ACIS date)",
         "cells": cells, "offsets": off}, separators=(",", ":")) + "\n")
    print("wrote prism_offsets.json")


if __name__ == "__main__":
    main()
