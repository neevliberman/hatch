#!/usr/bin/env python3
"""2026 weather for the second-look test (FROZEN_P4.md, supporting test 4): PRISM daily Tmin/Tmax via ACIS for
every hex that has a luna record (Midwest weighting hexes first, then eastern hexes with a 2026 record).
Cached per hex in notebooks/data/prism2026/ (gitignored). Daymet 2026 is not out until mid-2027."""
import datetime as dt
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import h3
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from p4 import DATA, wide as W  # noqa: E402
from fit import data as FD  # noqa: E402
from live import sources  # noqa: E402

OUT = DATA / "prism2026"
START, END = dt.date(2026, 1, 1), dt.date(2026, 9, 30)


def one(h):
    f = OUT / f"{h}.npz"
    if f.exists():
        return h, True
    lat, lng = h3.cell_to_latlng(h)
    try:
        tn, tx = sources.prism_point(lat, lng, START, END)
    except Exception:
        return h, False
    np.savez(f, tmin=tn, tmax=tx)
    return h, True


def hexes_2026():
    mw = FD.luna_records()
    raw = W.fetch_records()
    w26 = W.clean_wide(raw, years=(2026, 2026))
    order = sorted(set(mw.hex)) + sorted(set(w26.hex) - set(mw.hex))
    return order


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    hs = hexes_2026()
    print("hexes", len(hs), flush=True)
    bad = 0
    with ThreadPoolExecutor(6) as ex:
        for i, (h, ok) in enumerate(ex.map(one, hs)):
            bad += not ok
            if i % 200 == 0:
                print(i, bad, flush=True)
    print("prism done", len(hs), "failed", bad, flush=True)
