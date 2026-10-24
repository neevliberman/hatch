#!/usr/bin/env python3
"""Leave-one-year-out + "data-poor" test of the pooled model. EXPLORATORY: nothing here was pre-registered.

For each held-out year Y and each species s:
- training = s's records from the other 10 years (first brood, cut-offs from those years only, P3 rule);
- targets  = s's year-Y band-years with >= 20 records (onset = 10th percentile day, peak = median day);
- training is cut down to n = 10 / 25 / 50 random records (2 draws each by default), or kept whole ("all");
- every arm then predicts the same targets:
    cal        the n records' own dates (per latitude band if the band has >= 5 of them, else all n)
    cal_lat    the n records' dates slid by latitude (a straight line through day vs latitude)
    p1         P1's empirical heat model on the n records
    p3         P3's own fitter (pipeline/fit/model.py, P3.1 bounds, no year effect), species alone
    unpooled   this file's fitter, species alone (same likelihood as p3, curve by median/spread/skew)
    shared     pooled: prior learned from the other species' full-training fits (no traits)
    traits     pooled: same, with the prior's median target depending on family, size, voltinism, host
  and with n = 0, "prior_shared" / "prior_traits": no records of s at all, prior mean only.
The prior for s never sees s (leave-species-out) nor year Y.

Writes notebooks/pooled/results/rows.csv.gz (one row per target x arm x n x draw) and fits.csv.
Usage: python3 notebooks/pooled/run.py [--reps 2] [--workers 4] [--species-limit N]
"""
import argparse
import json
import multiprocessing as mp
import os
import sys
import time
from pathlib import Path

for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")   # one thread per worker process

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for p in (ROOT / "notebooks", ROOT / "pipeline", HERE):
    sys.path.insert(0, str(p))

import h3  # noqa: E402
from hatch_p1.daymet import temperature_cube  # noqa: E402
from hatch_p1.degree_days import accumulate  # noqa: E402
from hatch_p1.model import predict_empirical  # noqa: E402
from hatch_p1.prep import YEARS, clean  # noqa: E402
from fit import data as fdata, evaluate as EV, model as M  # noqa: E402
from fit.context import BASE, daily_from_cum, index_records  # noqa: E402
import fetch  # noqa: E402
import pooled as PL  # noqa: E402

OUT = HERE / "results"
SIZES = (10, 25, 50)


# ---------------------------------------------------------------- data
def load(limit=None):
    sp = pd.read_csv(HERE / "species.csv")
    sp = sp[sp.selected].reset_index(drop=True)
    if limit:
        sp = sp.head(limit)
    traits = pd.read_csv(HERE / "traits.csv")
    sp = sp.merge(traits.drop(columns=["name"], errors="ignore"), on="taxon_id", how="left")
    recs = []
    for i, x in enumerate(sp.itertuples()):
        d = clean(pd.read_parquet(fetch.RAW / f"{x.taxon_id}.parquet"))
        d = d[d.doy <= 240].copy()
        d["sp"] = i
        recs.append(d)
    d = pd.concat(recs, ignore_index=True)
    d["state"] = fdata.state_of(d.lat.to_numpy(), d.lng.to_numpy())
    d["hex_lat"] = [h3.cell_to_latlng(h)[0] for h in d.hex]
    hexes, years, tmin, tmax = temperature_cube(sorted(set(d.hex)), YEARS[0], YEARS[1], fetch.DATA / "daymet")
    cum = accumulate(tmin, tmax, BASE).astype(np.float32)
    E = fdata.effort_matrix(pd.read_parquet(fdata.EFFORT), years)
    rec = index_records(d, hexes, years)
    return sp, rec, list(hexes), years, cum, daily_from_cum(cum), E


def design(sp):
    """Trait design matrix for the prior's median target: intercept, family (families with >= 3 species,
    else 'other'), multivoltine, log wingspan (centred), larval food type (woody is the reference)."""
    fam = sp.family.where(sp.family.map(sp.family.value_counts()) >= 3, "other")
    cols = [np.ones(len(sp))]
    names = ["intercept"]
    for f in sorted(set(fam) - {"other"}):
        cols.append((fam == f).astype(float).to_numpy()); names.append(f"family={f}")
    cols.append((sp.voltinism == "multi").astype(float).to_numpy()); names.append("multivoltine")
    lw = np.log(sp.wingspan_mm.astype(float))
    cols.append((lw - lw.mean()).to_numpy()); names.append("log_wingspan")
    for h in sorted(set(sp.host) - {"woody"}):
        cols.append((sp.host == h).astype(float).to_numpy()); names.append(f"host={h}")
    return np.column_stack(cols), names


# ---------------------------------------------------------------- one fold
_G = {}


def calendars(sub, hex_lat):
    t = sub.t.to_numpy(float)
    lat = hex_lat[sub.h.to_numpy()]
    slope = {}
    for q in (M.Q_ONSET, M.Q_PEAK):
        if len(t) >= 5 and np.ptp(lat) > 0.5:
            b = np.polyfit(lat, t, 1)
            res = t - np.polyval(b, lat)
            slope[q] = (b, np.quantile(res, q))
        else:
            slope[q] = (np.array([0.0, 0.0]), np.quantile(t, q))

    def cal(b, hx, w):
        tb = sub.loc[sub.band == b, "t"]
        tb = tb if len(tb) >= 5 else sub.t
        return float(tb.quantile(M.Q_ONSET)), float(tb.quantile(M.Q_PEAK))

    def cal_lat(b, hx, w):
        la = float((hex_lat[hx] * w).sum())
        return tuple(float(np.polyval(slope[q][0], la) + slope[q][1]) for q in (M.Q_ONSET, M.Q_PEAK))
    return cal, cal_lat


def run_fold(Y):
    g = _G
    rec, inc, cum, E, hex_lat, hex_state, X, reps = g["rec"], g["inc"], g["cum"], g["E"], g["lat"], g["st"], g["X"], g["reps"]
    years = g["years"]
    yi = int(Y - years[0])
    tr_years = [i for i in range(len(years)) if i != yi]
    eprof = EV.effort_profile(E, tr_years)
    t0 = time.time()
    S = int(rec.sp.max()) + 1
    per = {}
    theta, V = np.zeros((S, 3)), np.zeros((S, 3, 3))
    for s in range(S):
        r = rec[rec.sp == s]
        tr_all = r[r.year != Y]
        cuts = EV.cutoffs(tr_all)
        train = EV.first_brood(tr_all, cuts)
        test = EV.first_brood(r[r.year == Y], cuts)
        cidx = {b: c - 1 for b, c in cuts.items()}
        P = M.prepare(train, inc, cidx, PL.SPEC, E)
        xf = PL.fit_x(P)
        theta[s], V[s] = xf.x, PL.laplace_cov(xf, P)
        per[s] = dict(train=train, tg=EV.targets(test), cuts=cuts, cidx=cidx, full=xf, P=P)
    t_full = time.time() - t0
    rows, fits = [], []
    for s in range(S):
        if s % 10 == 0:
            print(f"fold {Y}: species {s}/{S} at {time.time() - t0:.0f}s", flush=True)
        q = per[s]
        tg, train, cuts, cidx = q["tg"], q["train"], q["cuts"], q["cidx"]
        others = np.array([k for k in range(S) if k != s])
        pr_shared = PL.meta(theta[others], V[others])[0]()
        pr_tr_fun, _ = PL.meta(theta[others], V[others], X[others])
        pr_traits = pr_tr_fun(X[s])
        fits.append({"year": Y, "sp": s, "n": "all", "draw": 0, "arm": "unpooled_full",
                     **dict(zip(PL.NAMES, q["full"].x))})
        if tg.empty:
            continue
        targets = []
        for x in tg.itertuples():
            hx, w = EV.hex_weights(train[train.band == x.band])
            targets.append((x, hx, w))

        def predict(arm, n, draw, params=None, cal=None, p1dd=None, spec=PL.SPEC):
            for x, hx, w in targets:
                if params is not None:
                    o, p = M.predict_band(params, spec, inc[hx, yi, :].astype(float), hex_lat[hx], w,
                                          cuts[x.band] - 1, eprof[hex_state[hx]])
                elif p1dd is not None:
                    o, p = predict_empirical(cum, hx, w, yi, p1dd)
                else:
                    o, p = cal(x.band, hx, w)
                rows.append({"year": Y, "sp": s, "band": x.band, "n_target": int(x.n), "onset": float(x.onset),
                             "peak": float(x.peak), "arm": arm, "n": n, "draw": draw,
                             "pred_onset": float(o), "pred_peak": float(p)})

        predict("prior_shared", 0, 0, PL.to_p(pr_shared.mean))
        predict("prior_traits", 0, 0, PL.to_p(pr_traits.mean))
        rng = np.random.default_rng(1000 * Y + s)
        plan = [(n, d) for n in SIZES if n < len(train) for d in range(reps)] + [("all", 0)]
        for n, d in plan:
            sub = train if n == "all" else train.iloc[rng.choice(len(train), n, replace=False)]
            P = q["P"] if n == "all" else M.prepare(sub, inc, cidx, PL.SPEC, E)
            cal, cal_lat = calendars(sub, hex_lat)
            predict("cal", n, d, cal=cal)
            predict("cal_lat", n, d, cal=cal_lat)
            predict("p1", n, d, p1dd=cum[sub.h, sub.y, sub.t])
            # with all records (slow fits), P3's fitter and the pooled fits start from the species' own fit
            # (plus the prior mean for pooled) instead of the usual three starts
            p3_start = None
            if n == "all":
                p0 = PL.to_p(q["full"].x)
                p3_start = {k: p0[k] for k in ("mu0", "log_sigma", "alpha")}
                p3_start["mu0"] = max(p3_start["mu0"], 0.0)
            b = M.fit(P, PL.BASELINE, start=p3_start)
            predict("p3", n, d, b.params, spec=PL.BASELINE)
            fu = q["full"] if n == "all" else PL.fit_x(P)
            kw = {"extra_starts": [q["full"].x], "data_starts": False} if n == "all" else {}
            fs = PL.fit_x(P, pr_shared, **kw)
            ft = PL.fit_x(P, pr_traits, **kw)
            for arm, f in (("unpooled", fu), ("shared", fs), ("traits", ft)):
                predict(arm, n, d, f.params())
                fits.append({"year": Y, "sp": s, "n": n, "draw": d, "arm": arm, **dict(zip(PL.NAMES, f.x))})
            fits.append({"year": Y, "sp": s, "n": n, "draw": d, "arm": "p3",
                         **dict(zip(PL.NAMES, PL.from_p(b.params)))})
    print(f"fold {Y}: {len(rows)} rows, full fits {t_full:.0f}s, total {time.time() - t0:.0f}s", flush=True)
    return rows, fits, t_full


def hyper_all_years(sp, rec, inc, E, X, xnames):
    """The shared Gaussian learned from every species on all 11 years (for the write-up, not for scoring)."""
    S = len(sp)
    theta, V, rows = np.zeros((S, 3)), np.zeros((S, 3, 3)), []
    for s in range(S):
        r = rec[rec.sp == s]
        cuts = EV.cutoffs(r)
        tr = EV.first_brood(r, cuts)
        P = M.prepare(tr, inc, {b: c - 1 for b, c in cuts.items()}, PL.SPEC, E)
        xf = PL.fit_x(P)
        theta[s], V[s] = xf.x, PL.laplace_cov(xf, P)
        rows.append({"taxon_id": int(sp.taxon_id[s]), "name": sp.name[s], "n_fit": len(tr),
                     "median_dd": float(np.exp(xf.x[0])), "sigma_dd": float(np.exp(xf.x[1])), "alpha": float(xf.x[2]),
                     "se_log_median": float(np.sqrt(V[s][0, 0])), "cuts": json.dumps(cuts)})
    _, h0 = PL.meta(theta, V)
    _, h1 = PL.meta(theta, V, X)
    hyp = {"shared": {"mean": [float(h0["b"][0]), *map(float, h0["m12"])], "Sigma": h0["Sigma"].tolist()},
           "traits": {"coef": dict(zip(xnames, map(float, h1["b"]))), "m12": list(map(float, h1["m12"])),
                      "Sigma": h1["Sigma"].tolist()}}
    return pd.DataFrame(rows), hyp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--species-limit", type=int, default=None)
    ap.add_argument("--years", type=int, nargs="*", default=None)
    a = ap.parse_args()
    t0 = time.time()
    sp, rec, hexes, years, cum, inc, E = load(a.species_limit)
    X, xnames = design(sp)
    lat = np.array([h3.cell_to_latlng(h)[0] for h in hexes])
    st = np.zeros(len(hexes), int)
    mode = rec.groupby("h")["s"].agg(lambda s: s.value_counts().index[0])
    st[mode.index.to_numpy()] = mode.to_numpy()
    print(f"{len(sp)} species, {len(rec)} records, {len(hexes)} hexes, load {time.time() - t0:.0f}s", flush=True)
    _G.update(rec=rec, inc=inc, cum=cum, E=E, lat=lat, st=st, X=X, reps=a.reps, years=years)
    OUT.mkdir(exist_ok=True)
    fold_years = a.years or [int(y) for y in years]
    with mp.get_context("fork").Pool(a.workers) as pool:
        hyp_async = pool.apply_async(hyper_all_years, (sp, rec, inc, E, X, xnames))
        res = pool.map(run_fold, fold_years, chunksize=1)
        params, hyp = hyp_async.get()
    rows = pd.DataFrame([r for rr, _, _ in res for r in rr])
    fits = pd.DataFrame([f for _, ff, _ in res for f in ff])
    rows["species"] = rows.sp.map(sp.name)
    rows.to_csv(OUT / "rows.csv.gz", index=False)
    fits.to_csv(OUT / "fits.csv.gz", index=False)
    params.to_csv(OUT / "params_all_years.csv", index=False)
    meta = {"species": len(sp), "records": int(len(rec)), "hexes": len(hexes), "reps": a.reps,
            "years": fold_years, "trait_columns": xnames, "hyper_all_years": hyp,
            "seconds_total": round(time.time() - t0), "seconds_full_fits_per_fold": [round(t) for _, _, t in res]}
    (OUT / "run.json").write_text(json.dumps(meta, indent=1))
    print(f"done {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
