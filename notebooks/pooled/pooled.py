"""Pooled ("hierarchical") emergence model across many moth species. EXPLORATORY prototype.

Same likelihood as luna's P3 (pipeline/fit/model.py, imported, not copied): each place-year's moths have
warmth targets on a skew-normal curve; an adult flies 7 days; a sighting needs moths *and* people
(the state's daily moth-recording effort); 1% contamination; observer weights 1/sqrt(n). No latitude or
daylength term and no year effect (a held-out year gets u = 0 anyway), base 10 C from 1 March.

What is new here is how a species' curve is learned:

- **Unpooled** (the baseline): each species alone, maximum likelihood. With 10 records the curve's shape is
  mostly guesswork.
- **Pooled**: each species' three curve numbers theta_s = (log median target, log spread, skew) are drawn from
  one shared Gaussian, theta_s ~ N(m(traits_s), Sigma). Fitted by empirical Bayes in three steps:
  1. fit every *other* species alone and keep its estimate and its uncertainty (Laplace: inverse Hessian);
  2. learn the shared Gaussian from those estimates (random-effects meta-analysis, maximum likelihood,
     each species' own uncertainty added to Sigma so noisy species count less);
  3. refit the target species with that Gaussian as its prior (posterior mode).
  The prior for species s never uses species s ("leave-species-out"), so a data-poor species is treated
  like a new species joining the map.

Analogy: a new student's first quiz score is a noisy read of their ability. Averaging it with what you know
about students like them (same class, same year) gives a better guess, more so the fewer quizzes they've sat.
"""
from dataclasses import dataclass

import numpy as np
from scipy import optimize

from fit import model as M
from fit.model import Spec

SPEC = Spec("pooled_flat", mu="flat", year_effect=False, positive=True)   # likelihood options for every arm
BASELINE = Spec("p31_flat_noyear", mu="flat", year_effect=False, positive=True)  # P3 code, P3.1 bounds

NAMES = ("log_med", "log_sigma", "alpha")
LO = np.array([np.log(5.0), np.log(5.0), 0.0])
HI = np.array([np.log(3000.0), np.log(800.0), 15.0])

# ---------------------------------------------------------------- speed: one CDF table for every alpha
# P3's sn_cdf builds a 15,001-point Owen's T table for each new alpha (~10 ms). A fitter that moves alpha
# every step pays that on every likelihood call, which made the ~20,000 fits here take days. So the CDF is
# tabulated once on a (z, alpha) grid and interpolated linearly in alpha; max error vs exact is checked in
# test_pooled.py (< 2e-4). It is installed into fit.model, so every arm, the P3 baseline too, uses it.
_ZT = np.linspace(-15, 15, 6001)
_AT = np.linspace(0, 15, 751)
_TAB = None
_exact_sn_cdf = M.sn_cdf


def _table():
    global _TAB
    if _TAB is None:
        _TAB = np.maximum.accumulate(M.sn_cdf_exact(_ZT[None, :], _AT[:, None]), axis=1).astype(np.float64)
    return _TAB


def fast_sn_cdf(z, alpha):
    if alpha < 0 or alpha > 15:
        return _exact_sn_cdf(z, alpha)
    T = _table()
    f = alpha / (_AT[1] - _AT[0])
    i = min(int(f), len(_AT) - 2)
    w = f - i
    return (1 - w) * np.interp(z, _ZT, T[i]) + w * np.interp(z, _ZT, T[i + 1])


M.sn_cdf = fast_sn_cdf

# median of the standard skew-normal as a function of alpha (tabulated once; smooth)
_AG = np.linspace(0, 15, 301)
_Q50 = np.array([M.sn_quantile(0.5, a) for a in _AG])


def q50(alpha):
    return float(np.interp(alpha, _AG, _Q50))


def to_p(x):
    """(log median, log sigma, alpha) -> P3 parameter dict (mu0 = median - sigma * standard median)."""
    med, sig, a = np.exp(x[0]), np.exp(x[1]), float(x[2])
    return {"mu0": med - sig * q50(a), "log_sigma": float(x[1]), "alpha": a, "beta": 0.0, "gamma": 0.0,
            "u": np.array([])}


def from_p(p):
    med = p["mu0"] + np.exp(p["log_sigma"]) * q50(p["alpha"])
    return np.array([np.log(max(med, 5.0)), p["log_sigma"], p["alpha"]])


def nll_x(x, P):
    return -(P.rw * M.record_logq(to_p(x), SPEC, P)).sum()


@dataclass
class Prior:
    mean: np.ndarray        # (3,)
    prec: np.ndarray        # (3, 3) inverse covariance


@dataclass
class XFit:
    x: np.ndarray
    nll: float
    n: int

    def params(self):
        return to_p(self.x)


def _starts(P):
    C = np.cumsum(P.inc, 1)[P.rg, P.rk]
    q25, q50_, q75 = np.percentile(C, [25, 50, 75])
    ls = np.log(np.clip((q75 - q25) / 1.349, 20, 600))
    lm = np.log(max(q50_, 10.0))
    return [np.array([lm, ls, a]) for a in (0.5, 3.0, 10.0)]


def fit_x(P, prior: Prior | None = None, extra_starts=(), data_starts=True):
    """Posterior mode (or ML when prior is None) in (log median, log sigma, alpha), best of several starts."""
    def f(x):
        v = nll_x(x, P)
        if prior is not None:
            d = x - prior.mean
            v += 0.5 * d @ prior.prec @ d
        return v

    starts = (_starts(P) if data_starts else []) + [np.asarray(s, float) for s in extra_starts]
    if prior is not None:
        starts.append(prior.mean.copy())
    best = None
    bounds = list(zip(LO, HI))
    for s in starts:
        r = optimize.minimize(f, np.clip(s, LO, HI), method="L-BFGS-B", bounds=bounds,
                              options={"maxiter": 300})
        if best is None or r.fun < best.fun:
            best = r
    return XFit(best.x, float(best.fun), len(P.rg))


def hessian(fun, x, h=(0.02, 0.02, 0.1)):
    """Central-difference Hessian; steps are pulled inside the bounds."""
    k = len(x)
    H = np.zeros((k, k))
    h = np.asarray(h, float)
    x = np.clip(x, LO + h, HI - h)
    f0 = fun(x)
    for i in range(k):
        ei = np.zeros(k); ei[i] = h[i]
        H[i, i] = (fun(x + ei) - 2 * f0 + fun(x - ei)) / h[i] ** 2
        for j in range(i + 1, k):
            ej = np.zeros(k); ej[j] = h[j]
            H[i, j] = H[j, i] = (fun(x + ei + ej) - fun(x + ei - ej) - fun(x - ei + ej) + fun(x - ei - ej)) / (4 * h[i] * h[j])
    return H


def laplace_cov(xf: XFit, P, max_var=(4.0, 4.0, 100.0)):
    """Inverse Hessian of the (unpenalised) negative log-likelihood at the fit; a parameter that is flat or
    on a bound gets a large variance so it barely informs the shared Gaussian."""
    H = hessian(lambda x: nll_x(x, P), xf.x)
    w, V = np.linalg.eigh((H + H.T) / 2)
    w = np.maximum(w, 1e-6)
    C = V @ np.diag(1 / w) @ V.T
    cap = np.asarray(max_var, float)
    d = np.sqrt(np.minimum(np.diag(C), cap) / np.diag(C))
    return C * np.outer(d, d)


# ---------------------------------------------------------------- shared Gaussian (step 2)
def _chol(v):
    L = np.zeros((3, 3))
    L[np.tril_indices(3)] = v
    L[np.diag_indices(3)] = np.exp(np.diag(L))
    return L


def meta(theta, V, X=None, ridge=1.0):
    """Random-effects meta-analysis. theta (S, 3) species estimates, V (S, 3, 3) their covariances.

    Mean: component 0 (log median) = X @ b (X includes an intercept column; trait coefficients get a
    N(0, ridge^2) penalty), components 1-2 = constants. Sigma: full 3x3 by Cholesky. Maximum likelihood.
    Returns a function traits_row -> Prior, plus the fitted pieces.
    """
    S = len(theta)
    X = np.ones((S, 1)) if X is None else np.asarray(X, float)
    k = X.shape[1]

    def unpack(z):
        b = z[:k]
        m12 = z[k:k + 2]
        L = _chol(z[k + 2:])
        return b, m12, L

    def nll(z):
        b, m12, L = unpack(z)
        Sig = L @ L.T
        mu = np.column_stack([X @ b, np.tile(m12, (S, 1))])
        C = Sig[None] + V
        d = theta - mu
        _, ld = np.linalg.slogdet(C)
        sol = np.linalg.solve(C, d[..., None])[..., 0]
        tot = 0.5 * (ld + (d * sol).sum(1)).sum()
        return tot + 0.5 * (b[1:] ** 2).sum() / ridge ** 2

    sd0 = np.log(np.maximum(theta.std(0), 0.05))
    z0 = np.concatenate([[theta[:, 0].mean()], np.zeros(k - 1), theta[:, 1:].mean(0),
                         np.array([sd0[0], 0, sd0[1], 0, 0, sd0[2]])])
    r = optimize.minimize(nll, z0, method="L-BFGS-B", options={"maxiter": 2000})
    b, m12, L = unpack(r.x)
    Sig = L @ L.T

    def prior(xrow=None):
        xrow = np.ones(1) if xrow is None else np.asarray(xrow, float)
        return Prior(np.array([xrow @ b, *m12]), np.linalg.inv(Sig))
    return prior, {"b": b, "m12": m12, "Sigma": Sig, "nll": float(r.fun), "ok": bool(r.success)}
