"""Add 2026 to the warmth grid from PRISM (via RCC-ACIS), since Daymet 2026 comes out mid-2027.

PRISM and Daymet differ a little, so each cell's 2026 temperatures are shifted by that cell's mean Daymet-minus-PRISM
gap over 2025 (Tmin and Tmax separately), the year both cover. Cells outside PRISM's US grid borrow the nearest PRISM cell, offset by their own Daymet gap. Days after PRISM's newest are NaN in the cube; the
scorer only uses records up to that day. Appends year 2026 to notebooks/data/atlas/warmth.npz.
  python3 pipeline/atlas/build_warmth_2026.py
"""
import datetime as dt
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import h3
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "notebooks"))
from hatch_p1.degree_days import accumulate  # noqa: E402
from pipeline.atlas.config import DATA  # noqa: E402
from pipeline.atlas.build_warmth import CACHE, fetch  # noqa: E402
from pipeline.live.sources import prism_point  # noqa: E402

YEAR = 2026
PRISM = DATA / "prism"


def pull(cell, end):
    f = PRISM / f"{cell}.npz"
    if f.exists():
        z = np.load(f)
        return z["tmin"], z["tmax"]
    lat, lng = h3.cell_to_latlng(cell)
    tmin, tmax = prism_point(lat, lng, dt.date(2025, 1, 1), end)
    np.savez(f, tmin=tmin, tmax=tmax)
    return tmin, tmax


def main():
    PRISM.mkdir(parents=True, exist_ok=True)
    z = dict(np.load(DATA / "warmth.npz"))
    assert YEAR not in z["years"], "2026 already added"
    end = dt.date.today() - dt.timedelta(days=3)
    cells = list(z["cells"])
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(lambda c: pull(c, end), cells))
    n25 = 365
    tmin_p = np.array([g[0] for g in got])
    tmax_p = np.array([g[1] for g in got])
    # cells outside PRISM's US grid (Canada, open lake) borrow the nearest cell that has PRISM
    has = ~np.isnan(tmin_p[:, :365]).all(1)
    ll = np.array([h3.cell_to_latlng(c) for c in cells])
    src = np.where(has, np.arange(len(cells)), 0)
    for i in np.where(~has)[0]:
        src[i] = np.where(has)[0][np.argmin(((ll[has] - ll[i]) ** 2).sum(1))]
    tmin_p, tmax_p = tmin_p[src], tmax_p[src]
    p25n, p25x = tmin_p[:, :n25], tmax_p[:, :n25]
    p26n = np.full((len(cells), 365), np.nan, np.float32)
    p26x = p26n.copy()
    k = min(tmin_p.shape[1] - n25, 365)
    p26n[:, :k], p26x[:, :k] = tmin_p[:, n25:n25 + k], tmax_p[:, n25:n25 + k]
    d25n, d25x = [], []
    for c in cells:
        d = fetch(c)[1]
        d = d[d.year == 2025].sort_values("yday")
        d25n.append(d["tmin (deg c)"].to_numpy())
        d25x.append(d["tmax (deg c)"].to_numpy())
    off_n = np.nanmean(np.array(d25n) - p25n, 1)
    off_x = np.nanmean(np.array(d25x) - p25x, 1)
    tn, tx = p26n + off_n[:, None], p26x + off_x[:, None]
    last = int(np.where(~np.isnan(tn).any(0) & ~np.isnan(tx).any(0))[0].max())  # newest day every cell has
    assert not (np.isnan(tn[:, :last + 1]).any() or np.isnan(tx[:, :last + 1]).any()), "PRISM gap before the newest day"
    tn_f, tx_f = np.nan_to_num(tn), np.nan_to_num(tx)  # only the days after `last`, which become NaN below
    dd = accumulate(tn_f, tx_f, 10.0).astype(np.float32)
    dd[:, last + 1:] = np.nan
    tmean = ((tn + tx) / 2).astype(np.float32)
    z["years"] = np.append(z["years"], YEAR)
    z["dd10"] = np.concatenate([z["dd10"], dd[:, None]], 1)
    z["tmean"] = np.concatenate([z["tmean"], tmean[:, None]], 1)
    z["last_day_2026"] = np.array(last + 1)  # 365-day calendar, 1 = 1 Jan
    np.savez_compressed(DATA / "warmth.npz", **z)
    print(f"2026 through day {last + 1}; {int((~has).sum())} cells borrowed; median offsets Tmin {np.median(off_n):+.2f} Tmax {np.median(off_x):+.2f} C")


if __name__ == "__main__":
    main()
