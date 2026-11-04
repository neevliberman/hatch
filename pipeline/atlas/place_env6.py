"""Resolution-6 environmental place features for round 2 (PREREG_PLACE2.md, "Res-6 environment features").

Analogy: round 1 described each ~45 km patch of the map with one line ("warm, wet, wooded"); here each ~7 km patch
gets its own line, so a valley and the ridge next to it are no longer told apart only by their street address.

PRISM's 4 km grid comes from RCC-ACIS GridData in a few bbox calls with ACIS's own yearly reductions (not one daily
call per cell), and each res-6 cell takes the PRISM point nearest its centre (points PRISM does not cover are
skipped, so Ontario and open water borrow the nearest covered point). Land cover reuses round 1's cached WorldCover
overviews. Writes notebooks/data/atlas/place2/prism_grid.npz (a few MB; deleted at the end of the run).
  python3 pipeline/atlas/place_env6.py      # pulls the grids (~1 min) and prints the feature ranges
"""
import json
import sys
from pathlib import Path

import h3
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas.build_warmth import cells as grid_cells  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR, LAST_YEAR  # noqa: E402
from pipeline.atlas.place_env import LC, tile_name  # noqa: E402
from pipeline.live.sources import ACIS, _request  # noqa: E402

P2 = DATA / "place2"
WC = DATA / "place" / "worldcover"
RES = 6
CLIM = range(FIRST_YEAR, LAST_YEAR)  # 2015-2024, the folds' training years (as round 1)
TILES = [(w, s, w + 9, s + 7) for w in (-98, -89) for s in (36, 43)]
# (name, month-day of the yearly value, ACIS element): each a yearly sum or mean, ACIS units (°F, inches)
ELEMS = [("gdd", "06-30", {"name": "gdd", "base": 50, "duration": "std", "season_start": "03-01", "reduce": "sum"}),
         ("prcp_year", "12-31", {"name": "pcpn", "duration": "std", "season_start": "01-01", "reduce": "sum"}),
         ("prcp_grow", "09-30", {"name": "pcpn", "duration": "std", "season_start": "04-01", "reduce": "sum"}),
         ("tmin_janfeb", "02-28", {"name": "mint", "duration": "std", "season_start": "01-01", "reduce": "mean"}),
         ("tmin_dec", "12-31", {"name": "mint", "duration": "std", "season_start": "12-01", "reduce": "mean"})]
NAMES = ["norm_dd", "winter_tmin", "log_prcp_year", "log_prcp_growing", "elev"] + [f"lc_{k}" for k in LC]


def grid():
    """PRISM points of the box: lat, lng and the 2015-2024 mean of each element, plus elevation (m)."""
    f = P2 / "prism_grid.npz"
    if f.exists():
        return dict(np.load(f))
    cols = {k: [] for k in ["lat", "lng", "elev"] + [e[0] for e in ELEMS]}
    for w, s, e, n in TILES:
        meta = None
        for name, md, el in ELEMS:
            js = _request(ACIS, {"bbox": f"{w},{s},{e},{n}", "sdate": f"{FIRST_YEAR}-{md}", "edate": f"{LAST_YEAR}-12-31",
                                 "grid": "21", "meta": "ll,elev", "elems": [dict(el, interval=[1, 0, 0])]}, timeout=600)
            yrs = [np.array(v, float) for d, v in js["data"] if int(d[:4]) in CLIM]
            assert len(yrs) == len(CLIM), (name, [d for d, _ in js["data"]])
            a = np.stack(yrs)
            a[a <= -999] = np.nan
            cols[name].append(a.mean(0).ravel())
            meta = meta or js["meta"]
        cols["lat"].append(np.array(meta["lat"], float).ravel())
        cols["lng"].append(np.array(meta["lon"], float).ravel())
        el = np.array(meta["elev"], float).ravel()
        el[el <= -999] = np.nan
        cols["elev"].append(el)
        print(f"  PRISM tile {w},{s}: {cols['lat'][-1].size:,} points", flush=True)
    out = {k: np.concatenate(v) for k, v in cols.items()}
    ok = np.all([np.isfinite(v) for v in out.values()], axis=0)
    out = {k: v[ok] for k, v in out.items()}
    P2.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(f, **out)
    return out


def climate(cells):
    """[n, 5] norm_dd (°C-days), winter tmin (°C), log annual and Apr-Sep precipitation (mm), elevation (m)."""
    from scipy.spatial import cKDTree
    g = grid()
    k = np.cos(np.radians(42.5))
    tree = cKDTree(np.column_stack([g["lat"], g["lng"] * k]))
    ll = np.array([h3.cell_to_latlng(c) for c in cells])
    _, i = tree.query(np.column_stack([ll[:, 0], ll[:, 1] * k]))
    winter_f = (59 * g["tmin_janfeb"] + 31 * g["tmin_dec"]) / 90
    return np.column_stack([g["gdd"][i] * 5 / 9, (winter_f[i] - 32) * 5 / 9, np.log(g["prcp_year"][i] * 25.4),
                            np.log(g["prcp_grow"][i] * 25.4), g["elev"][i] * 0.3048])


def landcover(cells, child_res=RES + 2):
    """Shares of each land-cover group among the cell's 49 res-8 child centres (WorldCover overviews, ~300 m)."""
    tiles = {}
    pts = []
    for ci, c in enumerate(cells):
        for k in h3.cell_to_children(c, child_res):
            a, b = h3.cell_to_latlng(k)
            pts.append((ci, a, b))
    pts = np.array(pts)
    names = np.array([tile_name(a, b) for _, a, b in pts])
    val = np.zeros(len(pts), np.int16)
    for name in np.unique(names):
        t = WC / f"{name}_32.npz"
        if name not in tiles:
            tiles[name] = np.load(t) if t.exists() else None
        z = tiles[name]
        if z is None:
            continue
        arr, tr = z["arr"], z["transform"]
        m = names == name
        col = ((pts[m, 2] - tr[0]) / tr[2]).astype(int)
        row = ((tr[1] - pts[m, 1]) / tr[3]).astype(int)
        inside = (row >= 0) & (row < arr.shape[0]) & (col >= 0) & (col < arr.shape[1])
        v = np.zeros(m.sum(), np.int16)
        v[inside] = arr[row[inside], col[inside]]
        val[m] = v
    ci = pts[:, 0].astype(int)
    shares = np.zeros((len(cells), len(LC)))
    has = val > 0
    tot = np.bincount(ci[has], minlength=len(cells)).astype(float)
    for j, codes in enumerate(LC.values()):
        hit = has & np.isin(val, codes)
        shares[:, j] = np.bincount(ci[hit], minlength=len(cells)) / np.maximum(tot, 1)
    return shares


def features(cells):
    """Raw [n, 10] res-6 features in NAMES order for the given res-6 cells."""
    return np.column_stack([climate(cells), landcover(cells)]).astype(np.float64)


def grid_children():
    """The 1,217 res-4 grid cells' res-6 children: the set the features are standardised over."""
    return sorted({k for c in grid_cells() for k in h3.cell_to_children(c, RES)})


def main():
    g = grid()
    print(f"PRISM grid: {g['lat'].size:,} covered points", flush=True)
    cs = grid_children()
    f = features(cs)
    print(f"{len(cs):,} res-6 cells", flush=True)
    for n, col in zip(NAMES, f.T):
        print(f"  {n:18s} {np.percentile(col, 5):9.2f} .. {np.percentile(col, 95):9.2f}")
    (P2 / "env6_summary.json").write_text(json.dumps({"cells": len(cs), "prism_points": int(g["lat"].size)}))


if __name__ == "__main__":
    main()
