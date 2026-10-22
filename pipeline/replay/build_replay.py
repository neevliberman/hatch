#!/usr/bin/env python3
"""Build src/data/luna-replay.json for the Hatch "season replay" (see README.md).

Reuses the P1 code in notebooks/hatch_p1 (imported, not copied). Raw downloads are
cached under notebooks/data/ (gitignored), so reruns are offline.
"""
import datetime as dt
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))

import h3  # noqa: E402
from hatch_p1 import inat, model, run  # noqa: E402
from hatch_p1.daymet import _fetch_one, temperature_cube  # noqa: E402
from hatch_p1.prep import BANDS, BAND_LABELS, RES, YEARS, clean  # noqa: E402

OUT = ROOT / "src" / "data" / "luna-replay.json"
STATES = ROOT / "src" / "data" / "midwest-states.json"
RAW = run.DATA / "luna_replay_inat.parquet"   # P1's columns + license_code
TAXON = 47916
QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95]
BASE = 10.0
MAX_DOY = 300            # forecast quantile must be reached by this calendar day
DISPLAY_DOY = (60, 300)
SECOND_BROOD_FALLBACK = 240
APPROX_ACCURACY_M = 5000
LICENCES = ("cc0", "cc-by", "cc-by-nc")   # repo is public: no ND / SA variants, no unlicensed


# ---------------------------------------------------------------- fetching
def fetch_luna(out: Path = RAW) -> pd.DataFrame:
    """Same query and columns as hatch_p1.inat.fetch_taxon, plus license_code."""
    if out.exists():
        return pd.read_parquet(out)
    rows, last = [], 0
    while True:
        js = inat._get("observations", {
            "taxon_id": TAXON, "place_id": ",".join(map(str, inat.MIDWEST_PLACES)),
            "per_page": 200, "order_by": "id", "order": "asc", "id_above": last})
        res = js["results"]
        if not res:
            break
        for o in res:
            r = inat._row(o)
            r["license_code"] = o.get("license_code")
            rows.append(r)
        last = res[-1]["id"]
        time.sleep(1)
    df = pd.DataFrame(rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    return df


# ---------------------------------------------------------------- cells
def core_cells(states_path: Path = STATES, res: int = RES) -> list:
    """Res-4 cells whose centre is inside any feature with properties.core == true."""
    gj = json.loads(states_path.read_text())
    cells = set()
    for f in gj["features"]:
        if f["properties"].get("core") is True:
            cells.update(h3.geo_to_cells(f["geometry"], res))
    return sorted(cells)


def seen_flags(cells, record_hexes):
    """1 if the cell or any k=1 neighbour holds a record hex."""
    rec = set(record_hexes)
    return [int(any(c in rec for c in h3.grid_disk(cell, 1))) for cell in cells]


# ---------------------------------------------------------------- forecast
def first_reach(cdf, quantiles=QUANTILES, max_doy=MAX_DOY):
    """Calendar day-of-year on which `cdf` first reaches each quantile, else None.

    `cdf[..., i]` is the share "out" on day index i, which is calendar day i + 1
    (Daymet index i = yday i + 1, yday = calendar doy). Same rule as P1's
    np.searchsorted(share, q) (first index with share >= q), shifted by +1.
    """
    cdf = np.asarray(cdf, float)
    out = []
    for q in quantiles:
        i = int(np.searchsorted(cdf, q, side="left"))
        out.append(i + 1 if i + 1 <= max_doy and i < len(cdf) else None)
    return out


def cell_forecast(dd_cell, train_dd, quantiles=QUANTILES, max_doy=MAX_DOY):
    """dd_cell: cumulative degree-days by day index (365,) for one cell-year.
    train_dd: degree-days at the training first-brood sightings (ECDF)."""
    srt = np.sort(np.asarray(train_dd, float))
    cdf = np.searchsorted(srt, dd_cell, side="right") / len(srt)
    return first_reach(cdf, quantiles, max_doy)


def typical(per_year):
    """per_year: list over years of [q05..q95] (None allowed) -> per-quantile median."""
    out = []
    for k in range(len(per_year[0])):
        v = [y[k] for y in per_year if y[k] is not None]
        if len(v) * 2 < len(per_year) or not v:
            out.append(None)
        else:
            out.append(int(np.floor(np.median(v) + 0.5)))
    return out


# ---------------------------------------------------------------- display set
def band_index(lat):
    return np.clip(np.digitize(lat, BANDS[1:-1]), 0, len(BAND_LABELS) - 1)


def flags_for(doy, band_i, cutoffs, approximate):
    """bit0 = second brood, bit1 = approximate location."""
    cut = np.array([(c if c is not None else SECOND_BROOD_FALLBACK) for c in cutoffs])
    second = (np.asarray(doy) > cut[band_i]) | (np.asarray(doy) > SECOND_BROOD_FALLBACK)
    return second.astype(int) + 2 * np.asarray(approximate).astype(int)


def display_set(raw, cutoffs):
    d = raw.copy()
    d["date"] = pd.to_datetime(d["observed_on"], errors="coerce")
    d = d.dropna(subset=["date", "lat", "lng"])
    d["year"], d["doy"] = d["date"].dt.year, d["date"].dt.dayofyear
    keep = ((d.quality_grade == "research") & ~d.captive.fillna(False).astype(bool)
            & (d.life_stage.isna() | (d.life_stage == "adult"))
            & d.year.between(*YEARS) & d.doy.between(*DISPLAY_DOY)
            )
    d = d[keep].copy()
    d["hex"] = [h3.latlng_to_cell(a, b, RES) for a, b in zip(d.lat, d.lng)]
    n_all = len(d.drop_duplicates(["user_id", "hex", "date"]))   # before the licence filter
    d = d[d.license_code.fillna("").str.lower().isin(LICENCES)]
    d = d.drop_duplicates(["user_id", "hex", "date"])
    dropped = n_all - len(d)
    approx = (d.obscured.fillna(False).astype(bool)
              | (d.geoprivacy.notna() & (d.geoprivacy != ""))
              | (d.accuracy_m.fillna(0) > APPROX_ACCURACY_M))
    d["fl"] = flags_for(d.doy.to_numpy(), band_index(d.lat.to_numpy()), cutoffs, approx.to_numpy())
    return d.sort_values(["year", "doy", "id"]), dropped


# ---------------------------------------------------------------- Daymet
def daymet_cube(hexes, cache: Path):
    """Temperature cube for all hexes; failures are filled from the nearest good hex."""
    cache.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(4) as ex:
        got = dict(ex.map(lambda h: _fetch_one(h, YEARS[0], YEARS[1], cache), hexes))
    bad = [h for h in hexes if got[h] is None]
    if len(bad) > 0.02 * len(hexes):
        raise SystemExit(f"Daymet failed for {len(bad)}/{len(hexes)} hexes (>2%); stopping. e.g. {bad[:3]}")
    good = [h for h in hexes if got[h] is not None]
    _, years, tmin_g, tmax_g = temperature_cube(good, YEARS[0], YEARS[1], cache)
    pos = {h: i for i, h in enumerate(good)}
    tmin = np.empty((len(hexes),) + tmin_g.shape[1:], np.float32)
    tmax = tmin.copy()
    for i, h in enumerate(hexes):
        src = h
        if h not in pos:
            src = min(good, key=lambda g: h3.great_circle_distance(h3.cell_to_latlng(h), h3.cell_to_latlng(g), "km"))
        tmin[i], tmax[i] = tmin_g[pos[src]], tmax_g[pos[src]]
    return years, tmin, tmax, len(bad)


# ---------------------------------------------------------------- main
def main():
    t0 = time.time()
    raw = fetch_luna()
    cells = core_cells()
    print(f"{len(cells)} core cells", flush=True)

    rec, cut = run.load(RAW.name)                      # P1 fit set, brood-split at frac=0.8
    cleaned = clean(raw)                               # for "seen" (any brood)
    all_hexes = sorted(set(cells) | set(rec.hex.unique()))
    years, tmin, tmax, n_filled = daymet_cube(all_hexes, run.DATA / "daymet")
    hi = {h: i for i, h in enumerate(all_hexes)}
    dd = model.dd_cube(tmin, tmax, BASE)

    r = rec.copy()
    r["h"] = r.hex.map(hi)
    r["y"] = r.year - years[0]
    r["t"] = r.yday - 1
    r["band"] = r.band.astype(str)

    # ---- P1 scores (exploratory empirical heat vs calendar), LOYO
    tg = model.targets(r)
    heat = model.empirical_predictions(r, tg, dd, years)
    cal = model.calendar_predictions(tg)
    mh, mc = model.score(tg, heat), model.score(tg, cal)
    print(f"band-years {mh['n_band_years']}  heat MAE {mh['mae']:.2f} (on {mh['mae_onset']:.2f} pk {mh['mae_peak']:.2f})"
          f"  calendar MAE {mc['mae']:.2f} (on {mc['mae_onset']:.2f} pk {mc['mae_peak']:.2f})", flush=True)
    if not (len(tg) == 31 and abs(mh["mae"] - 4.0) < 0.15 and abs(mc["mae"] - 7.3) < 0.15):
        raise SystemExit("ACCEPTANCE FAILED: expected 31 band-years, heat ~4.0 d, calendar ~7.3 d. Not writing output.")
    m = tg.merge(heat, on=["band", "year"]).merge(cal, on=["band", "year"], suffixes=("_h", "_c"))
    scores = [{"band": x.band, "year": int(x.year), "n": int(x.n),
               "obs_onset": round(float(x.onset) + 1, 1), "obs_peak": round(float(x.peak) + 1, 1),
               "heat_onset": round(float(x.onset_pred_h) + 1, 1), "heat_peak": round(float(x.peak_pred_h) + 1, 1),
               "cal_onset": round(float(x.onset_pred_c) + 1, 1), "cal_peak": round(float(x.peak_pred_c) + 1, 1)}
              for x in m.itertuples()]

    # ---- per-cell forecast, leave-one-year-out
    cidx = np.array([hi[c] for c in cells])
    forecast = {}
    for yi, y in enumerate(years):
        train_dd = model.dd_at_sightings(r[r.year != y], dd)
        forecast[str(int(y))] = [cell_forecast(dd[c, yi, :], train_dd) for c in cidx]
    forecast["typical"] = [typical([forecast[str(int(y))][k] for y in years]) for k in range(len(cells))]

    # ---- display sightings
    disp, lic_dropped = display_set(raw, [cut[b] for b in BAND_LABELS])
    sightings = [[int(x.id), int(x.year), int(x.doy), round(float(x.lat), 3), round(float(x.lng), 3), int(x.fl)]
                 for x in disp.itertuples()]
    fl = disp["fl"].to_numpy()
    licences = {k: int((disp.license_code.str.lower() == k).sum()) for k in LICENCES}
    seen = seen_flags(cells, cleaned.hex.unique())

    lo_hi = list(zip(BANDS[:-1], BANDS[1:]))
    out = {
        "version": 1,
        "generated": dt.date.today().isoformat(),
        "species": {"name": "Luna moth", "sci": "Actias luna", "inat_taxon": TAXON},
        "years": [int(y) for y in years],
        "quantiles": QUANTILES,
        "cells": cells,
        "seen": seen,
        "forecast": forecast,
        "bands": [{"label": lab, "lo": lo, "hi": hi_, "cutoff": (int(cut[lab]) if cut[lab] is not None else None)}
                  for lab, (lo, hi_) in zip(BAND_LABELS, lo_hi)],
        "scores": scores,
        "sightings": sightings,
        "counts": {"sightings": len(sightings), "first_brood": int((fl & 1 == 0).sum()),
                   "second_brood": int((fl & 1).sum()), "approximate": int((fl & 2 > 0).sum()),
                   "fit_records": int(len(rec)), "observers": int(disp.user_id.nunique()),
                   "cells": len(cells), "seen_cells": int(sum(seen)), "daymet_filled": int(n_filled),
                   "licence_dropped": int(lic_dropped)},
        "licences": licences,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB) in {time.time()-t0:.0f}s")
    print(json.dumps(out["counts"]))


if __name__ == "__main__":
    main()
