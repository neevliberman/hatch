"""Fast, exact-gradient version of model4's likelihood (JAX), so ten times the records fit in minutes.

Same maths as model4.record_logq. The one trick is the skew-normal CDF F(z; alpha) = Phi(z) - 2 T(z, alpha):
its value comes from a table (as in P3), but its derivatives are exact closed forms,
    dF/dz     = 2 phi(z) Phi(alpha z)
    dF/dalpha = -exp(-z^2 (1 + alpha^2) / 2) / (pi (1 + alpha^2)),
so the optimiser gets true gradients instead of 30 finite-difference likelihood calls per step.
"""
import jax
import jax.numpy as jnp
import numpy as np
from jax.scipy.special import ndtr

from fit import model as M

jax.config.update("jax_enable_x64", True)

_Z = np.linspace(-15, 15, 6001)
_A = np.linspace(-15, 15, 1201)
_TAB = None


def _table():
    global _TAB
    if _TAB is None:
        _TAB = np.stack([np.maximum.accumulate(M.sn_cdf_exact(_Z, a)) for a in _A])
    return _TAB


@jax.custom_jvp
def sn_cdf(z, alpha):
    tab = jnp.asarray(_table())
    fa = (alpha - _A[0]) / (_A[1] - _A[0])
    i = jnp.clip(jnp.floor(fa).astype(int), 0, len(_A) - 2)
    w = fa - i
    row = (1 - w) * tab[i] + w * tab[i + 1]
    return jnp.interp(z, jnp.asarray(_Z), row)


@sn_cdf.defjvp
def _sn_jvp(primals, tangents):
    z, alpha = primals
    dz, da = tangents
    f = sn_cdf(z, alpha)
    pdf = 2 * jnp.exp(-0.5 * z * z) / jnp.sqrt(2 * jnp.pi) * ndtr(alpha * z)
    dfa = -jnp.exp(-0.5 * z * z * (1 + alpha * alpha)) / (jnp.pi * (1 + alpha * alpha))
    return f, pdf * dz + dfa * da


def make_nll(spec, P, names, scales, LIFE=M.LIFE, EPS=M.EPS, TAU=M.TAU, LAT0=M.LAT0, D0=M.D0, GATE_W=0.3):
    """Return a jitted (x -> (nll, grad)) for scaled parameter vector x."""
    inc, dayl, lat, chill = map(jnp.asarray, (P.inc, P.dayl, P.lat, P.chill))
    yi = jnp.asarray(P.yi)
    E, mask = jnp.asarray(P.E), jnp.asarray(P.mask, float)
    rg, rk, rw = jnp.asarray(P.rg), jnp.asarray(P.rk), jnp.asarray(P.rw)
    ce = E * mask
    z2 = ce.sum(1)
    idx = {n: i for i, n in enumerate(names)}
    uix = jnp.asarray([i for i, n in enumerate(names) if n.startswith("u")], dtype=int)
    sc = jnp.asarray(scales)
    K = inc.shape[1]
    days = D0 + jnp.arange(-LIFE, K) + 1.0

    def get(x, n, default=0.0):
        return x[idx[n]] if n in idx else default

    def f(xs):
        x = xs * sc
        w = inc
        if spec.photo:
            w = w * dayl ** get(x, "gamma")
        if spec.gate:
            w = w * jax.nn.sigmoid((dayl * 12.0 - get(x, "gate_d")) / GATE_W)
        C = jnp.cumsum(w, axis=1)
        mu = get(x, "mu0") + get(x, "beta") * (lat - LAT0) + get(x, "kappa") * chill
        u = x[uix] if len(uix) else jnp.zeros(1)
        if len(uix):
            mu = mu + jnp.where(yi >= 0, u[jnp.clip(yi, 0, None)], 0.0)
        Cp = jnp.concatenate([jnp.zeros((C.shape[0], LIFE)), C], axis=1)
        F = sn_cdf((Cp - mu[:, None]) / jnp.exp(get(x, "log_sigma")), get(x, "alpha"))
        if spec.mix:
            pi = jax.nn.sigmoid(get(x, "logit_pi"))
            m = get(x, "m0") + get(x, "m1") * (lat - LAT0)
            Fd = ndtr((days[None, :] - m[:, None]) / jnp.exp(get(x, "log_s")))
            F = pi * F + (1 - pi) * Fd
        a = (F[:, LIFE:] - F[:, :-LIFE]) * mask
        ae = a * E
        z1 = ae.sum(1)
        q = (1 - EPS) * ae[rg, rk] / jnp.maximum(z1[rg], 1e-300) + EPS * E[rg, rk] / z2[rg]
        v = -(rw * jnp.log(jnp.maximum(q, 1e-300))).sum()
        if len(uix):
            v = v + (u ** 2).sum() / (2 * TAU ** 2)
        return v

    vg = jax.jit(jax.value_and_grad(f))

    def call(xs):
        v, g = vg(jnp.array(xs, copy=True))
        v, g = float(v), np.array(g, dtype=float)
        if not np.isfinite(v):
            return 1e15, np.zeros_like(g)
        # far-off trial points (the line search's first jump to a bound) can underflow to 0/0 in the gradient;
        # a finite value with a zeroed bad gradient lets the line search simply step back
        return v, np.nan_to_num(g, nan=0.0, posinf=0.0, neginf=0.0)
    return call
