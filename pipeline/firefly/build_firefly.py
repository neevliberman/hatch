#!/usr/bin/env python3
"""Build public/firefly-replay.json: the common eastern firefly (Photinus pyralis) as Hatch's second species.

Same model and file format as the luna replay (pipeline/fit, pipeline/replay/build_replay.py), with three changes:
- One generation a year, so there is no brood split: every band's window runs 1 March to day 240 (28 August).
- The effort background is beetle records per state (minus fireflies), not moth records.
- No latitude or daylength term ("p3_flat"): P3 found neither helped luna, and P3's write-up recommends dropping it.

Nothing here was pre-registered: this is a first, exploratory fit, labelled as such in the app.
Run `python3 pipeline/firefly/fetch.py` first (downloads, cached), then this (offline, ~minutes on 4 cores).
"""
import datetime as dt
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

import h3  # noqa: E402
import pandas as pd  # noqa: E402
from hatch_p1 import run  # noqa: E402
from hatch_p1.daymet import temperature_cube  # noqa: E402
from hatch_p1.degree_days import accumulate  # noqa: E402
from hatch_p1.prep import BAND_LABELS, BANDS, YEARS, clean  # noqa: E402
from fit import data as fdata, evaluate as EV, model as M  # noqa: E402
from fit.context import BASE, Context, daily_from_cum, index_records  # noqa: E402
from replay import build_replay as BR  # noqa: E402
from firefly.fetch import EFFORT, RAW, TAXON  # noqa: E402

OUT = ROOT / "public" / "firefly-replay.json"
RESULT = ROOT / "pipeline" / "firefly" / "result.json"
SPEC = "p3_flat"
LAST_DOY = 240     # end of the fit window (model.D1); later records are left out of the fit and the map
MODEL_ID = "firefly-v0"


def one_generation(rec):
    """Fireflies have one flight season a year: no brood split, the whole window counts."""
    return {b: LAST_DOY for b in BAND_LABELS}


EV.cutoffs = one_generation   # loyo_fold / holdout look this up at call time


def records(raw):
    d = clean(raw).copy()
    d["state"] = fdata.state_of(d.lat.to_numpy(), d.lng.to_numpy())
    d["hex_lat"] = [h3.cell_to_latlng(h)[0] for h in d.hex]
    return d[d.doy <= LAST_DOY]


def load(cells):
    raw = pd.read_parquet(RAW)
    d = records(raw)
    hexes = sorted(set(d.hex) | set(cells))
    hexes, years, tmin, tmax = temperature_cube(hexes, YEARS[0], YEARS[1], run.DATA / "daymet")
    cum = accumulate(tmin, tmax, BASE).astype(np.float32)
    E = fdata.effort_matrix(pd.read_parquet(EFFORT), years)
    return raw, Context(index_records(d, hexes, years), list(hexes), years, cum, daily_from_cum(cum), E)


_G = {}


def _fold(year):
    return EV.loyo_fold(_G["ctx"], _G["H"], year, [M.SPECS[SPEC]])


def main():
    t0 = time.time()
    cells = BR.core_cells()
    raw, ctx = load(cells)
    H = EV.helpers(ctx)
    assert set(EV.cutoffs(ctx.rec).values()) == {LAST_DOY}, "one-generation patch not in effect"
    print(f"{len(ctx.rec)} fit records, {len(ctx.hexes)} hexes ({time.time()-t0:.0f}s)", flush=True)
    _G.update(ctx=ctx, H=H)
    with mp.get_context("fork").Pool(4) as pool:
        hold_async = pool.apply_async(EV.holdout, (ctx, H, [M.SPECS[SPEC]]))
        folds = pool.map(_fold, [int(y) for y in ctx.years])
        hold = hold_async.get()
    print(f"fits done ({time.time()-t0:.0f}s)", flush=True)

    rows = [r for f in folds for r in f["rows"]]
    recs = {k: v for f in folds for k, v in f["test_records"].items()}
    models = [SPEC, "p1", "cal"]
    d = EV.errors(rows, models)
    tab = EV.mae_table(d, models).set_index("model")
    _, floor = EV.noise_floor(d, recs)
    hd = EV.errors(hold["rows"], models + ["cal_lat"]) if hold["rows"] else None
    htab = EV.mae_table(hd, models + ["cal_lat"]).set_index("model") if hd is not None else None
    print(tab.round(2).to_string(), flush=True)
    if htab is not None:
        print("holdout\n" + htab.round(2).to_string(), flush=True)
    resid = {"onset": np.percentile(-d[f"{SPEC}_eo"], [10, 90]).tolist(),
             "peak": np.percentile(-d[f"{SPEC}_ep"], [10, 90]).tolist()}

    scores = [{"band": x["band"], "year": x["year"], "n": x["n"],
               "obs_onset": round(x["onset"] + 1, 1), "obs_peak": round(x["peak"] + 1, 1),
               "heat_onset": round(float(x[f"{SPEC}_onset"]) + 1, 1), "heat_peak": round(float(x[f"{SPEC}_peak"]) + 1, 1),
               "cal_onset": round(x["cal_onset"] + 1, 1), "cal_peak": round(x["cal_peak"] + 1, 1),
               "p1_onset": round(float(x["p1_onset"]) + 1, 1), "p1_peak": round(float(x["p1_peak"]) + 1, 1)}
              for x in sorted(rows, key=lambda r: (r["band"], r["year"]))]

    spec = M.SPECS[SPEC]
    hi = {h: i for i, h in enumerate(ctx.hexes)}
    cidx = np.array([hi[c] for c in cells])
    forecast = BR.cell_forecasts(cells, ctx.inc[cidx], ctx.years,
                                 {int(f["year"]): f["fits"][SPEC].without_year() for f in folds},
                                 {int(f["year"]): f["cuts"] for f in folds}, ctx.E, spec)

    disp, lic_dropped = BR.display_set(raw, [LAST_DOY] * len(BAND_LABELS))
    disp = disp[disp.doy <= LAST_DOY]
    sightings = [[int(x.id), int(x.year), int(x.doy), round(float(x.lat), 3), round(float(x.lng), 3), int(x.fl)]
                 for x in disp.itertuples()]
    fl = disp["fl"].to_numpy()
    seen = BR.seen_flags(cells, clean(raw).hex.unique())
    pooled = [f["fits"][SPEC] for f in folds]
    mae = lambda t, m: round(float(t.loc[m, "mae"]), 2)  # noqa: E731
    out = {
        "version": 1,
        "generated": dt.date.today().isoformat(),
        "species": {"name": "Common eastern firefly", "sci": "Photinus pyralis", "inat_taxon": TAXON},
        "years": [int(y) for y in ctx.years],
        "quantiles": BR.QUANTILES,
        "cells": cells,
        "seen": seen,
        "forecast": forecast,
        "bands": [{"label": lab, "lo": lo, "hi": hi_, "cutoff": None} for lab, (lo, hi_) in zip(BAND_LABELS, zip(BANDS[:-1], BANDS[1:]))],
        "scores": scores,
        "sightings": sightings,
        "counts": {"sightings": len(sightings), "first_brood": int((fl & 1 == 0).sum()), "second_brood": 0,
                   "approximate": int((fl & 2 > 0).sum()), "fit_records": int(len(ctx.rec)),
                   "observers": int(disp.user_id.nunique()), "cells": len(cells), "seen_cells": int(sum(seen)),
                   "licence_dropped": int(lic_dropped)},
        "licences": {k: int((disp.license_code.str.lower() == k).sum()) for k in BR.LICENCES},
        "model": {
            "id": MODEL_ID, "spec": SPEC,
            "summary": "luna's P3 model, refit on fireflies: skew-normal warmth targets, base 10 C from 1 March, "
                       "7-day flight life, beetle-effort background, one generation, no latitude term; exploratory",
            "median_dd_at_lat": {str(lt): round(float(np.median([M.median_dd(p.params, spec, lt) for p in pooled])), 1)
                                 for lt in (38, 42, 46)},
            "loyo_mae": {"heat": mae(tab, SPEC), "p1": mae(tab, "p1"), "cal": mae(tab, "cal")},
            "holdout_mae": ({"heat": mae(htab, SPEC), "p1": mae(htab, "p1"), "cal": mae(htab, "cal"),
                             "cal_lat": mae(htab, "cal_lat")} if htab is not None else None),
            "noise_floor": round(float(floor["records"]), 2),
        },
        "interval": {"level": 0.8, "onset": [round(v, 1) for v in resid["onset"]],
                     "peak": [round(v, 1) for v in resid["peak"]]},
        "scorecard": BR.scorecard(rows, SPEC, None),
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    RESULT.write_text(json.dumps({"loyo": tab.round(3).reset_index().to_dict("records"),
                                  "holdout": htab.round(3).reset_index().to_dict("records") if htab is not None else None,
                                  "band_years": len(d), "holdout_band_years": 0 if hd is None else len(hd),
                                  "noise_floor": floor, "interval": out["interval"], "model": out["model"],
                                  "counts": out["counts"],
                                  "params": {str(int(f["year"])): {k: float(v) for k, v in f["fits"][SPEC].params.items() if k != "u"}
                                             for f in folds}}, indent=1) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB) in {time.time()-t0:.0f}s")
    print(json.dumps(out["counts"]))


if __name__ == "__main__":
    main()
