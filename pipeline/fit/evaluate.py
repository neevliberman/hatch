"""Folds, targets, baselines and scores for P3 (rules in FROZEN_P3.md).

Every fold recomputes the brood cut-offs from its own training records only.
Targets are scored on dates: onset = 10th percentile, peak = median day of a band-year's
first-brood records (>= 20 records), exactly as P1.
"""
from dataclasses import dataclass, field

import h3
import numpy as np
import pandas as pd

from . import model as M
from hatch_p1.brood import brood_cutoff
from hatch_p1.model import predict_empirical
from hatch_p1.prep import BAND_LABELS

MIN_N = 20
TRAIN_STATES = ("IL", "IN", "OH")
HOLDOUT_STATES = ("WI", "MN")
FALLBACK_CUT = 240


# ---------------------------------------------------------------- brood split + targets
def cutoffs(rec):
    """{band: last first-brood day-of-year} from these records only (P1 rule, frac 0.8)."""
    out = {}
    for b in BAND_LABELS:
        doy = rec.loc[rec.band == b, "doy"]
        c = brood_cutoff(doy) if len(doy) >= MIN_N else None
        out[b] = int(c) if c is not None else FALLBACK_CUT
    return out


def first_brood(rec, cuts):
    return rec[rec.doy <= rec.band.map(cuts)]


def targets(rec, min_n=MIN_N):
    g = rec.groupby(["band", "year"], observed=True)["t"]
    out = pd.DataFrame({"n": g.size(), "onset": g.quantile(M.Q_ONSET), "peak": g.quantile(M.Q_PEAK)})
    return out[out["n"] >= min_n].reset_index()


def hex_weights(rec):
    w = rec["h"].value_counts()
    return w.index.to_numpy(), (w / w.sum()).to_numpy()


def effort_profile(E, years_idx):
    """Typical within-window effort shape per state: each year scaled to sum 1 over the fit window, then averaged."""
    e = E[:, years_idx, :]
    e = e / e[:, :, M.D0:M.D1].sum(-1, keepdims=True)
    return e.mean(1)


# ---------------------------------------------------------------- context helpers
@dataclass
class Helpers:
    hex_lat: np.ndarray
    hex_state: np.ndarray
    extra: dict = field(default_factory=dict)


def helpers(ctx):
    lat = np.array([h3.cell_to_latlng(h)[0] for h in ctx.hexes])
    st = np.zeros(len(ctx.hexes), int)
    mode = ctx.rec.groupby("h")["s"].agg(lambda s: s.value_counts().index[0])
    st[mode.index.to_numpy()] = mode.to_numpy()
    return Helpers(lat, st)


# ---------------------------------------------------------------- one band-year prediction set
def predict_rows(fits, ctx, H, tg, weight_rec, cuts, eprof, p1_train_dd, cal):
    """Predictions for each target row (band, year): every P3 fit, P1 exploratory, calendar(s)."""
    rows = []
    for x in tg.itertuples():
        b, yi = x.band, int(x.year - ctx.years[0])
        hx, w = hex_weights(weight_rec[weight_rec.band == b])
        row = {"band": b, "year": int(x.year), "n": int(x.n), "onset": float(x.onset), "peak": float(x.peak)}
        for name, f in fits.items():
            ep = eprof[H.hex_state[hx]] if f.spec.effort else None
            o, p = M.predict_band(f.without_year(), f.spec, ctx.inc[hx, yi, :].astype(float), H.hex_lat[hx], w,
                                  cuts[b] - 1, ep)
            row[f"{name}_onset"], row[f"{name}_peak"] = o, p
        o, p = predict_empirical(ctx.cum, hx, w, yi, p1_train_dd)
        row["p1_onset"], row["p1_peak"] = int(o), int(p)
        for cname, c in cal.items():
            co, cp = c(b, hx, w)
            row[f"{cname}_onset"], row[f"{cname}_peak"] = co, cp
        rows.append(row)
    return rows


def _band_calendar(train_fb):
    """Calendar: the band's mean onset/peak over training band-years (>= 20 records, as P1);
    a band with no such year falls back to the quantiles of its pooled training records."""
    m = targets(train_fb).groupby("band")[["onset", "peak"]].mean()

    def cal(b, hx, w):
        if b in m.index:
            return float(m.loc[b, "onset"]), float(m.loc[b, "peak"])
        t = train_fb.loc[train_fb.band == b, "t"]
        if len(t) == 0:
            return np.nan, np.nan
        return float(t.quantile(M.Q_ONSET)), float(t.quantile(M.Q_PEAK))
    return cal


def fit_spec(train, ctx, cuts, spec, start=None):
    P = M.prepare(train, ctx.inc, {b: c - 1 for b, c in cuts.items()}, spec, ctx.E)
    return M.fit(P, spec, start=start)


# ---------------------------------------------------------------- folds
def loyo_fold(ctx, H, year, specs, rec=None):
    """Leave year out: fit on the other years (all states), predict that year's band-years."""
    rec = ctx.rec if rec is None else rec
    tr_all = rec[rec.year != year]
    cuts = cutoffs(tr_all)
    train = first_brood(tr_all, cuts)
    test = first_brood(rec[rec.year == year], cuts)
    tg = targets(test)
    fits = {s.name: fit_spec(train, ctx, cuts, s) for s in specs}
    tr_years = sorted(train.y.unique())
    eprof = effort_profile(ctx.E, tr_years)
    p1dd = ctx.cum[train.h, train.y, train.t]
    cal = {"cal": _band_calendar(train)}
    rows = predict_rows(fits, ctx, H, tg, train, cuts, eprof, p1dd, cal)
    for r in rows:
        r["cut"] = cuts[r["band"]]
    recs = {(b, int(y)): g[["t", "user_id"]].to_numpy() for (b, y), g in test.groupby(["band", "year"])}
    return {"year": year, "rows": rows, "fits": fits, "cuts": cuts, "test_records": recs}


def select_fold(ctx, year, specs):
    """IL/IN/OH-only LOYO; returns held-out log-likelihood sums per spec (for choosing lat vs photo)."""
    rec = ctx.rec[ctx.rec.state.isin(TRAIN_STATES)]
    tr_all = rec[rec.year != year]
    cuts = cutoffs(tr_all)
    train = first_brood(tr_all, cuts)
    test = first_brood(rec[rec.year == year], cuts)
    out = {}
    for s in specs:
        f = fit_spec(train, ctx, cuts, s)
        P = M.prepare(test, ctx.inc, {b: c - 1 for b, c in cuts.items()}, s, ctx.E, year_ids=[])
        out[s.name] = (float(M.record_logq(f.without_year(), s, P).sum()), len(P.rg))
    return {"year": year, "loglik": out}


def holdout(ctx, H, specs):
    """Fit IL/IN/OH (all years), predict WI/MN band-years. Model never sees a WI/MN record."""
    rec = ctx.rec
    tr_all = rec[rec.state.isin(TRAIN_STATES)]
    cuts_tr = cutoffs(tr_all)
    train = first_brood(tr_all, cuts_tr)
    fits = {s.name: fit_spec(train, ctx, cuts_tr, s) for s in specs}
    p1dd = ctx.cum[train.h, train.y, train.t]
    tr_tg = targets(train)
    # calendar A: IL/IN/OH band-year dates regressed on latitude, extrapolated north
    lat_by = train.assign(lat=H.hex_lat[train.h]).groupby(["band", "year"])["lat"].mean()
    tr_tg = tr_tg.merge(lat_by.rename("lat").reset_index(), on=["band", "year"])
    ca = {k: np.polyfit(tr_tg.lat, tr_tg[k], 1) for k in ("onset", "peak")}
    te_all = rec[rec.state.isin(HOLDOUT_STATES)]
    rows, recs = [], {}
    for year in sorted(te_all.year.unique()):
        other = te_all[te_all.year != year]
        cuts = cutoffs(other)              # target definition only: WI/MN dates, other years
        test = first_brood(te_all[te_all.year == year], cuts)
        tg = targets(test)
        if tg.empty:
            continue
        ref = first_brood(other, cuts)     # where WI/MN people look (positions, other years)
        eprof = effort_profile(ctx.E, [y for y in range(len(ctx.years)) if y != year - ctx.years[0]])

        def cal_a(b, hx, w):
            lat = float((H.hex_lat[hx] * w).sum())
            return float(np.polyval(ca["onset"], lat)), float(np.polyval(ca["peak"], lat))
        cal = {"cal": _band_calendar(ref), "cal_lat": cal_a}
        rr = predict_rows(fits, ctx, H, tg, ref, cuts, eprof, p1dd, cal)
        for r in rr:
            r["cut"] = cuts[r["band"]]
        rows += rr
        recs.update({(b, int(y)): g[["t", "user_id"]].to_numpy() for (b, y), g in test.groupby(["band", "year"])})
    return {"rows": rows, "fits": fits, "cuts_train": cuts_tr, "test_records": recs}


# ---------------------------------------------------------------- scoring
def errors(rows, models):
    d = pd.DataFrame(rows)
    for m in models:
        d[f"{m}_eo"] = d[f"{m}_onset"] - d["onset"]
        d[f"{m}_ep"] = d[f"{m}_peak"] - d["peak"]
    return d


def mae_table(d, models):
    out = []
    for m in models:
        eo, ep = d[f"{m}_eo"].abs(), d[f"{m}_ep"].abs()
        out.append({"model": m, "n": int(eo.notna().sum()), "onset": eo.mean(), "peak": ep.mean(),
                    "mae": (eo.mean() + ep.mean()) / 2})
    return pd.DataFrame(out)


def bias_by_band(d, models):
    g = d.groupby("band")
    out = {}
    for m in models:
        out[m] = pd.DataFrame({"onset": g[f"{m}_eo"].mean(), "peak": g[f"{m}_ep"].mean()})
    return pd.concat(out, axis=1)


def _q(t, q):
    return np.quantile(t, q)


def noise_floor(d, test_records, draws=500, seed=0):
    """Bootstrap SD of each band-year target, resampling records and resampling observers.
    The MAE a perfect predictor would still score is about SD * sqrt(2 / pi)."""
    rng = np.random.default_rng(seed)
    out = []
    for x in d.itertuples():
        arr = test_records[(x.band, int(x.year))]
        t = arr[:, 0].astype(float)
        u = arr[:, 1]
        b = rng.choice(t, (draws, len(t)))
        sd_r = (np.quantile(b, M.Q_ONSET, axis=1).std(), np.quantile(b, M.Q_PEAK, axis=1).std())
        uu, inv = np.unique(u, return_inverse=True)
        groups = [t[inv == k] for k in range(len(uu))]
        on, pk = [], []
        for _ in range(draws):
            pick = rng.integers(0, len(groups), len(groups))
            s = np.concatenate([groups[k] for k in pick])
            on.append(_q(s, M.Q_ONSET))
            pk.append(_q(s, M.Q_PEAK))
        out.append((x.band, int(x.year), *sd_r, np.std(on), np.std(pk)))
    nf = pd.DataFrame(out, columns=["band", "year", "sd_onset", "sd_peak", "sd_onset_obs", "sd_peak_obs"])
    k = np.sqrt(2 / np.pi)
    floor = {"records": float(k * (nf.sd_onset.mean() + nf.sd_peak.mean()) / 2),
             "observers": float(k * (nf.sd_onset_obs.mean() + nf.sd_peak_obs.mean()) / 2),
             "sd_onset": float(nf.sd_onset.median()), "sd_peak": float(nf.sd_peak.median())}
    return nf, floor


def bootstrap(d, test_records, models, ref, draws=2000, seed=0, observers=True):
    """95% intervals for each model's MAE and for MAE(model) - MAE(ref), resampling years,
    then observers inside each band-year (targets recomputed, predictions held fixed)."""
    rng = np.random.default_rng(seed)
    years = sorted(d.year.unique())
    by_year = {y: d[d.year == y] for y in years}
    groups = {}
    for x in d.itertuples():
        arr = test_records[(x.band, int(x.year))]
        t, u = arr[:, 0].astype(float), arr[:, 1]
        uu, inv = np.unique(u, return_inverse=True)
        groups[(x.band, int(x.year))] = [t[inv == k] for k in range(len(uu))]
    maes = {m: [] for m in models}
    for _ in range(draws):
        err = {m: [] for m in models}
        for y in rng.choice(years, len(years)):
            for x in by_year[y].itertuples():
                if observers:
                    g = groups[(x.band, int(x.year))]
                    s = np.concatenate([g[k] for k in rng.integers(0, len(g), len(g))])
                    on, pk = _q(s, M.Q_ONSET), _q(s, M.Q_PEAK)
                else:
                    on, pk = x.onset, x.peak
                for m in models:
                    err[m].append((abs(getattr(x, f"{m}_onset") - on) + abs(getattr(x, f"{m}_peak") - pk)) / 2)
        for m in models:
            maes[m].append(np.nanmean(err[m]))
    maes = {m: np.array(v) for m, v in maes.items()}
    out = {}
    for m in models:
        out[m] = {"mae_ci": np.percentile(maes[m], [2.5, 97.5]).tolist()}
        if m != ref:
            diff = maes[m] - maes[ref]          # > 0: ref is better than m
            out[m]["minus_ref_ci"] = np.percentile(diff, [2.5, 97.5]).tolist()
            out[m]["minus_ref"] = float(np.mean(diff))
    return out
