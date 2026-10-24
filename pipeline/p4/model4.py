"""P4 candidate models: P3's likelihood (pipeline/fit/model.py) with optional extra terms.

Everything P3 has stays: skew-normal warmth targets (in daylength-weighted degree-days, "photo"), a 7-day flight
life, an effort background, observer weights, a shrunk year effect and a 1% contamination term. Extra switches:

- lat:   the target's location slides with latitude (beta per degree from 42 N)          [C2]
- gate:  each day's warmth is multiplied by a smooth step in daylength, on at a fitted D* hours  [C3]
- chill: the target slides with the place-year's winter warmth anomaly (kappa DD per degree C) [C6]
- mix:   a fitted share pi of moths follows warmth; the rest follow a date clock,
         normal in day of year with mean m0 + m1 (lat - 42) and SD s                     [C7]

Inputs that change the degree-days themselves (base, upper cap, leaf-litter smoothing: C4, C5) are chosen outside
the fit, by training likelihood over a small grid, and arrive here as a different `inc` array.
"""
from dataclasses import dataclass, replace

import numpy as np
import pandas as pd
from scipy import optimize, special

from fit import model as M
from fit.data import daylength_hours

D0, D1, LIFE, EPS, TAU, LAT0 = M.D0, M.D1, M.LIFE, M.EPS, M.TAU, M.LAT0
GATE_W = 0.3   # hours: width of the daylength step
USE_JAX = True  # exact gradients (jaxlik.py); False = P3's finite differences


@dataclass(frozen=True)
class Spec4:
    name: str
    photo: bool = True
    lat: bool = False
    gate: bool = False
    chill: bool = False
    mix: bool = False
    effort: bool = True
    life: int = LIFE   # adult flight life, days (P3: 7)
    positive: bool = False   # P3.1 bounds: mu0 >= 0 and alpha >= 0 (keeps the fit out of the wide-curve basin)


SPECS4 = {
    "c0": Spec4("c0"),
    "c2": Spec4("c2", lat=True),
    "c3": Spec4("c3", gate=True),
    "c6": Spec4("c6", chill=True),
    "c7": Spec4("c7", mix=True),
    "flat": Spec4("flat", photo=False),
}

_P = {  # name: (scale, lo, hi, start)
    "mu0": (100.0, -500, 1500, None), "beta": (10.0, -150, 150, 0.0), "gamma": (1.0, -6, 12, 0.0),
    "gate_d": (1.0, 9.0, 15.5, 12.0), "kappa": (10.0, -100, 100, 0.0), "log_sigma": (1.0, np.log(5), np.log(800), None),
    "alpha": (1.0, -15, 15, 2.0), "logit_pi": (1.0, -8, 8, 1.0), "m0": (10.0, 60, 240, 150.0),
    "m1": (1.0, -15, 15, 4.0), "log_s": (1.0, np.log(2), np.log(60), np.log(12.0)),
}


def param_names(spec, n_years):
    n = ["mu0"]
    n += ["beta"] if spec.lat else []
    n += ["gamma"] if spec.photo else []
    n += ["gate_d"] if spec.gate else []
    n += ["kappa"] if spec.chill else []
    n += ["log_sigma", "alpha"]
    n += ["logit_pi", "m0", "m1", "log_s"] if spec.mix else []
    return n + [f"u{i}" for i in range(n_years)]


def _sc(n):
    return 10.0 if n.startswith("u") else _P[n][0]


def unpack(x, names):
    p = {"beta": 0.0, "gamma": 0.0, "kappa": 0.0, "gate_d": None}
    u = []
    for n, v in zip(names, x):
        v = v * _sc(n)
        (u.append(v) if n.startswith("u") else p.__setitem__(n, v))
    p["u"] = np.array(u)
    return p


@dataclass
class Prep:
    inc: np.ndarray     # (G, K) daily degree-days, window days
    dayl: np.ndarray    # (G, K) daylength / 12 h
    lat: np.ndarray     # (G,)
    chill: np.ndarray   # (G,) winter warmth anomaly, degrees C
    yi: np.ndarray      # (G,) year-effect index (-1 = none)
    E: np.ndarray       # (G, K)
    mask: np.ndarray    # (G, K)
    rg: np.ndarray
    rk: np.ndarray
    rw: np.ndarray
    n_years: int


def prepare(rec, inc_cube, spec, E_cube=None, chill_cube=None, year_ids=None, hex_lat=None):
    """rec columns: h, y, t, cut (last allowed day index), e (effort row), user_id; optional yid.
    inc_cube [hex, year, 365]; E_cube [effort row, year, 365]; chill_cube [hex, year]."""
    r = rec.copy()
    if "yid" not in r:
        r["yid"] = r["y"]
    r = r[(r.t >= D0) & (r.t < D1) & (r.t <= r.cut)]
    if year_ids is None:
        year_ids = sorted(r.yid.unique())
    ymap = {v: i for i, v in enumerate(year_ids)}
    gkey = r.groupby(["h", "y", "yid", "cut", "e"], sort=True).ngroup().to_numpy()
    g = r.assign(g=gkey).groupby("g").first()
    h, y = g.h.to_numpy(), g.y.to_numpy()
    lat = hex_lat[h]
    doy = np.arange(D0, D1) + 1
    dayl = daylength_hours(lat[:, None], doy[None, :]) / 12.0
    E = E_cube[g.e.to_numpy(), y, D0:D1].astype(float) if (spec.effort and E_cube is not None) else np.ones((len(g), D1 - D0))
    ch = chill_cube[h, y] if chill_cube is not None else np.zeros(len(g))
    mask = np.arange(D0, D1)[None, :] <= g.cut.to_numpy()[:, None]
    w = M.observer_weights(r.user_id)
    return Prep(inc_cube[h, y, D0:D1].astype(float), dayl, lat, ch, np.array([ymap.get(v, -1) for v in g.yid]),
                E, mask, gkey, (r.t - D0).to_numpy(), w, len(year_ids))


def _mu(p, spec, lat, chill, yi):
    mu = p["mu0"] + (p["beta"] * (lat - LAT0) if spec.lat else 0.0) + (p["kappa"] * chill if spec.chill else 0.0)
    if len(p["u"]) and yi is not None:
        mu = mu + np.where(yi >= 0, p["u"][np.clip(yi, 0, None)], 0.0)
    return np.broadcast_to(np.asarray(mu, float), np.shape(lat))


def flight(p, spec, inc, dayl, lat, chill=None, yi=None, day0=D0):
    """Share of moths in the air each day. `day0` is the day index of inc's first column (for the date clock)."""
    w = inc
    if spec.photo:
        w = w * dayl ** p["gamma"]
    if spec.gate:
        w = w * special.expit((dayl * 12.0 - p["gate_d"]) / GATE_W)
    C = np.cumsum(w, axis=-1)
    chill = np.zeros(np.shape(lat)) if chill is None else chill
    mu = _mu(p, spec, lat, chill, yi)
    L = spec.life
    Cp = np.concatenate([np.zeros(C.shape[:-1] + (L,)), C], axis=-1)
    F = M.sn_cdf((Cp - mu[..., None]) / np.exp(p["log_sigma"]), p["alpha"])
    if spec.mix:
        pi = special.expit(p["logit_pi"])
        days = day0 + np.arange(-L, C.shape[-1]) + 1.0          # calendar doy of each Cp column
        m = p["m0"] + p["m1"] * (np.asarray(lat, float) - LAT0)
        Fd = special.ndtr((days[None, :] - np.atleast_1d(m)[:, None]) / np.exp(p["log_s"]))
        F = pi * F + (1 - pi) * Fd.reshape(F.shape)
    return F[..., L:] - F[..., :-L]


def record_logq(p, spec, P):
    a = flight(p, spec, P.inc, P.dayl, P.lat, P.chill, P.yi) * P.mask
    ae = a * P.E
    z1 = ae.sum(1)
    z2 = (P.E * P.mask).sum(1)
    q = (1 - EPS) * ae[P.rg, P.rk] / np.maximum(z1[P.rg], 1e-300) + EPS * P.E[P.rg, P.rk] / z2[P.rg]
    return np.log(np.maximum(q, 1e-300))


def nll(x, names, spec, P):
    p = unpack(x, names)
    return -(P.rw * record_logq(p, spec, P)).sum() + (p["u"] ** 2).sum() / (2 * TAU ** 2)


@dataclass
class Fit4:
    spec: Spec4
    params: dict
    nll: float
    n: int

    def without_year(self):
        p = dict(self.params)
        p["u"] = np.array([])
        return p


def _start(P):
    C = np.cumsum(P.inc, 1)[P.rg, P.rk]
    q25, q50, q75 = np.percentile(C, [25, 50, 75])
    sig = max((q75 - q25) / 1.349, 20.0)
    doy = P.rk + D0 + 1
    return {"mu0": q50 - 0.8 * sig, "log_sigma": np.log(sig * 1.4), "m0": float(np.median(doy))}


def _fit_from(P, spec, start, maxiter):
    names = param_names(spec, P.n_years)
    s = {k: v[3] for k, v in _P.items() if v[3] is not None}
    s.update(_start(P))
    s.update({k: v for k, v in (start or {}).items() if k in s or k in _P})
    pos = {"mu0": (0, 1500), "alpha": (0, 15)} if spec.positive else {}
    bounds = [(-20, 20) if n.startswith("u") else
              ((pos[n][0] / _P[n][0], pos[n][1] / _P[n][0]) if n in pos else (_P[n][1] / _P[n][0], _P[n][2] / _P[n][0]))
              for n in names]
    x0 = np.array([0.0 if n.startswith("u") else s[n] / _sc(n) for n in names])
    x0 = np.clip(x0, [b[0] for b in bounds], [b[1] for b in bounds])
    if USE_JAX:
        from . import jaxlik
        f = jaxlik.make_nll(spec, P, names, [_sc(n) for n in names], LIFE=spec.life)
        res = optimize.minimize(f, x0, jac=True, method="L-BFGS-B", bounds=bounds,
                                options={"maxiter": maxiter * 4, "maxfun": 50000})
    else:
        res = optimize.minimize(nll, x0, args=(names, spec, P), method="L-BFGS-B", bounds=bounds,
                                options={"maxiter": maxiter, "maxfun": 50000})
    return Fit4(spec, unpack(res.x, names), float(res.fun), len(P.rg))


def fit(P, spec, start=None, maxiter=500):
    """Best of several starts (P3's two skew basins), and, for any extra term, a start from the plain fit."""
    if start is not None:
        return _fit_from(P, spec, start, maxiter)
    C = np.cumsum(P.inc, 1)[P.rg, P.rk]
    lo = float(np.percentile(C, 10))
    base = Spec4("base", photo=spec.photo, effort=spec.effort, life=spec.life, positive=spec.positive)
    fits = [_fit_from(P, base, st, maxiter) for st in
            (None, {"alpha": 10.0, "log_sigma": np.log(200.0), "mu0": lo},
             {"alpha": 0.5, "log_sigma": np.log(200.0), "mu0": lo})]
    best = min(fits, key=lambda f: f.nll)
    if base == replace(spec, name="base"):
        return replace(best, spec=spec)
    st = {k: v for k, v in best.params.items() if k != "u" and v is not None}
    starts = [st]
    if spec.gate:
        starts = [{**st, "gate_d": g} for g in (11.0, 12.5, 14.0)]
    if spec.mix:
        starts = [{**st, "logit_pi": lp} for lp in (2.0, 0.0)]
    out = [_fit_from(P, spec, s, maxiter) for s in starts]
    return min(out, key=lambda f: f.nll)


# ---------------------------------------------------------------- predictions
def sighting_curves(p, spec, inc_rows, lat, chill, cut_idx, eprof):
    """Per-hex expected sighting curve over the whole year (day index), truncated at cut and before 1 March."""
    lat = np.asarray(lat, float)
    doy = np.arange(1, inc_rows.shape[1] + 1)
    dayl = daylength_hours(lat[:, None], doy[None, :]) / 12.0
    a = flight(p, spec, inc_rows, dayl, lat, chill, None, day0=0)
    a[:, :D0] = 0
    a[np.arange(a.shape[1])[None, :] > np.asarray(cut_idx).reshape(-1, 1)] = 0
    if eprof is not None:
        a = a * eprof
    return a


def predict_cell(p, spec, inc_rows, lat, chill, w, cut_idx, eprof):
    a = sighting_curves(p, spec, inc_rows, lat, chill, cut_idx, eprof)
    z = a.sum(1)
    ok = z > 0
    if not ok.any():
        return np.nan, np.nan
    mix = (np.asarray(w)[ok, None] * a[ok] / z[ok, None]).sum(0)
    return M.day_quantiles(mix)
