#!/usr/bin/env python3
"""Tryout 2: regions that share but don't copy (plan, written before any fit: REGIONAL_PLAN.md).

Analogy: a rookie's batting average. Each region gets its own warmth target, but it starts at what its latitude
predicts and moves toward its own sightings only as far as they justify (partial pooling).

R1 = P3's likelihood with target location mu = mu0 + beta (lat - 42) + v_region + u_year, v ~ Normal(0, S^2), S by
empirical Bayes inside each training set. Data, cut-offs, effort grid and targets are P4's (pipeline/p4/run_p4.py).

    python3 pipeline/league/tryouts/regional.py loyo     # test 1: leave one year out (11 folds)
    python3 pipeline/league/tryouts/regional.py cold     # test 2: hide each eastern region entirely
    python3 pipeline/league/tryouts/regional.py report   # tables + test 3 -> results/regional_*.json
Fits are cached in notebooks/data/league_cache/ (a killed run resumes).
"""
import json
import multiprocessing as mp
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

import jax  # noqa: E402
import jax.numpy as jnp  # noqa: E402

from fit import evaluate as EV, model as M  # noqa: E402
from fit.data import daylength_hours  # noqa: E402
from p4 import jaxlik as JL, run_p4 as R4, wide as W  # noqa: E402

jax.config.update("jax_enable_x64", True)
CACHE = ROOT / "notebooks" / "data" / "league_cache"
OUT = HERE / "results"
D0, D1, LIFE, EPS, TAU, LAT0 = M.D0, M.D1, M.LIFE, M.EPS, M.TAU, M.LAT0
S_WEAK, S_FLOOR, S_CAP, RICH = 200.0, 10.0, 200.0, 200
D = None          # the loaded data (run_p4.Data), shared with forked workers


# ---------------------------------------------------------------- data for one fit
def pool_region(rec):
    """The pooling unit for every record, the Midwest included: P4's 2 x 6 degree region cell."""
    return W.region_cell(D.hex_lat[rec.h.to_numpy()], D.hex_lng[rec.h.to_numpy()])


def prepare(rec, regions):
    """rec: records with h, y, t, cut (last first-brood day index), eg, user_id, pool. regions: region labels with a
    parameter v (others get none). -> dict of arrays for the likelihood."""
    r = rec[(rec.t >= D0) & (rec.t < D1) & (rec.t <= rec.cut)]
    g = r.groupby(["h", "y"], sort=True).ngroup().to_numpy()
    first = r.assign(g=g).groupby("g").first()
    h, y = first.h.to_numpy(), first.y.to_numpy()
    lat = D.hex_lat[h]
    doy = np.arange(D0, D1) + 1
    years = sorted(set(y))
    rix = {k: i for i, k in enumerate(regions)}
    return {"inc": R4.inc_cube((R4.BASE, R4.UPPER, 0))[h, y, D0:D1].astype(np.float64),
            "dayl": daylength_hours(lat[:, None], doy[None, :]) / 12.0, "lat": lat,
            "E": D.E_grid[first.eg.to_numpy(), y, D0:D1].astype(np.float64),
            "mask": (np.arange(D0, D1)[None, :] <= first.cut.to_numpy()[:, None]).astype(float),
            "yi": np.array([years.index(v) for v in y]), "ri": np.array([rix.get(v, -1) for v in first.pool]),
            "rg": g, "rk": (r.t - D0).to_numpy(), "rw": M.observer_weights(r.user_id), "n_years": len(years),
            "n": len(r)}


def names(P, regional):
    return ["mu0", "beta", "gamma", "log_sigma", "alpha"] + [f"u{i}" for i in range(P["n_years"])] + \
        ([f"v{i}" for i in range(int(P["ri"].max()) + 1)] if regional else [])


SCALE = {"mu0": 100.0, "beta": 10.0, "gamma": 1.0, "log_sigma": 1.0, "alpha": 1.0}
BOUNDS = {"mu0": (-500, 1500), "beta": (-150, 150), "gamma": (-6, 12), "log_sigma": (np.log(5), np.log(800)),
          "alpha": (-15, 15)}


def scale(n):
    return SCALE.get(n, 10.0)


def bounds(n):
    if n.startswith("u"):
        return (-200, 200)
    if n.startswith("v"):
        return (-800, 800)
    return BOUNDS[n]


def make_nll(P, nm, S):
    inc, dayl, lat, E, mask = (jnp.asarray(P[k]) for k in ("inc", "dayl", "lat", "E", "mask"))
    yi, ri, rg, rk, rw = (jnp.asarray(P[k]) for k in ("yi", "ri", "rg", "rk", "rw"))
    ce = E * mask
    z2 = ce.sum(1)
    ix = {n: i for i, n in enumerate(nm)}
    uix = jnp.asarray([i for i, n in enumerate(nm) if n.startswith("u")], dtype=int)
    vix = jnp.asarray([i for i, n in enumerate(nm) if n.startswith("v")], dtype=int)
    sc = jnp.asarray([scale(n) for n in nm])
    has_v = len(vix) > 0

    def f(xs):
        x = xs * sc
        C = jnp.cumsum(inc * dayl ** x[ix["gamma"]], axis=1)
        u = x[uix]
        mu = x[ix["mu0"]] + x[ix["beta"]] * (lat - LAT0) + u[yi]
        if has_v:
            v = x[vix]
            mu = mu + jnp.where(ri >= 0, v[jnp.clip(ri, 0, None)], 0.0)
        Cp = jnp.concatenate([jnp.zeros((C.shape[0], LIFE)), C], axis=1)
        F = JL.sn_cdf((Cp - mu[:, None]) / jnp.exp(x[ix["log_sigma"]]), x[ix["alpha"]])
        a = (F[:, LIFE:] - F[:, :-LIFE]) * mask
        ae = a * E
        z1 = ae.sum(1)
        q = (1 - EPS) * ae[rg, rk] / jnp.maximum(z1[rg], 1e-300) + EPS * E[rg, rk] / z2[rg]
        val = -(rw * jnp.log(jnp.maximum(q, 1e-300))).sum() + (u ** 2).sum() / (2 * TAU ** 2)
        if has_v:
            val = val + (v ** 2).sum() / (2 * S ** 2)
        return val
    vg = jax.jit(jax.value_and_grad(f))

    def call(xs):
        v, g = vg(jnp.array(xs, copy=True))
        v, g = float(v), np.array(g, dtype=float)
        if not np.isfinite(v):
            return 1e15, np.zeros_like(g)
        return v, np.nan_to_num(g, nan=0.0, posinf=0.0, neginf=0.0)
    return call


def fit(P, regional, S, starts):
    """Best of several starts (P3's two basins: a sharply skewed curve and a wide one). -> (params dict, nll)."""
    nm = names(P, regional)
    call = make_nll(P, nm, S)
    bnd = [tuple(b / scale(n) for b in bounds(n)) for n in nm]
    best = None
    for st in starts:
        x0 = np.array([st.get(n, 0.0) / scale(n) for n in nm])
        x0 = np.clip(x0, [b[0] for b in bnd], [b[1] for b in bnd])
        res = optimize.minimize(call, x0, jac=True, method="L-BFGS-B", bounds=bnd,
                                options={"maxiter": 3000, "maxfun": 10000})
        if best is None or res.fun < best[1]:
            best = ({n: float(v * scale(n)) for n, v in zip(nm, res.x)}, float(res.fun))
    return best


STARTS = [{"mu0": 66.0, "gamma": 0.63, "log_sigma": 5.46, "alpha": 11.0},     # P3's basin
          {"mu0": 150.0, "gamma": 0.5, "log_sigma": np.log(200.0), "alpha": 0.5}]


def fit_r1(train, regions_all):
    """R1 with S by empirical Bayes; also the one-curve model (no v) for comparison. -> dict."""
    P = prepare(train, regions_all)
    one, nll1 = fit(P, False, None, STARTS)
    warm = [dict(one), *STARTS]
    weak, _ = fit(P, True, S_WEAK, warm)
    v = np.array([weak[f"v{i}"] for i in range(len(regions_all))])
    counts = train.pool.value_counts()
    rich = [i for i, r in enumerate(regions_all) if counts.get(r, 0) >= RICH]
    S = float(np.clip(np.std(v[rich]) if len(rich) >= 3 else S_WEAK, S_FLOOR, S_CAP))
    r1, nll = fit(P, True, S, [weak, *warm])
    return {"one": one, "r1": r1, "S": S, "regions": list(regions_all), "nll": nll, "nll_one": nll1, "n": P["n"],
            "rich": len(rich)}


# ---------------------------------------------------------------- prediction
def mu_hex(p, hx, regions, regional):
    mu = p["mu0"] + p["beta"] * (D.hex_lat[hx] - LAT0)
    if regional:
        rix = {k: i for i, k in enumerate(regions)}
        reg = W.region_cell(D.hex_lat[hx], D.hex_lng[hx])
        mu = mu + np.array([p.get(f"v{rix[r]}", 0.0) if r in rix else 0.0 for r in reg])
    return mu


def predict(p, hx, w, yi, cut_idx, eprof, regions, regional):
    """Onset and peak day index for a weighted set of hexes in year index yi (no year nudge: an unseen year)."""
    q = {"mu0": mu_hex(p, hx, regions, regional), "gamma": p["gamma"], "log_sigma": p["log_sigma"],
         "alpha": p["alpha"], "beta": 0.0, "u": np.array([])}
    inc = R4.inc_cube((R4.BASE, R4.UPPER, 0))[hx, yi, :].astype(float)
    return M.predict_band(q, M.SPECS["p3_photo"], inc, D.hex_lat[hx], w, cut_idx, eprof)


# ---------------------------------------------------------------- test 1: leave one year out
def cached(name, fn):
    f = CACHE / f"{name}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    out = fn()
    CACHE.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps(out))
    return out


def all_regions():
    return sorted(set(D.rec.pool))


def loyo_fold(year):
    t0 = time.time()
    rec = D.rec
    tr_all = rec[rec.year != year]
    mw_cuts, w_cuts = EV.cutoffs(tr_all[tr_all.region == "mw"]), R4._wide_cuts(tr_all)
    train = R4._with_cut(tr_all, mw_cuts, w_cuts)
    fits = cached(f"loyo_{year}", lambda: fit_r1(train, all_regions()))
    yi = year - int(D.years[0])
    eprof = EV.effort_profile(D.E_grid, sorted(train.y.unique()))
    test = R4._with_cut(rec[rec.year == year], mw_cuts, w_cuts)
    rows = []

    def both(hx, w, cut):
        ep = eprof[D.hex_eg[hx]]
        o1, p1 = predict(fits["one"], hx, w, yi, cut, ep, fits["regions"], False)
        o2, p2 = predict(fits["r1"], hx, w, yi, cut, ep, fits["regions"], True)
        return {"one_onset": o1, "one_peak": p1, "r1_onset": o2, "r1_peak": p2}

    trmw = train[train.region == "mw"]
    cal = EV._band_calendar(trmw)
    tmw = test[test.region == "mw"]
    for x in EV.targets(tmw.assign(band=tmw.band.astype(str))).itertuples():
        hx, w = EV.hex_weights(trmw[trmw.band == x.band])
        co, cp = cal(x.band, hx, w)
        rows.append({"set": "mw", "cell": x.band, "year": year, "n": int(x.n), "onset": float(x.onset),
                     "peak": float(x.peak), "cal_onset": co, "cal_peak": cp, **both(hx, w, mw_cuts[x.band] - 1)})
    trw = train[train.region != "mw"]
    ctg = trw.groupby(["region", "year"]).t.agg(["size", lambda s: s.quantile(.1), "median"])
    ctg.columns = ["n", "onset", "peak"]
    ctg = ctg[ctg.n >= EV.MIN_N].groupby(level=0).mean()
    tw = test[test.region != "mw"]
    for c, tt in tw.groupby("region").t:
        if len(tt) < EV.MIN_N or c not in w_cuts:
            continue
        hx, w = EV.hex_weights(trw[trw.region == c])
        if len(hx) == 0:
            continue
        co, cp = (ctg.loc[c, "onset"], ctg.loc[c, "peak"]) if c in ctg.index else (np.nan, np.nan)
        rows.append({"set": "east", "cell": c, "year": year, "n": int(len(tt)), "onset": float(tt.quantile(.1)),
                     "peak": float(tt.median()), "cal_onset": co, "cal_peak": cp, **both(hx, w, w_cuts[c] - 1)})
    print(f"[loyo] {year}: S={fits['S']:.0f} DD over {fits['rich']} rich regions, {len(rows)} rows, "
          f"{time.time() - t0:.0f}s", flush=True)
    return {"year": year, "rows": rows, "S": fits["S"], "beta": fits["r1"]["beta"], "beta_one": fits["one"]["beta"]}


# ---------------------------------------------------------------- test 2: cold start (a region never seen)
def cold_targets():
    """Eastern regions with at least one cell-year of >= 20 first-brood records (cut-offs from all years)."""
    rec = D.rec
    w_cuts = R4._wide_cuts(rec)
    fb = R4._with_cut(rec[rec.region != "mw"], {}, w_cuts)
    n = fb.groupby(["region", "year"]).size()
    return sorted({c for (c, y), k in n.items() if k >= EV.MIN_N}), w_cuts


def cold_fold(region):
    t0 = time.time()
    rec = D.rec
    tr_all = rec[rec.pool != region]
    mw_cuts, w_cuts = EV.cutoffs(tr_all[tr_all.region == "mw"]), R4._wide_cuts(tr_all)
    train = R4._with_cut(tr_all, mw_cuts, w_cuts)
    fits = cached(f"cold_{region.replace('/', '_')}", lambda: fit_r1(train, sorted(set(train.pool))))
    _, cuts_all = cold_targets()
    cut = cuts_all[region]                      # target definition: the region's own dip, all years
    test = R4._with_cut(rec[rec.region == region], {}, {region: cut})
    eprof = EV.effort_profile(D.E_grid, sorted(train.y.unique()))
    # calendar slid by latitude: every other eastern cell-year's dates regressed on its latitude
    trw = train[train.region != "mw"]
    cy = trw.groupby(["region", "year"]).agg(n=("t", "size"), onset=("t", lambda s: s.quantile(.1)),
                                             peak=("t", "median"), lat=("h", lambda h: D.hex_lat[h].mean()))
    cy = cy[cy.n >= EV.MIN_N]
    slope = {k: np.polyfit(cy.lat, cy[k], 1) for k in ("onset", "peak")}
    rows = []
    hx, w = EV.hex_weights(test)                # where people look in this region (its own records, positions only)
    lat = float((D.hex_lat[hx] * w).sum())
    for year, tt in test.groupby("year").t:
        if len(tt) < EV.MIN_N:
            continue
        yi = int(year) - int(D.years[0])
        ep = eprof[D.hex_eg[hx]]
        o1, p1 = predict(fits["one"], hx, w, yi, cut - 1, ep, fits["regions"], False)
        o2, p2 = predict(fits["r1"], hx, w, yi, cut - 1, ep, fits["regions"], True)   # region unseen: v = 0
        rows.append({"cell": region, "year": int(year), "n": int(len(tt)), "onset": float(tt.quantile(.1)),
                     "peak": float(tt.median()), "one_onset": o1, "one_peak": p1, "r1_onset": o2, "r1_peak": p2,
                     "slid_onset": float(np.polyval(slope["onset"], lat)),
                     "slid_peak": float(np.polyval(slope["peak"], lat)), "lat": lat})
    print(f"[cold] {region}: {len(rows)} rows, {time.time() - t0:.0f}s", flush=True)
    return rows


# ---------------------------------------------------------------- report
def mae(d, m):
    return float(((d[f"{m}_onset"] - d.onset).abs().mean() + (d[f"{m}_peak"] - d.peak).abs().mean()) / 2)


def boot_diff(d, a, b, draws=2000, seed=0):
    """95% interval of MAE(a) - MAE(b), resampling years."""
    rng = np.random.default_rng(seed)
    years = sorted(d.year.unique())
    by = {y: d[d.year == y] for y in years}
    out = []
    for _ in range(draws):
        s = pd.concat([by[y] for y in rng.choice(years, len(years))])
        out.append(mae(s, a) - mae(s, b))
    return [float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))]


def transfer(d, model, k=0.5, gap=10):
    """Test 3: move each forecast by -k x the mean miss (after each cell's leave-one-year-out average miss) of
    same-year cells whose peak came at least `gap` days before the forecast's issue date."""
    d = d.copy()
    d["e"] = ((d[f"{model}_onset"] - d.onset) + (d[f"{model}_peak"] - d.peak)) / 2
    d["b"] = [d[(d.cell == r.cell) & (d.year != r.year)].e.mean() if ((d.cell == r.cell) & (d.year != r.year)).any()
              else 0.0 for r in d.itertuples()]
    out = d.copy()
    for q in ("onset", "peak"):
        shift = []
        for r in d.itertuples():
            issue = np.floor(getattr(r, q)) - 7
            o = d[(d.year == r.year) & (d.cell != r.cell) & (d.peak + gap <= issue)]
            shift.append(-k * (o.e - o.b).mean() if len(o) else 0.0)
        out[f"tr_{q}"] = d[f"{model}_{q}"] + np.array(shift)
    return out


def report():
    OUT.mkdir(exist_ok=True)
    res = {}
    lo = OUT / "regional_loyo_rows.csv"
    if lo.exists():
        d = pd.read_csv(lo)
        for s, g in d.groupby("set"):
            g = g.dropna(subset=["cal_onset"])
            res[f"loyo_{s}"] = {m: round(mae(g, m), 2) for m in ("cal", "one", "r1")}
            res[f"loyo_{s}"]["n"] = len(g)
            res[f"loyo_{s}"]["r1_minus_cal_ci"] = [round(v, 2) for v in boot_diff(g, "r1", "cal")]
            res[f"loyo_{s}"]["r1_minus_one_ci"] = [round(v, 2) for v in boot_diff(g, "r1", "one")]
            t = transfer(g, "r1")
            res[f"loyo_{s}"]["r1_transfer"] = round(mae(t, "tr"), 2)
    co = OUT / "regional_cold_rows.csv"
    if co.exists():
        d = pd.read_csv(co)
        res["cold"] = {m: round(mae(d, m), 2) for m in ("slid", "one", "r1")}
        res["cold"]["n"], res["cold"]["regions"] = len(d), int(d.cell.nunique())
        res["cold"]["r1_minus_one_ci"] = [round(v, 2) for v in boot_diff(d, "r1", "one")]
        res["cold"]["r1_minus_slid_ci"] = [round(v, 2) for v in boot_diff(d, "r1", "slid")]
    (OUT / "regional_summary.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


def load():
    global D
    D = R4.load()
    R4.D = D
    D.rec["pool"] = pool_region(D.rec)
    print(f"[data] {len(D.rec)} records, {len(D.hexes)} hexes, {D.rec.pool.nunique()} regions", flush=True)


def main(cmd, workers=4):
    if cmd == "report":
        return report()
    load()
    OUT.mkdir(exist_ok=True)
    ctx = mp.get_context("fork")
    if cmd == "loyo":
        with ctx.Pool(workers) as pool:
            outs = pool.map(loyo_fold, [int(y) for y in D.years], chunksize=1)
        pd.DataFrame([r for o in outs for r in o["rows"]]).to_csv(OUT / "regional_loyo_rows.csv", index=False,
                                                                  float_format="%.2f")
        (OUT / "regional_loyo_fits.json").write_text(json.dumps(
            [{k: o[k] for k in ("year", "S", "beta", "beta_one")} for o in outs], indent=1))
    elif cmd == "cold":
        regions, _ = cold_targets()
        with ctx.Pool(workers) as pool:
            outs = pool.map(cold_fold, regions, chunksize=1)
        pd.DataFrame([r for o in outs for r in o]).to_csv(OUT / "regional_cold_rows.csv", index=False,
                                                          float_format="%.2f")
    report()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "loyo")
