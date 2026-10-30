"""The "Warm the spring" slider's data: public/atlas/warm.bin.

For every map cell, how many days ahead of its typical spring it would run if every day of a typical spring were 3 °F
warmer, or 3 °F cooler: the typical degree-day curve recounted from Daymet's daily highs and lows with each one moved
by 3 °F, then read against the typical curve exactly as the network's clock is (data.days_ahead). The page scales
smaller moves along the straight line from 0 to ±3 °F, and adds them to 2026's own days ahead.

Analogy: a bank account of warmth. Raise every day's pay a little and the account reaches each balance some days
sooner; this writes down how many days sooner, for each place and date.

warm.bin: int8 quarter days, [2 (cooler, warmer)][cell (cells.json order)][day SEASON[0], +STEP, ... SEASON[1]].
  python3 pipeline/atlas/warm.py            # needs notebooks/data/atlas/daymet/ and warmth.npz
"""
import json
import sys
from pathlib import Path

import h3
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "notebooks"))
from hatch_p1.degree_days import accumulate  # noqa: E402
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR, LAST_YEAR  # noqa: E402
from pipeline.atlas.export import OUT, SEASON, STEP  # noqa: E402

F = 3.0               # the slider's reach, °F
SHIFT = F * 5 / 9     # in °C, Daymet's unit


def main():
    keep = [c["h"] for c in json.loads((OUT / "cells.json").read_text())]
    z = np.load(DATA / "warmth.npz")
    cells, land = list(z["cells"]), z["land"]
    years = list(z["years"])
    clim_years = [years.index(y) for y in range(FIRST_YEAR, LAST_YEAR + 1)]
    ll = np.array([h3.cell_to_latlng(c) for c, on in zip(cells, land) if on])
    land_cells = [c for c, on in zip(cells, land) if on]
    days = np.arange(SEASON[0], SEASON[1] + 1, STEP)
    out = np.zeros((2, len(keep), len(days)), np.int8)
    for k, cell in enumerate(keep):
        i = cells.index(cell)
        # Water cells borrow the nearest land cell's weather, as build_warmth.py does.
        src = cell if land[i] else land_cells[int(np.argmin(((ll - np.array(h3.cell_to_latlng(cell))) ** 2).sum(1)))]
        d = pd.read_csv(DATA / "daymet" / f"{src}.csv")
        d = d[(d.year >= FIRST_YEAR) & (d.year <= LAST_YEAR)]
        tmin = np.zeros((LAST_YEAR - FIRST_YEAR + 1, 365), np.float32)
        tmax = tmin.copy()
        tmin[d.year - FIRST_YEAR, d.yday - 1] = d["tmin (deg c)"]
        tmax[d.year - FIRST_YEAR, d.yday - 1] = d["tmax (deg c)"]
        clim = z["dd10"][i, clim_years].mean(0)
        for m, s in enumerate((-SHIFT, SHIFT)):
            dd = accumulate(tmin + s, tmax + s, 10.0).mean(0)
            a = D.days_ahead(clim, dd)[days - 1]
            out[m, k] = np.clip(np.round(a * 4), -127, 127)
    out.tofile(OUT / "warm.bin")
    mid = list(days).index(152) if 152 in days else len(days) // 2
    print(f"{len(keep)} cells; 1 Jun median days ahead: {np.median(out[0, :, mid]) / 4:+.1f} cooler, "
          f"{np.median(out[1, :, mid]) / 4:+.1f} warmer ({out.nbytes / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
