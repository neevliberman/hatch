#!/usr/bin/env python3
"""Freeze the southern clock: south_static.json (SOUTH_2026.md).

For each 2-degree cell with 3+ past seasons (1 July - 30 June, 2018-2025) of 20+ research-grade Christmas beetle
records, this stores the warmth (degree-days above 6 C, capped at 30 C, since 1 July) that had piled up by the
season's onset (10% of records) and peak (median), averaged over the cell's past seasons; the cell's calendar
(mean onset and peak day); and each past season's daily warmth as an "ending" for the forecast.

    python3 pipeline/south/build_south.py [--records records.csv] [--out south_static.json]
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import south as S  # noqa: E402

YEARS = list(range(2018, 2026))
DAYS = 330                                              # 1 July .. late May: past the longest scored day (260)
MIN_SEASONS = 3


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", type=Path, help="csv of fetch_records output (default: fetch from iNaturalist)")
    ap.add_argument("--out", type=Path, default=S.STATIC)
    a = ap.parse_args(argv)
    raw = pd.read_csv(a.records, parse_dates=["date"]) if a.records else \
        S.fetch_records(S.season_start(YEARS[0]), dt.date(YEARS[-1] + 1, 6, 30))
    raw = raw[(raw.date >= pd.Timestamp(S.season_start(YEARS[0]))) & (raw.date <= pd.Timestamp(YEARS[-1] + 1, 6, 30))]
    parts = []
    for y in YEARS:
        s = raw[(raw.date >= pd.Timestamp(S.season_start(y))) & (raw.date < pd.Timestamp(S.season_start(y + 1)))]
        parts.append(S.with_cells(s, y).assign(season=y))
    d = pd.concat(parts)
    g = d.groupby(["cell", "season"]).agg(n=("doy", "size"), onset=("doy", lambda s: s.quantile(.1)),
                                          peak=("doy", "median"), lat=("lat", "mean"), lng=("lng", "mean")).reset_index()
    g = g[g.n >= S.MIN_N]
    cells = {}
    for c, h in g.groupby("cell"):
        if len(h) < MIN_SEASONS:
            continue
        la, ln = float(np.average(h.lat, weights=h.n)), float(np.average(h.lng, weights=h.n))
        tmin, tmax = S.archive_weather(la, ln, S.season_start(YEARS[0]), dt.date(YEARS[-1] + 1, 5, 31))
        days = pd.date_range(S.season_start(YEARS[0]), periods=len(tmin))
        incs = S.inc(tmin, tmax)
        clim = {}
        for y in YEARS:
            i0 = int((pd.Timestamp(S.season_start(y)) - days[0]).days)
            clim[y] = incs[i0:i0 + DAYS]
            assert len(clim[y]) == DAYS and not np.isnan(clim[y]).any(), (c, y)
        tgt = {q: [] for q in ("onset", "peak")}
        for r in h.itertuples():
            cum = np.cumsum(clim[r.season])
            for q in tgt:
                tgt[q].append(float(np.interp(getattr(r, q), np.arange(DAYS), cum)))
        cells[c] = {"lat": round(la, 2), "lng": round(ln, 2), "seasons": [int(s) for s in h.season],
                    "records": int(h.n.sum()),
                    "target_dd": {q: round(float(np.mean(v)), 1) for q, v in tgt.items()},
                    "calendar": {"onset": round(float(h.onset.mean()), 1), "peak": round(float(h.peak.mean()), 1)},
                    "climate_dd": [[round(float(v), 1) for v in clim[y]] for y in YEARS]}
    out = {"version": 1, "model": "south-clock-v1", "species": "Christmas beetles (Anoplognathus)",
           "years": YEARS, "base_c": S.BASE_C, "upper_c": S.UPPER_C, "cells": cells}
    a.out.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"{len(cells)} cells, {sum(c['records'] for c in cells.values())} records, "
          f"sha256 {S.sha256(a.out)[:12]}, {a.out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
