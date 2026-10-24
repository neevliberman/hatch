#!/usr/bin/env python3
"""Score the P4 candidates (FROZEN_P4.md) and write results/.

    python3 pipeline/p4/run_p4.py --cands c0 c1 ... [--workers 4]

Each (candidate, held-out year) fold is cached in notebooks/data/p4_cache/, so a killed run resumes.
"""
import argparse
import json
import multiprocessing as mp
import pickle
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path

import h3
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from p4 import DATA, HERE, model4 as M4, wide as W  # noqa: E402
from fit import data as FD, evaluate as EV  # noqa: E402
from hatch_p1.daymet import temperature_cube  # noqa: E402
from hatch_p1.degree_days import accumulate  # noqa: E402
from hatch_p1.model import predict_empirical  # noqa: E402
from hatch_p1.prep import YEARS  # noqa: E402

CACHE = DATA / "p4_cache"
RESULTS = HERE / "results"
BASE, UPPER = 10.0, 30.0


# ---------------------------------------------------------------- candidates
@dataclass(frozen=True)
class Cand:
    name: str
    spec: str = "c0"           # model4.SPECS4 key
    region: str = "wide"       # "mw" | "wide"
    effort: str = "grid"       # "state" | "grid"
    positive: bool = False
    minlat: float = 0.0   # train only on cells at or north of this latitude (Midwest cells always kept)
    dd: tuple = ()             # () = base 10 / cap 30 / no smoothing; else a grid to profile: ("tau", ...) etc.


CANDS = {
    "c0": Cand("c0", region="mw", effort="state"),
    "c1s": Cand("c1s", region="mw", effort="grid"),
    "c1": Cand("c1"),
    "c2": Cand("c2", spec="c2"),
    "c3": Cand("c3", spec="c3"),
    "c4": Cand("c4", dd=("tau", 0, 2, 4, 7, 14)),
    "c5": Cand("c5", dd=("thresh",)),
    "c6": Cand("c6", spec="c6"),
    "c7": Cand("c7", spec="c7"),
    "c1flat": Cand("c1flat", spec="flat"),
}
# Midwest-only versions of each model idea (reported, not decision candidates; change log)
for _k in ("c2", "c3", "c4", "c5", "c6", "c7"):
    CANDS["m" + _k[1:]] = Cand("m" + _k[1:], spec=CANDS[_k].spec, region="mw", effort="state", dd=CANDS[_k].dd)
CANDS["m0j"] = Cand("m0j", region="mw", effort="state")   # c0 refit with exact gradients
# exploratory, added after the first Midwest round (change log): adult flight life chosen by training likelihood
for _k in ("c1", "c2", "c3", "c6", "c7"):   # wide candidates with P3.1's bounds (change log)
    CANDS[_k + "p"] = Cand(_k + "p", spec=CANDS[_k].spec, positive=True)
CANDS["c1n"] = Cand("c1n", minlat=38.0, positive=True)   # exploratory (change log): wide data north of 38 N only
CANDS["c2n"] = Cand("c2n", spec="c2", minlat=38.0, positive=True)
CANDS["m8"] = Cand("m8", region="mw", effort="state", dd=("life", 4, 7, 10, 14, 21))
CANDS["c8l"] = Cand("c8l", dd=("life", 4, 7, 10, 14, 21))


# ---------------------------------------------------------------- data
@dataclass
class Data:
    rec: pd.DataFrame
    hexes: list
    years: np.ndarray
    tmin: np.ndarray
    tmax: np.ndarray
    hex_lat: np.ndarray
    hex_lng: np.ndarray
    hex_state: np.ndarray
    hex_eg: np.ndarray
    E_state: np.ndarray
    E_grid: np.ndarray
    chill: np.ndarray
    inc: dict             # dd key -> daily degree-day cube


D = None


def ema(x, tau):
    if tau <= 0:
        return x
    out = np.empty_like(x)
    k = 1.0 / tau
    out[..., 0] = x[..., 0]
    for i in range(1, x.shape[-1]):
        out[..., i] = out[..., i - 1] + k * (x[..., i] - out[..., i - 1])
    return out


def inc_cube(key):
    """Daily degree-days for a (base, upper, tau) key, computed once per process."""
    if key not in D.inc:
        base, upper, tau = key
        tn, tx = (D.tmin, D.tmax) if tau == 0 else (ema(D.tmin, tau), ema(D.tmax, tau))
        cum = accumulate(tn, tx, base, upper)
        D.inc[key] = np.diff(cum, axis=-1, prepend=0).astype(np.float32)
    return D.inc[key]


def load(midwest_only=False):
    mw = FD.luna_records()
    mw = mw[mw.doy <= 240].copy()
    mw["region"] = "mw"
    parts = [mw]
    if not midwest_only:
        raw = W.fetch_records()
        wd = W.outside_midwest(W.clean_wide(raw), pd.read_parquet(FD.RAW_LUNA).id)
        wd = wd[wd.doy <= 240].copy()
        wd["region"] = W.region_cell(wd.lat, wd.lng)
        wd["state"] = None
        wd["band"] = None
        parts.append(wd)
    rec = pd.concat(parts, ignore_index=True)
    # hexes whose centre is over water (Long Island Sound, Atlantic) have no Daymet pixel: their records are dropped
    ok = {h for h in set(rec.hex) if (DATA / "daymet" / f"{h}_{YEARS[0]}-{YEARS[1]}.csv").exists()} \
        if not midwest_only else set(rec.hex)
    rec = rec[rec.hex.isin(ok)]
    hexes = sorted(set(rec.hex))
    hexes, years, tmin, tmax = temperature_cube(hexes, YEARS[0], YEARS[1], DATA / "daymet", workers=8)
    hi = {h: i for i, h in enumerate(hexes)}
    rec["h"] = rec.hex.map(hi).astype(int)
    rec["y"] = (rec.year - years[0]).astype(int)
    rec["t"] = (rec.yday - 1).astype(int)
    rec["s"] = rec.state.map({s: i for i, s in enumerate(FD.STATES)}).fillna(-1).astype(int)
    ll = np.array([h3.cell_to_latlng(h) for h in hexes])
    hex_state = np.full(len(hexes), -1)
    m = rec[rec.s >= 0].groupby("h")["s"].agg(lambda s: s.value_counts().index[0])
    hex_state[m.index.to_numpy()] = m.to_numpy()
    hex_eg = W.effort_cell(ll[:, 0], ll[:, 1])
    rec["eg"] = hex_eg[rec.h]
    rec["band"] = rec.band.astype(object).where(rec.region == "mw", None)
    E_state = FD.effort_matrix(FD.fetch_effort(), years)
    E_grid = W.effort_grid_matrix(W.fetch_effort(), years) if not midwest_only else None
    tmean = (tmin + tmax) / 2
    jf = tmean[:, :, :59].mean(-1)                 # Jan-Feb mean temperature (change log: Dec needs 2014 data)
    chill = jf - jf.mean(1, keepdims=True)
    return Data(rec.reset_index(drop=True), list(hexes), years, tmin, tmax, ll[:, 0], ll[:, 1], hex_state, hex_eg,
                E_state, E_grid, chill.astype(float), {})


# ---------------------------------------------------------------- one fold
def _wide_cuts(tr):
    """Brood cut-off per region cell. v2 (change log): pooled over all longitudes of the cell's 2-degree latitude
    band, like the Midwest bands (v1 per cell gave day 240 to a cell with no clear dip, mixing both broods into
    its first-brood target). Cells inherit their band's cut-off."""
    wd = tr[tr.region != "mw"]
    band = wd.region.str.split("/").str[0]
    out = {}
    for b, g in wd.groupby(band):
        c = W.wide_cutoff(g.doy.to_numpy(), W.cell_lat(b))
        for reg in set(wd.region[band == b]):
            out[reg] = c
    return out


def _with_cut(r, mw_cuts, w_cuts):
    r = r.copy()
    cut = np.where(r.region == "mw", r.band.map(mw_cuts).fillna(240), r.region.map(w_cuts).fillna(240))
    r["cutdoy"] = cut.astype(int)
    r = r[r.doy <= r.cutdoy].copy()
    r["cut"] = r.cutdoy - 1
    return r


def _eprof(E, tr_years):
    return EV.effort_profile(E, tr_years)


def fit_cand(cand, train, dd_key, life=7):
    spec = replace(M4.SPECS4[cand.spec], life=life, positive=cand.positive)
    E = D.E_state if cand.effort == "state" else D.E_grid
    tr = train.assign(e=train.s if cand.effort == "state" else train.eg)
    P = M4.prepare(tr, inc_cube(dd_key), spec, E, D.chill, hex_lat=D.hex_lat)
    return M4.fit(P, spec)


def dd_grid(cand):
    if not cand.dd:
        return [(BASE, UPPER, 0)]
    if cand.dd[0] == "life":
        return []
    if cand.dd[0] == "tau":
        return [(BASE, UPPER, t) for t in cand.dd[1:]]
    return None   # "thresh": two-stage profile below


def fold(args):
    cand_name, year = args
    f = CACHE / f"{cand_name}_{year}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    cand = CANDS[cand_name]
    rec = D.rec
    tr_all = rec[rec.year != year]
    mw_cuts = EV.cutoffs(tr_all[tr_all.region == "mw"])
    w_cuts = _wide_cuts(tr_all)
    train = _with_cut(tr_all, mw_cuts, w_cuts)
    if cand.region == "mw":
        train = train[train.region == "mw"]
    elif cand.minlat:
        train = train[(train.region == "mw") | (train.hex_lat_ >= cand.minlat)] if "hex_lat_" in train else \
            train[(train.region == "mw") | (D.hex_lat[train.h.to_numpy()] >= cand.minlat)]
    t0 = time.time()
    # profile the degree-day inputs by training likelihood
    grid = dd_grid(cand)
    if grid is None:
        fits = {}
        for b in (6.0, 8.0, 10.0, 12.0):
            fits[(b, UPPER, 0)] = fit_cand(cand, train, (b, UPPER, 0))
        bb = min(fits, key=lambda k: fits[k].nll)[0]
        for u in (24.0, 27.0, 33.0):
            fits[(bb, u, 0)] = fit_cand(cand, train, (bb, u, 0))
    elif cand.dd and cand.dd[0] == "life":
        fits = {(BASE, UPPER, 0, L): fit_cand(cand, train, (BASE, UPPER, 0), L) for L in cand.dd[1:]}
    else:
        fits = {k: fit_cand(cand, train, k) for k in grid}
    key = min(fits, key=lambda k: fits[k].nll)
    ft = fits[key]
    spec = ft.spec
    p = ft.without_year()
    inc = inc_cube(key[:3])
    yi = year - int(D.years[0])
    tr_years = sorted(train.y.unique())
    eprof = _eprof(D.E_state if cand.effort == "state" else D.E_grid, tr_years)
    test = _with_cut(rec[rec.year == year], mw_cuts, w_cuts)
    rows = []

    def predict(hx, w, cut):
        ep = eprof[D.hex_state[hx]] if cand.effort == "state" else eprof[D.hex_eg[hx]]
        return M4.predict_cell(p, spec, inc[hx, yi, :].astype(float), D.hex_lat[hx], D.chill[hx, yi], w,
                               np.full(len(hx), cut), ep)

    # Midwest band-years (P3's targets)
    tmw, trmw = test[test.region == "mw"], train[train.region == "mw"] if cand.region == "mw" else \
        _with_cut(tr_all[tr_all.region == "mw"], mw_cuts, w_cuts)
    cal = EV._band_calendar(trmw)
    p1dd = D.inc[(BASE, UPPER, 0)] if (BASE, UPPER, 0) in D.inc else inc_cube((BASE, UPPER, 0))
    p1cum = np.cumsum(p1dd, -1)
    p1train = p1cum[trmw.h, trmw.y, trmw.t]
    for x in EV.targets(tmw.assign(band=tmw.band.astype(str))).itertuples():
        hx, w = EV.hex_weights(trmw[trmw.band == x.band])
        o, pk = predict(hx, w, mw_cuts[x.band] - 1)
        po, pp = predict_empirical(p1cum, hx, w, yi, p1train)
        co, cp = cal(x.band, hx, w)
        rows.append({"set": "mw", "cell": x.band, "year": year, "n": int(x.n), "onset": float(x.onset),
                     "peak": float(x.peak), "m_onset": o, "m_peak": pk, "p1_onset": int(po), "p1_peak": int(pp),
                     "cal_onset": co, "cal_peak": cp})
    # eastern cell-years
    tw = test[test.region != "mw"]
    trw = _with_cut(tr_all[tr_all.region != "mw"], mw_cuts, w_cuts)
    if cand.region == "wide" and len(tw):
        ctg = trw.groupby(["region", "year"]).t.agg(["size", lambda s: s.quantile(.1), "median"])
        ctg.columns = ["n", "onset", "peak"]
        ctg = ctg[ctg.n >= EV.MIN_N].groupby(level=0).mean()
        g = tw.groupby("region").t
        for c, tt in g:
            if len(tt) < EV.MIN_N or c not in w_cuts:
                continue
            hx, w = EV.hex_weights(trw[trw.region == c])
            if len(hx) == 0:
                continue
            o, pk = predict(hx, w, w_cuts[c] - 1)
            co, cp = (ctg.loc[c, "onset"], ctg.loc[c, "peak"]) if c in ctg.index else (np.nan, np.nan)
            dd15 = float((p1cum[hx, yi, 104] * w).sum())
            rows.append({"set": "east", "cell": c, "year": year, "n": int(len(tt)), "onset": float(tt.quantile(.1)),
                         "peak": float(tt.median()), "m_onset": o, "m_peak": pk, "cal_onset": co, "cal_peak": cp,
                         "dd_apr15": dd15})
    out = {"cand": cand_name, "year": year, "dd_key": key, "params": {k: (v.tolist() if isinstance(v, np.ndarray) else v)
           for k, v in ft.params.items()}, "nll": ft.nll, "n": ft.n, "rows": rows, "secs": time.time() - t0,
           "profile": {str(k): v.nll for k, v in fits.items()}}
    CACHE.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps(out))
    print(f"[fold] {cand_name} {year} {time.time()-t0:.0f}s key={key}", flush=True)
    return out


def score(rows):
    d = pd.DataFrame(rows)
    res = {}
    for s, g in d.groupby("set"):
        r = {}
        for m in ("m", "p1", "cal"):
            if f"{m}_onset" in g and g[f"{m}_onset"].notna().any():
                eo, ep = (g[f"{m}_onset"] - g.onset).abs(), (g[f"{m}_peak"] - g.peak).abs()
                r[m] = round(float((eo.mean() + ep.mean()) / 2), 3)
        r["n"] = len(g)
        res[s] = r
    return res


def main():
    global D
    ap = argparse.ArgumentParser()
    ap.add_argument("--cands", nargs="+", default=["c0"])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--midwest-only", action="store_true")
    a = ap.parse_args()
    D = load(midwest_only=a.midwest_only)
    print(f"[data] {len(D.rec)} records, {len(D.hexes)} hexes; regions: {D.rec.region.value_counts().head(3).to_dict()}",
          flush=True)
    years = [int(y) for y in D.years]
    jobs = [(c, y) for c in a.cands for y in years]
    with mp.get_context("fork").Pool(a.workers) as pool:
        outs = pool.map(fold, jobs, chunksize=1)
    RESULTS.mkdir(exist_ok=True)
    summary = {}
    for c in a.cands:
        o = [x for x in outs if x["cand"] == c]
        rows = [r for x in o for r in x["rows"]]
        pd.DataFrame(rows).to_csv(RESULTS / f"rows_{c}.csv", index=False, float_format="%.2f")
        summary[c] = score(rows)
        print(c, json.dumps(summary[c]), flush=True)
    prev = json.loads((RESULTS / "summary.json").read_text()) if (RESULTS / "summary.json").exists() else {}
    prev.update(summary)
    (RESULTS / "summary.json").write_text(json.dumps(prev, indent=1))


if __name__ == "__main__":
    main()
