"""The JAX likelihood must equal the NumPy one, and its gradient must match finite differences."""
import numpy as np

from fit import model as M
from p4 import jaxlik, model4 as M4


def _toy(rng=np.random.default_rng(0), G=6, K=M.D1 - M.D0, n=40):
    inc = np.abs(rng.normal(3, 2, (G, K)))
    P = M4.Prep(inc, np.full((G, K), 1.2), np.linspace(36, 46, G), np.zeros(G), np.arange(G) % 2,
                np.ones((G, K)), np.ones((G, K), bool), rng.integers(0, G, n), rng.integers(0, K, n), np.ones(n), 2)
    return P


def test_value_and_gradient():
    spec = M4.SPECS4["c0"]
    P = _toy()
    names = M4.param_names(spec, 2)
    x = np.array([0.8, 0.7, 5.3, 4.0, 0.1, -0.1])
    f = jaxlik.make_nll(spec, P, names, [M4._sc(n) for n in names])
    v, g = f(x)
    assert abs(v - M4.nll(x, names, spec, P)) < 1e-3
    for i in range(len(x)):
        e = np.zeros_like(x)
        e[i] = 1e-5
        fd = (M4.nll(x + e, names, spec, P) - M4.nll(x - e, names, spec, P)) / 2e-5
        assert abs(g[i] - fd) < 0.08 * max(1.0, abs(fd))   # tables differ slightly (P3: per-alpha; here a 2-D grid)
