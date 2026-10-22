"""Daily Tmin/Tmax from Daymet v4 (1 km) at H3 hex centres, cached per hex."""
import io
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import h3
import numpy as np
import pandas as pd

URL = ("https://daymet.ornl.gov/single-pixel/api/data?lat={lat:.4f}&lon={lng:.4f}"
       "&vars=tmax,tmin&start={y0}-01-01&end={y1}-12-31")


def _fetch_one(hex_id, y0, y1, cache: Path):
    f = cache / f"{hex_id}_{y0}-{y1}.csv"
    if not f.exists():
        lat, lng = h3.cell_to_latlng(hex_id)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(URL.format(lat=lat, lng=lng, y0=y0, y1=y1), timeout=120) as r:
                    text = r.read().decode()
                break
            except Exception:
                time.sleep(2 ** attempt)
        else:
            return hex_id, None
        if "year,yday" not in text:
            return hex_id, None
        tmp = f.with_suffix(".tmp")
        tmp.write_text(text[text.index("year,yday"):])
        tmp.replace(f)  # atomic: a killed run never leaves a half-written cache file
    return hex_id, pd.read_csv(f)


def temperature_cube(hexes, y0, y1, cache: Path, workers=4):
    """Return (hexes, years, tmin, tmax) with tmin/tmax shaped [hex, year, 365].

    Daymet years are 365 days (31 Dec dropped in leap years), so day index i
    is Daymet yday i + 1. Sightings are converted to the same yday in prep.clean.
    """
    cache.mkdir(parents=True, exist_ok=True)
    years = np.arange(y0, y1 + 1)
    with ThreadPoolExecutor(workers) as ex:
        got = dict(ex.map(lambda h: _fetch_one(h, y0, y1, cache), hexes))
    missing = [h for h in hexes if got[h] is None]
    if missing:
        raise RuntimeError(f"Daymet failed for {len(missing)} hexes (e.g. {missing[:3]}); re-run to retry")
    keep = list(hexes)
    tmin = np.full((len(keep), len(years), 365), np.nan, dtype=np.float32)
    tmax = tmin.copy()
    for i, h in enumerate(keep):
        d = got[h]
        yi = d["year"].to_numpy() - y0
        di = d["yday"].to_numpy() - 1
        tmax[i, yi, di] = d["tmax (deg c)"].to_numpy()
        tmin[i, yi, di] = d["tmin (deg c)"].to_numpy()
    if np.isnan(tmin).any() or np.isnan(tmax).any():
        raise RuntimeError("Daymet cube has gaps; a NaN would poison every later cumulative degree-day")
    return keep, years, tmin, tmax
