"""Small tests for the south-bias candidates (no network). Run: python3 -m pytest notebooks/southbias"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for p in (ROOT / "notebooks", ROOT / "pipeline", HERE):
    sys.path.insert(0, str(p))

from fit import model as M, simulate  # noqa: E402
import sb  # noqa: E402

P = {"mu0": 120.0, "beta": 0.0, "gamma": 0.7, "log_sigma": np.log(150.0), "alpha": 8.0, "u": np.array([])}


def _inc(level=8.0):
    inc = np.zeros((2, 365))
    inc[:, 59:] = level
    inc[1, 59:] *= 1.5
    return inc


def test_envelope_is_max_over_place_years():
    cum = np.cumsum(np.random.default_rng(0).uniform(0, 5, (3, 2, 365)), -1)
    env = sb.envelope(cum, np.array([0, 2, 2]), np.array([1, 0, 0]))
    assert np.allclose(env, np.maximum(cum[0, 1], cum[2, 0]))


def test_cap_never_exceeds_envelope_and_keeps_what_is_inside():
    inc = _inc()
    env = np.cumsum(np.full(365, 9.0))
    c = np.cumsum(sb.cap_inc(inc, env), -1)
    assert np.all(c <= env + 1e-9)
    assert np.allclose(c[0], np.cumsum(inc[0]))            # row 0 is always under the envelope: untouched
    assert np.allclose(c[1], np.minimum(np.cumsum(inc[1]), env))
    assert np.all(sb.cap_inc(inc, env) >= -1e-12)          # min of two rising curves still rises


def test_cap_delays_the_forecast_only_when_outside():
    inc = _inc()
    huge = np.full(365, 1e9)
    lat = np.array([38.0, 38.0])
    a0 = sb.Cand("p3", P).flight(inc, lat)
    assert np.allclose(sb.Cand("cap", P, env=huge).flight(inc, lat), a0)
    env = np.cumsum(np.r_[np.zeros(59), np.full(306, 9.0)])
    peak = lambda a: sb.predict_band(a[1:], [1.0], 239)[1]  # noqa: E731
    assert peak(sb.Cand("cap", P, env=env).flight(inc, lat)) > peak(a0)


def test_flag_window_and_blend_weight():
    inc = _inc()
    env = np.cumsum(np.r_[np.zeros(59), np.full(306, 10.0)])
    f = sb.flagged(inc, env, t_end=120)
    assert f.tolist() == [False, True]
    assert not sb.flagged(inc, env, t_end=80).any()        # window starts 1 April (day index 90)
    assert np.isclose(sb.blend_weight(f, [3.0, 1.0]), 0.5 * 0.25)
    assert sb.blend(100.0, 130.0, 0.5) == 115.0


def test_gate_off_is_p3_and_gate_starts_near_the_equinox():
    inc, lat = _inc(), np.array([38.0, 46.0])
    assert np.allclose(sb.Cand("gate", P, gate=None).flight(inc, lat), sb.Cand("p3", P).flight(inc, lat))
    g = sb.gate_mask(lat, np.arange(1, 366), 12.0)
    first = g.argmax(1) + 1
    assert all(70 <= d <= 82 for d in first)               # 12 h days arrive a few days before the March equinox
    g14 = sb.gate_mask(lat, np.arange(1, 366), 14.0).argmax(1) + 1
    assert g14[0] > g14[1]                                  # long days come later in the south: the gate delays it more


def test_mixture_reduces_to_p3_and_date_clock_integrates_to_life():
    inc, lat = _inc(), np.array([38.0, 44.0])
    q = dict(P, pi=1.0, m0=140.0, b=3.0, log_s=np.log(10.0))
    assert np.allclose(sb.Cand("mix", q).flight(inc, lat), sb.Cand("p3", P).flight(inc, lat))
    a = sb.date_flight(q, lat, np.arange(365))
    assert np.allclose(a.sum(1), M.LIFE, atol=1e-6)
    assert np.argmax(a[1]) - np.argmax(a[0]) == 18         # 6 degrees north x 3 days per degree


def test_mixture_recovers_a_planted_share():
    lat, inc, E = simulate.synthetic_world(n_hex=6, n_years=4, seed=2)
    plant = dict(P, gamma=0.0, pi=0.6, m0=150.0, b=2.0, log_s=np.log(8.0))
    rng = np.random.default_rng(5)
    rows, days = [], np.arange(M.D0, 240)
    for h in range(len(lat)):
        for y in range(inc.shape[1]):
            a = sb.Cand("mix", plant).flight(inc[h:h + 1, y], lat[h:h + 1])[0]
            p = a[days] * E[0, y, days]
            for t in rng.choice(days, 80, p=p / p.sum()):
                rows.append((h, y, int(t), lat[h], 0, int(rng.integers(0, 10**6))))
    r = pd.DataFrame(rows, columns=["h", "y", "t", "hex_lat", "s", "user_id"]).assign(band="all")
    Pp = M.prepare(r, inc, {"all": 239}, sb.P3, E)
    f = sb.fit_mix(Pp, {k: v for k, v in plant.items() if k in ("mu0", "gamma", "log_sigma", "alpha")}, pis=(0.8,))
    assert abs(f["params"]["pi"] - 0.6) < 0.15
    assert abs(f["params"]["m0"] - 150.0) < 5
