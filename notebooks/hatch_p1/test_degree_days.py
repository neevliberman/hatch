import numpy as np
from hatch_p1.degree_days import single_sine, double_sine


def brute(tmin, tmax, base, upper, n=200_000):
    phase = np.linspace(-np.pi / 2, np.pi / 2, n)
    t = (tmax + tmin) / 2 + (tmax - tmin) / 2 * np.sin(phase)
    return np.mean(np.clip(t, base, upper) - base)


def test_matches_brute_force_integral():
    rng = np.random.default_rng(0)
    for _ in range(300):
        a, b = sorted(rng.uniform(-10, 40, 2))
        base = rng.uniform(0, 15)
        assert abs(single_sine(a, b, base, 30.0) - brute(a, b, base, 30.0)) < 1e-3


def test_edge_cases():
    assert single_sine(0.0, 5.0, 10) == 0                      # never warm enough
    assert np.isclose(single_sine(12.0, 20.0, 10), 6.0)        # fully between: mean - base
    assert np.isclose(single_sine(31.0, 35.0, 10), 20.0)       # fully above cutoff: capped
    assert np.isclose(single_sine(15.0, 15.0, 10), 5.0)        # flat day


def test_double_sine_equals_single_when_tmin_constant():
    tmin, tmax = np.full(10, 8.0), np.full(10, 24.0)
    assert np.allclose(double_sine(tmin, tmax, 10), single_sine(8.0, 24.0, 10))
