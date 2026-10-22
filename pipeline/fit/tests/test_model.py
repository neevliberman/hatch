"""Model maths and simulate-and-recover (no network)."""
import numpy as np
import pytest
from scipy import stats

from fit import data, model as M, simulate


def test_skew_normal_cdf_matches_scipy():
    z = np.linspace(-5, 5, 41)
    for a in (-3.0, 0.0, 2.5, 11.0):
        assert np.abs(M.sn_cdf(z, a) - stats.skewnorm.cdf(z, a)).max() < 1e-5
        assert abs(M.sn_quantile(0.5, a) - stats.skewnorm.ppf(0.5, a)) < 1e-6


def test_daylength():
    assert abs(data.daylength_hours(0.0, 80) - 12.1) < 0.2               # equator, any day
    assert abs(data.daylength_hours(42.0, 172) - 15.2) < 0.2             # 42 N, June solstice
    assert data.daylength_hours(47.0, 172) > data.daylength_hours(38.0, 172)
    assert data.daylength_hours(47.0, 355) < data.daylength_hours(38.0, 355)


def test_observer_weights():
    w = M.observer_weights([1, 1, 1, 1, 2])
    assert np.isclose(w.mean(), 1) and np.isclose(w[0] / w[4], 0.5)


def test_flight_curve_integrates_to_life():
    p = {"mu0": 200.0, "beta": 0.0, "gamma": 0.0, "log_sigma": np.log(60), "alpha": 3.0, "u": np.array([])}
    inc = np.zeros((1, 365))
    inc[0, 59:] = 8.0
    dayl = np.ones((1, 365))
    a = M.flight(p, M.SPECS["p3_flat"], inc, dayl, np.array([42.0]))
    assert np.isclose(a.sum(), M.LIFE * (1 - M.sn_cdf(np.array([-200 / 60]), 3.0)[0]), atol=1e-6)
    share = M.cell_share(p, M.SPECS["p3_flat"], inc, np.array([42.0]))[0]
    assert np.all(np.diff(share) >= -1e-12) and share[-1] <= 1 + 1e-9


def test_day_quantiles():
    p = np.zeros(100)
    p[10:20] = 1
    assert M.day_quantiles(p) == [10, 14]   # 10% reached on index 10, 50% on index 14


PLANT = {"mu0": 150.0, "beta": -12.0, "gamma": 0.0, "log_sigma": np.log(90.0), "alpha": 4.0}


@pytest.mark.parametrize("seed", [3])
def test_simulate_and_recover(seed):
    lat, inc, E = simulate.synthetic_world(seed=seed)
    spec = M.SPECS["p3_lat"]
    u = np.random.default_rng(seed).normal(0, 15, inc.shape[1])
    recs = simulate.draw_records(dict(PLANT, u=u), spec, lat, inc, E, n_per=40, seed=seed)
    P = M.prepare(recs, inc, {"all": 239}, spec, E)
    f = M.fit(P, spec)
    p = f.params
    assert f.converged
    assert abs(p["beta"] - PLANT["beta"]) < 5                         # DD per degree latitude
    for lt in (38.0, 42.0, 46.0):                                     # median target within 20 DD
        assert abs(M.median_dd(p, spec, lt) - M.median_dd(PLANT, spec, lt)) < 20
    # predicted onset / peak for a band-year land within 3 days of the planted model's own
    for y in range(inc.shape[1]):
        pp = dict(PLANT, u=np.array([]))
        o0, p0 = M.predict_band(pp, spec, inc[:, y], lat, np.ones(len(lat)) / len(lat), 239, E[0, y][None, :])
        o1, p1 = M.predict_band(f.without_year(), spec, inc[:, y], lat, np.ones(len(lat)) / len(lat), 239,
                                E[0, y][None, :])
        assert abs(o1 - o0) <= 3 + abs(u[y]) / 5 and abs(p1 - p0) <= 3 + abs(u[y]) / 5
    # the flat model (no latitude term) fits these data worse
    g = M.fit(M.prepare(recs, inc, {"all": 239}, M.SPECS["p3_flat"], E), M.SPECS["p3_flat"])
    assert g.nll > f.nll + 5


def test_recover_no_latitude_effect():
    """When there is no planted latitude effect, the fitted slope stays near zero."""
    lat, inc, E = simulate.synthetic_world(seed=5)
    spec = M.SPECS["p3_lat"]
    recs = simulate.draw_records(dict(PLANT, beta=0.0, u=np.zeros(inc.shape[1])), spec, lat, inc, E, seed=5)
    f = M.fit(M.prepare(recs, inc, {"all": 239}, spec, E), spec)
    assert abs(f.params["beta"]) < 5
