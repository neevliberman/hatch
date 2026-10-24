#!/usr/bin/env python3
"""Build public/species/<key>/replay.json for one species in pipeline/species (same format as the luna replay).

    python3 pipeline/species/build.py japanese-beetle       # after fetch.py; offline, minutes on 4 cores

The firefly's recipe (pipeline/firefly/build_firefly.py), made per species:
- One generation a year, so there is no brood split: every band's window runs 1 March to the species' last day.
- The effort background is the species' own group (see species/__init__.py), the species itself left out.
- No latitude or daylength term ("p3_flat"), as for the firefly.

Nothing here was pre-registered: an exploratory fit, labelled as such in the app. `--score-only` prints the
leave-one-year-out table without writing anything (the species check in README.md).
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
from species import get  # noqa: E402
from species.fetch import effort_path, raw_path  # noqa: E402

SPEC = "p3_flat"
_G = {}


def one_generation(last_doy):
    def cutoffs(rec):
        return {b: last_doy for b in BAND_LABELS}
    return cutoffs


def records(raw, last_doy):
    d = clean(raw).copy()
    d["state"] = fdata.state_of(d.lat.to_numpy(), d.lng.to_numpy())
    d["hex_lat"] = [h3.cell_to_latlng(h)[0] for h in d.hex]
    return d[d.doy <= last_doy]


def load(sp, cells):
    raw = pd.read_parquet(raw_path(sp))
    d = records(raw, sp.last_doy)
    hexes = sorted(set(d.hex) | set(cells))
    hexes, years, tmin, tmax = temperature_cube(hexes, YEARS[0], YEARS[1], run.DATA / "daymet")
    cum = accumulate(tmin, tmax, BASE).astype(np.float32)
    E = fdata.effort_matrix(pd.read_parquet(effort_path(sp)), years)
    return raw, Context(index_records(d, hexes, years), list(hexes), years, cum, daily_from_cum(cum), E)


def _fold(year):
    return EV.loyo_fold(_G["ctx"], _G["H"], year, [M.SPECS[SPEC]])


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    score_only = "--score-only" in sys.argv
    sp = get(args[0] if args else "japanese-beetle")
    EV.cutoffs = one_generation(sp.last_doy)   # loyo_fold / holdout look this up at call time
    t0 = time.time()
    cells = BR.core_cells()
    raw, ctx = load(sp, cells)
    H = EV.helpers(ctx)
    assert set(EV.cutoffs(ctx.rec).values()) == {sp.last_doy}, "one-generation patch not in effect"
    print(f"{sp.name}: {len(ctx.rec)} fit records, {len(ctx.hexes)} hexes ({time.time()-t0:.0f}s)", flush=True)
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
    print(f"leave-one-year-out, {len(d)} strip-years\n" + tab.round(2).to_string(), flush=True)
    if htab is not None:
        print(f"holdout, {len(hd)} strip-years\n" + htab.round(2).to_string(), flush=True)
    print(f"noise floor {floor}", flush=True)
    if score_only:
        return
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

    disp, lic_dropped = BR.display_set(raw, [sp.last_doy] * len(BAND_LABELS))
    disp = disp[disp.doy <= sp.last_doy]
    sightings = [[int(x.id), int(x.year), int(x.doy), round(float(x.lat), 3), round(float(x.lng), 3), int(x.fl)]
                 for x in disp.itertuples()]
    fl = disp["fl"].to_numpy()
    seen = BR.seen_flags(cells, clean(raw).hex.unique())
    pooled = [f["fits"][SPEC] for f in folds]
    mae = lambda t, m: round(float(t.loc[m, "mae"]), 2)  # noqa: E731
    out = {
        "version": 1,
        "generated": dt.date.today().isoformat(),
        "species": {"name": sp.name, "sci": sp.sci, "inat_taxon": sp.taxon},
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
            "id": sp.model_id, "spec": SPEC,
            "summary": f"luna's P3 model, refit on {sp.name}: skew-normal warmth targets, base 10 C from 1 March, "
                       f"7-day flight life, effort = {sp.effort_label}, one generation, no latitude term; exploratory",
            "median_dd_at_lat": {str(lt): round(float(np.median([M.median_dd(p.params, spec, lt) for p in pooled])), 1)
                                 for lt in (38, 42, 46)},
            "loyo_mae": {"heat": mae(tab, SPEC), "p1": mae(tab, "p1"), "cal": mae(tab, "cal")},
            "holdout_mae": ({"heat": mae(htab, SPEC), "p1": mae(htab, "p1"), "cal": mae(htab, "cal"),
                             "cal_lat": mae(htab, "cal_lat")} if htab is not None else None),
            "noise_floor": round(float(floor["records"]), 2),
            "band_years": len(d), "holdout_band_years": 0 if hd is None else len(hd),
        },
        "interval": {"level": 0.8, "onset": [round(v, 1) for v in resid["onset"]],
                     "peak": [round(v, 1) for v in resid["peak"]]},
        "scorecard": BR.scorecard(rows, SPEC, None),
    }
    sp.out_dir.mkdir(parents=True, exist_ok=True)
    sp.replay.write_text(json.dumps(out, separators=(",", ":")))
    sp.result.write_text(json.dumps({"loyo": tab.round(3).reset_index().to_dict("records"),
                                     "holdout": htab.round(3).reset_index().to_dict("records") if htab is not None else None,
                                     "band_years": len(d), "holdout_band_years": 0 if hd is None else len(hd),
                                     "noise_floor": floor, "interval": out["interval"], "model": out["model"],
                                     "counts": out["counts"],
                                     "params": {str(int(f["year"])): {k: float(v) for k, v in f["fits"][SPEC].params.items() if k != "u"}
                                                for f in folds}}, indent=1) + "\n")
    print(f"wrote {sp.replay} ({sp.replay.stat().st_size/1024:.0f} KB) in {time.time()-t0:.0f}s")
    print(json.dumps(out["counts"]))


if __name__ == "__main__":
    main()
