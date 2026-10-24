"""Simulate-and-recover for the pooled fitter (no network). Run: python3 -m pytest notebooks/pooled"""
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for p in (ROOT / "notebooks", ROOT / "pipeline", HERE):
    sys.path.insert(0, str(p))

from fit import model as M, simulate  # noqa: E402
import pooled as PL  # noqa: E402


def test_reparam_roundtrip():
    x = np.array([np.log(220.0), np.log(90.0), 7.0])
    assert np.allclose(PL.from_p(PL.to_p(x)), x, atol=1e-6)
    p = PL.to_p(x)
    assert abs(M.median_dd(p, M.SPECS["p3_flat"], 42.0) - 220.0) < 0.5


def _world(theta, n_per, seed):
    lat, inc, E = simulate.synthetic_world(n_hex=6, n_years=4, seed=seed)
    p = PL.to_p(theta)
    r = simulate.draw_records(p, PL.SPEC, lat, inc, E, n_per=n_per, seed=seed + 1)
    return M.prepare(r, inc, {"all": 239}, PL.SPEC, E)


def test_unpooled_matches_p3_fitter():
    """With no prior, the pooled code's fitter finds the same curve as P3's own fitter."""
    P = _world(np.array([np.log(250.0), np.log(80.0), 5.0]), 40, 3)
    a = PL.fit_x(P)
    b = M.fit(P, PL.BASELINE)
    assert abs(a.nll - b.nll) < 0.5
    assert abs(np.exp(a.x[0]) - M.median_dd(b.params, PL.BASELINE, 42.0)) < 10


def test_pooling_helps_when_species_share_a_curve_shape():
    """Plant 10 species whose medians differ but whose shapes come from one tight Gaussian. With 12
    records each, the pooled curve (its 10/50/90% warmth targets) should be closer to the truth on average.
    (The median alone is already well pinned by 12 records; what pooling fixes is the curve's shape.)"""
    rng = np.random.default_rng(0)
    truth = np.column_stack([rng.normal(np.log(220), 0.25, 10), rng.normal(np.log(90), 0.15, 10),
                             rng.normal(6, 1.0, 10).clip(0.5, 14)])
    Ps = [_world(t, 2, 10 + i) for i, t in enumerate(truth)]     # 6 hexes x 4 years x 2 = 48 records
    rich = [_world(t, 25, 100 + i) for i, t in enumerate(truth)]  # data-rich copies to learn the prior from
    fits = [PL.fit_x(P) for P in rich]
    th = np.array([f.x for f in fits])
    V = np.array([PL.laplace_cov(f, P) for f, P in zip(fits, rich)])
    def q(x, p):                       # warmth (DD) by which share p of the species' moths are out
        pp = PL.to_p(x)
        return pp["mu0"] + np.exp(pp["log_sigma"]) * M.sn_quantile(p, pp["alpha"])

    err_u, err_p = [], []
    for s in range(10):
        others = [k for k in range(10) if k != s]
        prior = PL.meta(th[others], V[others])[0]()
        sub = Ps[s]
        idx = np.random.default_rng(s).choice(len(sub.rg), 12, replace=False)
        sub.rg, sub.rk, sub.rw = sub.rg[idx], sub.rk[idx], np.ones(12)
        u, p = PL.fit_x(sub), PL.fit_x(sub, prior)
        for e, f in ((err_u, u), (err_p, p)):
            e.append(np.mean([abs(q(f.x, pr) - q(truth[s], pr)) for pr in (0.1, 0.5, 0.9)]))
    assert np.mean(err_p) < np.mean(err_u)
