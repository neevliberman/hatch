#!/usr/bin/env python3
"""C9 (FROZEN_P4.md): would a machine-learning model beat the warmth-bank model?

Gradient-boosted trees (LightGBM) and, as a plainer check, a ridge regression, trained on band/cell-year weather
features to predict onset and peak directly. Leave-one-year-out like everything else: for each held-out year, the
brood cut-offs, targets, hex weights and the trees all come from the other years.

    python3 pipeline/p4/ml_c9.py [--midwest-only]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from p4 import run_p4 as R, wide as W  # noqa: E402
from fit import evaluate as EV  # noqa: E402

DOYS = np.arange(75, 196, 15)
THRESH = np.arange(50, 501, 50)


def features(cum, hx, w, yi, lat, chill):
    c = (cum[hx, yi, :] * w[:, None]).sum(0)          # hex-weighted cumulative degree-days
    f = {f"dd{d}": c[d - 1] for d in DOYS}
    for t in THRESH:
        f[f"day{t}"] = float(np.searchsorted(c, t)) + 1
    f["lat"] = lat
    f["chill"] = float((chill[hx, yi] * w).sum())
    return f


def cell_rows(rec, cum, year, mw_cuts, w_cuts, weight_rec):
    """One row per cell-year in `rec` with >= 20 first-brood records: features + onset/peak (day index)."""
    out = []
    r = R._with_cut(rec, mw_cuts, w_cuts)
    r = r.assign(cell=np.where(r.region == "mw", "mw:" + r.band.astype(str), r.region))
    wr = R._with_cut(weight_rec, mw_cuts, w_cuts)
    wr = wr.assign(cell=np.where(wr.region == "mw", "mw:" + wr.band.astype(str), wr.region))
    for (c, y), g in r.groupby(["cell", "year"]):
        if len(g) < EV.MIN_N:
            continue
        hx, w = EV.hex_weights(wr[wr.cell == c])
        if len(hx) == 0:
            continue
        lat = float((R.D.hex_lat[hx] * w).sum())
        f = features(cum, hx, w, int(y - R.D.years[0]), lat, R.D.chill)
        out.append({"cell": c, "year": int(y), "n": len(g), "onset": g.t.quantile(.1), "peak": g.t.median(), **f})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--midwest-only", action="store_true")
    a = ap.parse_args()
    import lightgbm as lgb
    from sklearn.linear_model import RidgeCV
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    R.D = R.load(midwest_only=a.midwest_only)
    cum = np.cumsum(R.inc_cube((R.BASE, R.UPPER, 0)), -1)
    rec = R.D.rec
    rows = []
    for year in [int(y) for y in R.D.years]:
        tr_all = rec[rec.year != year]
        mw_cuts = EV.cutoffs(tr_all[tr_all.region == "mw"])
        w_cuts = R._wide_cuts(tr_all)
        train = pd.DataFrame(cell_rows(tr_all, cum, year, mw_cuts, w_cuts, tr_all))
        test = pd.DataFrame(cell_rows(rec[rec.year == year], cum, year, mw_cuts, w_cuts, tr_all))
        if test.empty:
            continue
        cols = [c for c in train.columns if c.startswith(("dd", "day", "lat", "chill"))]
        for tgt in ("onset", "peak"):
            gbm = lgb.LGBMRegressor(n_estimators=300, learning_rate=0.03, num_leaves=8, min_child_samples=10,
                                    subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1, random_state=0)
            gbm.fit(train[cols], train[tgt])
            test[f"gbm_{tgt}"] = gbm.predict(test[cols])
            rid = make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-2, 3, 20)))
            rid.fit(train[cols], train[tgt])
            test[f"ridge_{tgt}"] = rid.predict(test[cols])
        rows.append(test)
        print(year, len(train), len(test), flush=True)
    d = pd.concat(rows, ignore_index=True)
    d["set"] = np.where(d.cell.str.startswith("mw:"), "mw", "east")
    tag = "c9_mw" if a.midwest_only else "c9"
    d.to_csv(R.RESULTS / f"rows_{tag}.csv", index=False, float_format="%.2f")
    res = {}
    for s, g in d.groupby("set"):
        res[s] = {m: round(float(((g[f"{m}_onset"] - g.onset).abs().mean() + (g[f"{m}_peak"] - g.peak).abs().mean()) / 2), 3)
                  for m in ("gbm", "ridge")} | {"n": len(g)}
    print(tag, json.dumps(res))
    s = json.loads((R.RESULTS / "summary.json").read_text())
    s[tag] = res
    (R.RESULTS / "summary.json").write_text(json.dumps(s, indent=1))


if __name__ == "__main__":
    main()
