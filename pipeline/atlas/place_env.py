"""Environmental place features for the leave-region-out test (PREREG_PLACE.md), one row per warmth-grid cell.

Analogy: today the network knows a place by its street address (lat/lng). Here it gets the place's description
instead (how warm, how cold, how wet, how high, how wooded), so a town it has never visited can still be read by
what it is like, not where it is.

Writes, under notebooks/data/atlas/ (git-ignored):
- warmth.npz: the Atlas's warmth grid (cells, years, dd10 [cell, year, 365]) from PRISM daily via RCC-ACIS, since
  Daymet's server fails TLS verification here (PREREG_PLACE.md, "Data"). Same count as build_warmth.py.
- place/env.npz: cells, raw features [cell, k], their names.
Sources (all free, scriptable, cached under notebooks/data/atlas/place/):
- PRISM via RCC-ACIS: Tmin, Tmax, precipitation, 2015-2025 (one call per cell).
- Open-Meteo elevation API (Copernicus DEM 90 m): cell centre + its 7 res-5 children.
- ESA WorldCover 2021 v200 (10 m, read from its cloud-optimised GeoTIFF overviews): the cell's 343 res-7 children.
  python3 pipeline/atlas/place_env.py            # ~20 min the first time, cached after
"""
import datetime as dt
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import h3
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "notebooks"))
from hatch_p1.degree_days import accumulate  # noqa: E402
from pipeline.atlas.build_warmth import cells as grid_cells  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR, LAST_YEAR  # noqa: E402
from pipeline.atlas.weekly_static import by_year  # noqa: E402
from pipeline.live.sources import ACIS, _request, dates, weather_days  # noqa: E402

PLACE = DATA / "place"
PRISM = PLACE / "prism"
CLIM_YEARS = np.arange(FIRST_YEAR, LAST_YEAR)  # 2015-2024: the folds' training years
ELEV_URL = "https://api.open-meteo.com/v1/elevation?latitude={}&longitude={}"
WC_URL = ("/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
          "ESA_WorldCover_10m_2021_v200_{}_Map.tif")
LC = {"tree": (10,), "crop": (40,), "grass_shrub": (20, 30), "built": (50,), "wet": (80, 90, 95)}
NAMES = ["norm_dd", "winter_tmin", "log_prcp_year", "log_prcp_growing", "elev"] + [f"lc_{k}" for k in LC]


def prism(cell):
    """PRISM Tmin, Tmax (weather days) and precipitation (as filed), [years, 365] each; None if PRISM has no data."""
    f = PRISM / f"{cell}.npz"
    if f.exists():
        z = np.load(f)
        return None if z["tmin"].size == 0 else (z["tmin"], z["tmax"], z["prcp"])
    lat, lng = h3.cell_to_latlng(cell)
    start, end = dt.date(FIRST_YEAR, 1, 1), dt.date(LAST_YEAR, 12, 31) + dt.timedelta(days=1)
    js = _request(ACIS, {"loc": f"{lng:.4f},{lat:.4f}", "sdate": start.isoformat(), "edate": end.isoformat(),
                         "grid": "21", "elems": [{"name": "maxt", "units": "degreeC", "prec": 2},
                                                 {"name": "mint", "units": "degreeC", "prec": 2},
                                                 {"name": "pcpn", "units": "mm", "prec": 2}]})
    want = {d.isoformat(): i for i, d in enumerate(dates(start, end))}
    a = np.full((3, len(want)), np.nan)
    for day, *v in js.get("data", []):
        i = want.get(day)
        if i is not None:
            a[:, i] = [x if x is not None and x > -900 else np.nan for x in v]
    if np.isfinite(a[:2]).mean() < 0.99:
        np.savez(f, tmin=np.zeros(0), tmax=np.zeros(0), prcp=np.zeros(0))
        return None
    tmin, tmax = weather_days(a[1], a[0])
    out = [by_year(x, FIRST_YEAR, LAST_YEAR) for x in (tmin, tmax, a[2][:-1])]
    for x in out:  # a rare missing day: the mean of its neighbours
        bad = ~np.isfinite(x)
        if bad.any():
            flat = x.reshape(-1)
            idx = np.arange(flat.size)
            flat[bad.reshape(-1)] = np.interp(idx[bad.reshape(-1)], idx[~bad.reshape(-1)], flat[~bad.reshape(-1)])
    np.savez(f, tmin=out[0], tmax=out[1], prcp=out[2])
    return tuple(out)


def elevation(cs):
    f = PLACE / "elev.json"
    have = json.loads(f.read_text()) if f.exists() else {}
    pts = [(c, p) for c in cs if c not in have for p in [c, *h3.cell_to_children(c, 5)]]
    for i in range(0, len(pts), 100):
        chunk = pts[i:i + 100]
        ll = [h3.cell_to_latlng(p) for _, p in chunk]
        url = ELEV_URL.format(",".join(f"{a:.4f}" for a, _ in ll), ",".join(f"{b:.4f}" for _, b in ll))
        for attempt in range(6):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    el = json.load(r)["elevation"]
                break
            except Exception:
                time.sleep(2 ** attempt)
        else:
            raise RuntimeError("Open-Meteo elevation kept failing")
        for (c, _), e in zip(chunk, el):
            have.setdefault(c, []).append(e)
        f.write_text(json.dumps(have))
    return np.array([np.mean(have[c]) for c in cs])


def tile_name(lat, lng):
    a, b = int(np.floor(lat / 3) * 3), int(np.floor(lng / 3) * 3)
    return f"{'N' if a >= 0 else 'S'}{abs(a):02d}{'E' if b >= 0 else 'W'}{abs(b):03d}"


def landcover(cs, decim=32):
    """Shares of each LC group among the cell's res-7 child centres, read from WorldCover's overviews (~300 m)."""
    f = PLACE / "landcover.npz"
    if f.exists():
        z = np.load(f, allow_pickle=True)
        if list(z["cells"]) == list(cs):
            return z["shares"]
    import rasterio
    from rasterio.enums import Resampling
    pts = {c: [h3.cell_to_latlng(k) for k in h3.cell_to_children(c, 7)] for c in cs}
    by_tile = {}
    for c, ll in pts.items():
        for j, (a, b) in enumerate(ll):
            by_tile.setdefault(tile_name(a, b), []).append((c, j, a, b))
    val = {c: np.zeros(len(ll), np.int16) for c, ll in pts.items()}
    cache = PLACE / "worldcover"
    cache.mkdir(parents=True, exist_ok=True)
    for name, items in sorted(by_tile.items()):
        t = cache / f"{name}_{decim}.npz"
        if t.exists():
            z = np.load(t)
            arr, tr = z["arr"], z["transform"]
        else:
            try:
                with rasterio.open(WC_URL.format(name)) as src:
                    arr = src.read(1, out_shape=(src.height // decim, src.width // decim),
                                   resampling=Resampling.nearest)
                    b = src.bounds
                tr = np.array([b.left, b.top, (b.right - b.left) / arr.shape[1], (b.top - b.bottom) / arr.shape[0]])
            except Exception as e:  # no tile (open ocean); points stay 0 = no data
                print(f"  WorldCover {name}: {e}", flush=True)
                arr, tr = np.zeros((1, 1), np.uint8), np.array([0, 0, 1, 1.0])
            np.savez_compressed(t, arr=arr, transform=tr)
        for c, j, a, b in items:
            col, row = int((b - tr[0]) / tr[2]), int((tr[1] - a) / tr[3])
            if 0 <= row < arr.shape[0] and 0 <= col < arr.shape[1]:
                val[c][j] = arr[row, col]
        print(f"  WorldCover {name}: {len(items):,} points", flush=True)
    shares = np.zeros((len(cs), len(LC)))
    for i, c in enumerate(cs):
        v = val[c][val[c] > 0]
        if len(v):
            shares[i] = [np.isin(v, codes).mean() for codes in LC.values()]
    np.savez_compressed(f, cells=np.array(cs), shares=shares)
    return shares


def main():
    PRISM.mkdir(parents=True, exist_ok=True)
    cs = grid_cells()
    with ThreadPoolExecutor(4) as ex:
        got = list(ex.map(prism, cs))
    has = np.array([g is not None for g in got])
    ll = np.array([h3.cell_to_latlng(c) for c in cs])
    j = np.where(has)[0]
    src = np.array([i if has[i] else int(j[np.argmin(((ll[j] - ll[i]) ** 2).sum(1))]) for i in range(len(cs))])
    tmin = np.stack([got[s][0] for s in src]).astype(np.float32)
    tmax = np.stack([got[s][1] for s in src]).astype(np.float32)
    prcp = np.stack([got[s][2] for s in src]).astype(np.float32)
    years = np.arange(FIRST_YEAR, LAST_YEAR + 1)
    dd = accumulate(tmin, tmax, 10.0).astype(np.float32)
    np.savez_compressed(DATA / "warmth.npz", cells=np.array(cs), years=years, dd10=dd,
                        tmean=((tmin + tmax) / 2).astype(np.float32), land=has, source=np.array("PRISM via RCC-ACIS"))
    cy = np.isin(years, CLIM_YEARS)
    norm_dd = dd[:, cy, 180].mean(1)  # = data.Warmth.typical_july()
    winter = np.concatenate([tmin[:, cy, :59], tmin[:, cy, 334:]], 2).mean((1, 2))
    p_year = np.log(prcp[:, cy].sum(2).mean(1))
    p_grow = np.log(prcp[:, cy, 90:273].sum(2).mean(1))
    print(f"PRISM: {len(cs)} cells, {int((~has).sum())} borrow a neighbour", flush=True)
    elev = elevation(cs)
    print(f"elevation: {elev.min():.0f}..{elev.max():.0f} m", flush=True)
    lc = landcover(cs)
    feats = np.column_stack([norm_dd, winter, p_year, p_grow, elev, lc]).astype(np.float32)
    assert np.isfinite(feats).all()
    np.savez_compressed(PLACE / "env.npz", cells=np.array(cs), feats=feats, names=np.array(NAMES))
    for n, col in zip(NAMES, feats.T):
        print(f"  {n:18s} {np.percentile(col, 5):9.2f} .. {np.percentile(col, 95):9.2f}")


if __name__ == "__main__":
    main()
