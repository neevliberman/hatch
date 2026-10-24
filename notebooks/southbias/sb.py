"""Candidate fixes for the 2026 far-south miss (rules in PREREG.md). Pure functions; run.py drives them.

Every candidate is a "flight" function: rows = places, columns = day index (calendar doy - 1), value = share of the
place's moths in the air that day. The band / cell summaries below copy fit.model's predict_band and
cell_sighting_share, but take that flight matrix, so P3 and every candidate are summarised by the same code.
"""
from dataclasses import dataclass, field

import numpy as np
from scipy import optimize, special

from fit import model as M
from fit.data import daylength_hours

P3 = M.SPECS["p3_photo"]
GATES = (None, 11.5, 12.0, 12.5, 13.0, 13.5, 14.0)   # daylength thresholds (h) tried by P4; None = no gate
FLAG_FROM = 90                                     # A2 looks for out-of-range banks from 1 April (day index 90)
BLEND = 0.5                                        # A2's weight on the calendar for a fully flagged strip


# ---------------------------------------------------------------- the fit's range (A1, A2)
def envelope(cum, h, y):
    """E[t]: the largest banked degree-days on day t over the place-years (h[i], y[i]) (duplicates fine)."""
    pairs = np.unique(np.column_stack([h, y]), axis=0)
    return cum[pairs[:, 0], pairs[:, 1], :].max(0).astype(float)


def cap_inc(inc, env):
    """Daily degree-days whose running total never goes above the envelope: cumsum(result) = min(cumsum(inc), env)."""
    c = np.minimum(np.cumsum(inc, -1), env[: inc.shape[-1]])
    return np.diff(c, axis=-1, prepend=0.0)


def flagged(inc, env, t_end, t0=FLAG_FROM):
    """Per row: is the bank above the envelope on any day index t0..t_end (inclusive)?"""
    c = np.cumsum(inc, -1)
    t_end = int(min(t_end, inc.shape[-1] - 1))
    if t_end < t0:
        return np.zeros(len(inc), bool)
    return (c[:, t0:t_end + 1] > env[t0:t_end + 1] + 1e-9).any(1)


def blend_weight(flags, w, blend=BLEND):
    """A2: blend * (weighted share of flagged places)."""
    w = np.asarray(w, float)
    return float(blend * (w * np.asarray(flags, float)).sum() / w.sum())


def blend(fc, cal, wt):
    return fc + wt * (cal - fc)


# ---------------------------------------------------------------- gate (B)
def gate_mask(lat, doy, hours):
    """1 on days whose daylength at lat is at least `hours` (None: every day), else 0. lat [n], doy [k] -> [n, k]."""
    lat = np.asarray(lat, float)
    doy = np.asarray(doy, float)
    if hours is None:
        return np.ones((len(lat), len(doy)))
    return (daylength_hours(lat[:, None], doy[None, :]) >= hours).astype(float)


# ---------------------------------------------------------------- the candidates as flight functions
@dataclass
class Cand:
    """kind: 'p3' | 'cap' | 'gate' | 'mix'. params: P3-style dict (u dropped), plus pi/m0/b/log_s for 'mix'."""
    kind: str
    params: dict
    gate: float = None
    env: np.ndarray = None
    extra: dict = field(default_factory=dict)

    def flight(self, inc, lat):
        lat = np.asarray(lat, float)
        doy = np.arange(1, inc.shape[1] + 1)
        dayl = daylength_hours(lat[:, None], doy[None, :]) / 12.0
        if self.kind == "cap":
            inc = cap_inc(inc, self.env)
        if self.kind in ("gate", "mix") and self.gate is not None:
            inc = inc * gate_mask(lat, doy, self.gate)
        a = M.flight(self.params, P3, inc, dayl, lat)
        if self.kind == "mix":
            a = self.params["pi"] * a + (1 - self.params["pi"]) * date_flight(self.params, lat, np.arange(inc.shape[1]))
        return a


def date_flight(p, lat, t):
    """Calendar clock: share in the air on day index t when emergence days are normal(m0 + b (lat - 42), s)."""
    m = p["m0"] + p["b"] * (np.asarray(lat, float) - M.LAT0)
    s = np.exp(p["log_s"])
    G = lambda tt: special.ndtr((tt[None, :] - m[:, None]) / s)  # noqa: E731
    return G(np.asarray(t, float)) - G(np.asarray(t, float) - M.LIFE)


def predict_band(a, w, cut_idx, eprof=None):
    """fit.model.predict_band on a ready flight matrix a [hex, 365]."""
    a = a.copy()
    a[:, :M.D0] = 0
    a[:, cut_idx + 1:] = 0
    if eprof is not None:
        a = a * eprof
    z = a.sum(1)
    ok = z > 0
    if not ok.any():
        return np.nan, np.nan
    mix = (np.asarray(w)[ok, None] * a[ok] / z[ok, None]).sum(0)
    return M.day_quantiles(mix)


def sighting_share(a, cut_idx, eprof=None):
    """fit.model.cell_sighting_share on a ready flight matrix (cut_idx per row)."""
    a = a.copy()
    a[:, :M.D0] = 0
    a[np.arange(a.shape[1])[None, :] > np.asarray(cut_idx)[:, None]] = 0
    if eprof is not None:
        a = a * eprof
    cs = np.cumsum(a, axis=-1)
    tot = cs[:, -1:]
    return np.divide(cs, tot, out=np.zeros_like(cs), where=tot > 0)


# ---------------------------------------------------------------- fitting B (gate) and C (mixture)
def gated(P, hours):
    """A Prepared whose daily degree-days are zero before the daylength gate."""
    from dataclasses import replace
    if hours is None:
        return P
    return replace(P, inc=P.inc * (P.dayl * 12.0 >= hours))


def fit_gate(P, start, hours, maxiter=500):
    """Refit P3 with a fixed gate from three starts (fold's P3 fit, default, skewed), keep the best."""
    Pg = gated(P, hours)
    C = np.cumsum(Pg.inc, 1)[Pg.rg, Pg.rk]
    lo = float(np.percentile(C, 10))
    starts = [start, None, {"alpha": 10.0, "log_sigma": np.log(200.0), "mu0": lo}]
    fits = []
    for st in starts:
        if st is None:
            fits.append(M._fit_from(Pg, P3, {}, maxiter))
        else:
            fits.append(M._fit_from(Pg, P3, st, maxiter))
    return min(fits, key=lambda f: f.nll)


MIX_NAMES = ["mu0", "gamma", "log_sigma", "alpha", "logit_pi", "m0", "b", "log_s"]
MIX_SCALE = {"mu0": 100.0, "gamma": 1.0, "log_sigma": 1.0, "alpha": 1.0, "logit_pi": 1.0, "m0": 10.0, "b": 1.0,
             "log_s": 1.0}
MIX_BOUNDS = {"mu0": (-500, 1500), "gamma": (-6, 12), "log_sigma": (np.log(5), np.log(800)), "alpha": (-15, 15),
              "logit_pi": (-6, 6), "m0": (90, 220), "b": (-15, 15), "log_s": (np.log(2), np.log(60))}


def mix_unpack(x, n_years):
    p = {n: v * MIX_SCALE[n] for n, v in zip(MIX_NAMES, x[:len(MIX_NAMES)])}
    p["u"] = np.asarray(x[len(MIX_NAMES):len(MIX_NAMES) + n_years]) * 10.0
    p["beta"] = 0.0
    p["pi"] = float(special.expit(p["logit_pi"]))
    return p


def mix_record_logq(p, P, with_year=True):
    a_heat = M.flight(p, P3, P.inc, P.dayl, P.lat, P.yi if with_year else None)
    t = np.arange(M.D0, M.D1)
    a = p["pi"] * a_heat + (1 - p["pi"]) * date_flight(p, P.lat, t)
    a = a * P.mask
    ae = a * P.E
    z1 = ae.sum(1)
    z2 = (P.E * P.mask).sum(1)
    q = (1 - M.EPS) * ae[P.rg, P.rk] / np.maximum(z1[P.rg], 1e-300) + M.EPS * P.E[P.rg, P.rk] / z2[P.rg]
    return np.log(np.maximum(q, 1e-300))


def mix_nll(x, P):
    p = mix_unpack(x, P.n_years)
    return -(P.rw * mix_record_logq(p, P)).sum() + (p["u"] ** 2).sum() / (2 * M.TAU ** 2)


def mix_start(P, p3, pi):
    """Start from the fold's P3 fit; the calendar clock starts at the records' own mean day, slope 0."""
    t = P.rk + M.D0
    return {"mu0": p3["mu0"], "gamma": p3["gamma"], "log_sigma": p3["log_sigma"], "alpha": p3["alpha"],
            "logit_pi": float(special.logit(pi)), "m0": float(np.average(t, weights=P.rw)), "b": 0.0,
            "log_s": float(np.log(max(np.sqrt(np.cov(t, aweights=P.rw)), 5.0)))}


def fit_mix(P, p3, pis=(0.9, 0.6), maxiter=800):
    best = None
    bounds = [tuple(b / MIX_SCALE[n] for b in MIX_BOUNDS[n]) for n in MIX_NAMES] + [(-20, 20)] * P.n_years
    for pi in pis:
        s = mix_start(P, p3, pi)
        x0 = np.array([s[n] / MIX_SCALE[n] for n in MIX_NAMES] + [0.0] * P.n_years)
        x0 = np.clip(x0, [b[0] for b in bounds], [b[1] for b in bounds])
        r = optimize.minimize(mix_nll, x0, args=(P,), method="L-BFGS-B", bounds=bounds,
                              options={"maxiter": maxiter, "maxfun": 60000})
        if best is None or r.fun < best.fun:
            best = r
    p = mix_unpack(best.x, P.n_years)
    return {"params": {k: (v.tolist() if isinstance(v, np.ndarray) else float(v)) for k, v in p.items()},
            "nll": float(best.fun), "converged": bool(best.success)}


def no_year(p):
    q = {k: (np.asarray(v) if k == "u" else v) for k, v in p.items()}
    q["u"] = np.array([])
    q.setdefault("beta", 0.0)
    return q
