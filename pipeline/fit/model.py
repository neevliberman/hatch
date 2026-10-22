"""The P3 emergence model and its likelihood (plain-language walkthrough in README.md).

Analogy: every spot keeps a warmth bank account (degree-days, base 10 C, from 1 March).
Each moth has its own savings target. Targets follow a skewed curve (skew-normal):
location mu, spread sigma, skew alpha. A moth flies for about a week after it
reaches its target, so on day t the share of a spot's moths in the air is
F(DD(t)) - F(DD(t - 7)), where F is the curve's cumulative share.

mu can move with latitude (one slope, "lat"), or the bank can pay a daylength bonus
(photothermal units: each day's degree-days times (daylength / 12 h) ** gamma, "photo"),
or neither ("flat"). A shrunken year effect u_y shifts mu in training years; a new
year gets u = 0.

Sightings are where moths fly AND people look: the chance a sighting falls on day t is
the flight share times that state's moth-recording effort that day (all moths except
butterflies, the "target-group background"), plus a 1% "anything goes" term, over the
window 1 March .. brood cut-off.

Shapes: day index i is calendar day i + 1 (Daymet yday = calendar doy).
"""
from dataclasses import dataclass, replace

import numpy as np
import pandas as pd
from scipy import optimize, special

from .data import daylength_hours

D0, D1 = 59, 240          # fit window: day indices 59..239 = doy 60 (1 Mar, 29 Feb in leap years) .. 240
LIFE = 7                  # adult flight life, days
EPS = 0.01                # contamination share
TAU = 30.0                # prior SD of the year effect, degree-days
LAT0 = 42.0               # latitude where mu0 applies
Q_ONSET, Q_PEAK = 0.10, 0.50


@dataclass(frozen=True)
class Spec:
    name: str
    mu: str = "lat"            # "lat" | "photo" | "flat"
    skew: bool = True
    effort: bool = True
    year_effect: bool = True
    observer_weights: bool = True


SPECS = {
    "p3_lat": Spec("p3_lat"),
    "p3_photo": Spec("p3_photo", mu="photo"),
    "p3_flat": Spec("p3_flat", mu="flat"),
    "p3_noeffort": Spec("p3_noeffort", effort=False),
    "p3_bell": Spec("p3_bell", skew=False),
}


# ---------------------------------------------------------------- skew-normal CDF
_Z = np.linspace(-15, 15, 15001)
_cache = {}


def sn_cdf_exact(z, alpha):
    """Standard skew-normal CDF: Phi(z) - 2 T(z, alpha) (Owen's T). scipy's skewnorm.cdf is ~1000x slower."""
    return np.clip(special.ndtr(z) - 2 * special.owens_t(z, alpha), 0.0, 1.0)


def sn_cdf(z, alpha):
    """Standard skew-normal CDF; tabulated per alpha and interpolated (exact for alpha = 0)."""
    if alpha == 0:
        return special.ndtr(z)
    a = round(float(alpha), 12)
    tab = _cache.get(a)
    if tab is None:
        if len(_cache) > 64:
            _cache.clear()
        tab = _cache[a] = np.maximum.accumulate(sn_cdf_exact(_Z, a))
    return np.interp(z, _Z, tab)


def sn_quantile(p, alpha):
    if alpha == 0:
        return float(special.ndtri(p))
    return float(optimize.brentq(lambda z: sn_cdf_exact(z, alpha) - p, -15, 15, xtol=1e-10))


# ---------------------------------------------------------------- parameters
def param_names(spec, n_years):
    names = ["mu0"]
    if spec.mu == "lat":
        names.append("beta")
    elif spec.mu == "photo":
        names.append("gamma")
    names.append("log_sigma")
    if spec.skew:
        names.append("alpha")
    if spec.year_effect:
        names += [f"u{i}" for i in range(n_years)]
    return names


# optimiser works on scaled values (all order 1)
_SCALE = {"mu0": 100.0, "beta": 10.0, "gamma": 1.0, "log_sigma": 1.0, "alpha": 1.0}
_BOUNDS = {"mu0": (-500, 1500), "beta": (-150, 150), "gamma": (-6, 12), "log_sigma": (np.log(5), np.log(800)),
           "alpha": (-15, 15)}


def _scale(n):
    return 10.0 if n.startswith("u") else _SCALE[n]


def unpack(x, names):
    p = {"beta": 0.0, "gamma": 0.0, "alpha": 0.0}
    u = []
    for n, v in zip(names, x):
        v = v * _scale(n)
        if n.startswith("u"):
            u.append(v)
        else:
            p[n] = v
    p["u"] = np.array(u)
    return p


# ---------------------------------------------------------------- data for one fit
@dataclass
class Prepared:
    inc: np.ndarray      # (G, K) daily degree-days in the window
    lat: np.ndarray      # (G,)  hex-centre latitude
    dayl: np.ndarray     # (G, K) daylength / 12 h
    yi: np.ndarray       # (G,)  year-effect index
    E: np.ndarray        # (G, K) effort (ones when not used)
    mask: np.ndarray     # (G, K) day inside the window (<= brood cut-off)
    rg: np.ndarray       # (N,) record -> group
    rk: np.ndarray       # (N,) record -> day offset in window
    rw: np.ndarray       # (N,) record weight (mean 1)
    n_years: int
    year_ids: list


def observer_weights(user_ids):
    """1 / sqrt(records by that observer), rescaled to mean 1: a prolific observer counts, but less than linearly."""
    u = pd.Series(np.asarray(user_ids))
    n = u.map(u.value_counts()).to_numpy(float)
    w = 1 / np.sqrt(n)
    return w * len(w) / w.sum()


def prepare(rec, inc_cube, cut_idx, spec, E_cube=None, year_ids=None):
    """rec columns: h, y, t, band, hex_lat, s (state index), user_id; optional 'yid' (pseudo-year).

    cut_idx: {band: last allowed day index}. inc_cube: daily degree-days [hex, year, 365].
    """
    r = rec.copy()
    if "yid" not in r:
        r["yid"] = r["y"]
    r["cut"] = r["band"].map(cut_idx).astype(int)
    r = r[(r.t >= D0) & (r.t < D1) & (r.t <= r.cut)]
    if year_ids is None:
        year_ids = sorted(r.yid.unique())
    ymap = {v: i for i, v in enumerate(year_ids)}
    keys = ["h", "y", "yid", "band"]
    gkey = r.groupby(keys, sort=True).ngroup().to_numpy()
    g = r.assign(g=gkey).groupby("g").first()
    G, K = len(g), D1 - D0
    h, y = g.h.to_numpy(), g.y.to_numpy()
    inc = inc_cube[h, y, D0:D1].astype(np.float64)
    lat = g.hex_lat.to_numpy(float)
    doy = np.arange(D0, D1) + 1
    dayl = daylength_hours(lat[:, None], doy[None, :]) / 12.0
    if spec.effort and E_cube is not None:
        E = E_cube[g.s.to_numpy(), y, D0:D1].astype(np.float64)
    else:
        E = np.ones((G, K))
    mask = (np.arange(D0, D1)[None, :] <= g.cut.to_numpy()[:, None])
    w = observer_weights(r.user_id) if spec.observer_weights else np.ones(len(r))
    return Prepared(inc, lat, dayl, np.array([ymap.get(v, -1) for v in g.yid]), E, mask,
                    gkey, (r.t - D0).to_numpy(), w, len(year_ids), list(year_ids))


# ---------------------------------------------------------------- curve maths
def _mu(p, spec, lat, yi):
    mu = p["mu0"] + (p["beta"] * (lat - LAT0) if spec.mu == "lat" else 0.0)
    if spec.year_effect and len(p["u"]) and yi is not None:
        mu = mu + np.where(yi >= 0, p["u"][np.clip(yi, 0, None)], 0.0)
    return np.broadcast_to(np.asarray(mu, float), np.shape(lat))


def _cum(inc, dayl, p, spec):
    return np.cumsum(inc * dayl ** p["gamma"] if spec.mu == "photo" else inc, axis=-1)


def flight(p, spec, inc, dayl, lat, yi=None):
    """Share of moths in the air each day (rows: places; columns: days of `inc`)."""
    C = _cum(inc, dayl, p, spec)
    mu = _mu(p, spec, lat, yi)
    sig = np.exp(p["log_sigma"])
    Cp = np.concatenate([np.zeros(C.shape[:-1] + (LIFE,)), C], axis=-1)
    F = sn_cdf((Cp - mu[..., None]) / sig, p["alpha"])
    return F[..., LIFE:] - F[..., :-LIFE]


def record_logq(p, spec, P: Prepared):
    """Log chance of each record's day, given its place-year (with contamination)."""
    a = flight(p, spec, P.inc, P.dayl, P.lat, P.yi) * P.mask
    ae = a * P.E
    z1 = ae.sum(1)
    ce = P.E * P.mask
    z2 = ce.sum(1)
    q = (1 - EPS) * ae[P.rg, P.rk] / np.maximum(z1[P.rg], 1e-300) + EPS * P.E[P.rg, P.rk] / z2[P.rg]
    return np.log(np.maximum(q, 1e-300))


def nll(x, names, spec, P):
    p = unpack(x, names)
    v = -(P.rw * record_logq(p, spec, P)).sum()
    if spec.year_effect:
        v += (p["u"] ** 2).sum() / (2 * TAU ** 2)
    return v


@dataclass
class Fit:
    spec: Spec
    params: dict
    names: list
    x: np.ndarray
    nll: float
    n: int
    converged: bool

    def without_year(self):
        p = dict(self.params)
        p["u"] = np.array([])
        return p


def _start(spec, P):
    # degree-days at the records give a sensible starting location and spread
    C = np.cumsum(P.inc, 1)[P.rg, P.rk]
    q25, q50, q75 = np.percentile(C, [25, 50, 75])
    sig = max((q75 - q25) / 1.349, 20.0)
    x = {"mu0": q50 - (0.8 * sig if spec.skew else 0.0), "beta": 0.0, "gamma": 0.0,
         "log_sigma": np.log(sig * (1.4 if spec.skew else 1.0)), "alpha": 2.0}
    return x


def _fit_from(P, spec, start, maxiter):
    names = param_names(spec, P.n_years)
    s = _start(spec, P)
    if start:
        s.update({k: v for k, v in start.items() if k in s})
    x0 = np.array([0.0 if n.startswith("u") else s[n] / _scale(n) for n in names])
    bounds = [(-20, 20) if n.startswith("u") else tuple(b / _scale(n) for b in _BOUNDS[n]) for n in names]
    res = optimize.minimize(nll, x0, args=(names, spec, P), method="L-BFGS-B", bounds=bounds,
                            options={"maxiter": maxiter, "maxfun": 50000})
    return Fit(spec, unpack(res.x, names), names, res.x, float(res.fun), len(P.rg), bool(res.success))


def fit(P: Prepared, spec: Spec, start=None, maxiter=500):
    """Maximum (penalised) likelihood, best of several starts.

    The likelihood has two basins: a strongly skewed curve (alpha ~ 10) and a wide, nearly
    symmetric one. A single start can stall in the worse basin (it did in the first P3 run,
    see FROZEN_P3.md change log), so the fit starts from both and keeps the lower value.
    Models with a latitude or daylength term also start from the 'flat' fit.
    """
    if start is not None:
        return _fit_from(P, spec, start, maxiter)
    starts = [None]
    if spec.skew:
        C = np.cumsum(P.inc, 1)[P.rg, P.rk]
        lo = float(np.percentile(C, 10))
        starts += [{"alpha": a, "log_sigma": np.log(200.0), "mu0": lo} for a in (10.0, 0.5)]
    if spec.mu != "flat":
        f0 = fit(P, replace(spec, mu="flat"), maxiter=maxiter)
        starts.append({k: v for k, v in f0.params.items() if k != "u"})
    fits = [_fit_from(P, spec, st, maxiter) for st in starts]
    return min(fits, key=lambda f: f.nll)


def heldout_loglik(p, spec, P):
    """Mean log chance per held-out record (year effect 0)."""
    return float(record_logq(p, spec, P).mean())


# ---------------------------------------------------------------- predictions
def day_quantiles(p_day, qs=(Q_ONSET, Q_PEAK)):
    cs = np.cumsum(p_day)
    cs = cs / cs[-1]
    return [int(np.searchsorted(cs, q)) for q in qs]


def predict_band(p, spec, inc_rows, lat, w, cut_idx, eprof=None):
    """Onset and peak day index for a band-year: hex-weighted mix of each hex's
    within-window sighting curve (flight share x typical effort), truncated at the brood cut-off."""
    lat = np.asarray(lat, float)
    doy = np.arange(1, inc_rows.shape[1] + 1)
    dayl = daylength_hours(lat[:, None], doy[None, :]) / 12.0
    a = flight(p, spec, inc_rows, dayl, lat)
    a[:, :D0] = 0
    a[:, cut_idx + 1:] = 0
    if eprof is not None:
        a = a * eprof
    z = a.sum(1)
    ok = z > 0
    if not ok.any():
        return np.nan, np.nan
    mix = (np.asarray(w)[ok, None] * a[ok] / z[ok, None]).sum(0)
    return day_quantiles(mix)


def cell_share(p, spec, inc_rows, lat):
    """Cumulative share of moth flying-days by each day (0..1), per cell, untruncated:
    the map's 'how far through the first-brood season is this spot'."""
    lat = np.asarray(lat, float)
    doy = np.arange(1, inc_rows.shape[1] + 1)
    dayl = daylength_hours(lat[:, None], doy[None, :]) / 12.0
    a = flight(p, spec, inc_rows, dayl, lat)
    a[:, :D0] = 0
    return np.cumsum(a, axis=-1) / LIFE


def cell_sighting_share(p, spec, inc_rows, lat, cut_idx, eprof=None):
    """Cumulative share (0..1) of a cell's expected first-brood *sightings* by each day: flight share x
    typical effort, from 1 March to the cell's brood cut-off. This is the quantity the scores test
    (predict_band is the hex-weighted mix of these), so the map shows what was validated.
    cut_idx: per-cell last day index. Cells with no expected sightings get all zeros."""
    lat = np.asarray(lat, float)
    doy = np.arange(1, inc_rows.shape[1] + 1)
    dayl = daylength_hours(lat[:, None], doy[None, :]) / 12.0
    a = flight(p, spec, inc_rows, dayl, lat)
    a[:, :D0] = 0
    a[np.arange(a.shape[1])[None, :] > np.asarray(cut_idx)[:, None]] = 0
    if eprof is not None:
        a = a * eprof
    cs = np.cumsum(a, axis=-1)
    tot = cs[:, -1:]
    return np.divide(cs, tot, out=np.zeros_like(cs), where=tot > 0)


def median_dd(p, spec, lat):
    """Degree-days (base 10) at which half the moths have reached their target, at latitude `lat`
    (for 'photo' this is in photothermal units)."""
    mu = p["mu0"] + (p["beta"] * (np.asarray(lat) - LAT0) if spec.mu == "lat" else 0.0)
    return mu + np.exp(p["log_sigma"]) * sn_quantile(0.5, p["alpha"])


def with_spec(spec, **kw):
    return replace(spec, **kw)
