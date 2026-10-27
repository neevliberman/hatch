"""Warmth grid for the Atlas: degree-days banked since 1 March, per H3 res-4 cell, per day, 2015-2025 (Daymet v4, 1 km).

One Daymet single-pixel call per cell centre (~1,100 cells, cached in notebooks/data/atlas/daymet/). Cells over open
water have no Daymet pixel; they borrow the nearest land cell, so every sighting has a warmth clock.
Writes notebooks/data/atlas/warmth.npz: cells, years, dd10 [cell, year, 365] (base 10 °C, upper 30 °C, double sine,
the luna model's own count) and tmean [cell, year, 365].
  python3 pipeline/atlas/build_warmth.py
"""
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import h3
import numpy as np
import pandas as pd

from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "notebooks"))
from hatch_p1.degree_days import accumulate  # noqa: E402
from pipeline.atlas.config import BOX, DATA, FIRST_YEAR, LAST_YEAR, WARMTH_RES  # noqa: E402

CACHE = DATA / "daymet"
URL = ("https://daymet.ornl.gov/single-pixel/api/data?lat={:.4f}&lon={:.4f}&vars=tmax,tmin"
       f"&start={FIRST_YEAR}-01-01&end={LAST_YEAR}-12-31")


def cells():
    pad = 0.4  # cover cells whose centre sits just outside the box
    poly = h3.LatLngPoly([(BOX["s"] - pad, BOX["w"] - pad), (BOX["s"] - pad, BOX["e"] + pad),
                          (BOX["n"] + pad, BOX["e"] + pad), (BOX["n"] + pad, BOX["w"] - pad)])
    return sorted(h3.polygon_to_cells(poly, WARMTH_RES))


def fetch(cell):
    f = CACHE / f"{cell}.csv"
    if not f.exists():
        lat, lng = h3.cell_to_latlng(cell)
        text = ""
        for attempt in range(5):
            try:
                with urllib.request.urlopen(URL.format(lat, lng), timeout=120) as r:
                    text = r.read().decode()
                break
            except Exception as e:  # 400 = no Daymet pixel (water, or outside the grid)
                if getattr(e, "code", None) == 400:
                    break
                time.sleep(2 ** attempt)
        if "year,yday" not in text:
            f.with_suffix(".none").touch()
            return cell, None
        f.write_text(text[text.index("year,yday"):])
    return cell, pd.read_csv(f)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    cs = cells()
    todo = [c for c in cs if not (CACHE / f"{c}.none").exists()]
    with ThreadPoolExecutor(6) as ex:
        got = dict(ex.map(fetch, todo))
    land = [c for c in cs if got.get(c) is not None]
    years = np.arange(FIRST_YEAR, LAST_YEAR + 1)
    tmin = np.full((len(land), len(years), 365), np.nan, np.float32)
    tmax = tmin.copy()
    for i, c in enumerate(land):
        d = got[c]
        tmax[i, d["year"] - FIRST_YEAR, d["yday"] - 1] = d["tmax (deg c)"]
        tmin[i, d["year"] - FIRST_YEAR, d["yday"] - 1] = d["tmin (deg c)"]
    assert not np.isnan(tmin).any(), "Daymet gaps"
    dd = accumulate(tmin, tmax, 10.0).astype(np.float32)
    tmean = ((tmin + tmax) / 2).astype(np.float32)
    # water cells borrow the nearest land cell
    ll = np.array([h3.cell_to_latlng(c) for c in land])
    idx = {c: i for i, c in enumerate(land)}
    src = []
    for c in cs:
        if c in idx:
            src.append(idx[c])
        else:
            p = np.array(h3.cell_to_latlng(c))
            src.append(int(np.argmin(((ll - p) ** 2).sum(1))))
    src = np.array(src)
    np.savez_compressed(DATA / "warmth.npz", cells=np.array(cs), years=years, dd10=dd[src], tmean=tmean[src],
                        land=np.array([c in idx for c in cs]))
    print(f"{len(cs)} cells, {len(land)} land; median DD by 1 Jul 2025: {np.median(dd[:, -1, 181]):.0f}")


if __name__ == "__main__":
    main()
