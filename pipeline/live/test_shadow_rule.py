import numpy as np
import pytest

from live import shadow_rule as S

ENV = np.minimum((np.arange(365) + 1) * 2.0, 200.0)   # grows 2/day, tops out at 200


def test_cap_is_min_of_running_total_and_envelope():
    inc = np.full((2, 365), 1.0)
    inc[1] = 3.0
    out = S.cap_inc(inc, ENV)
    assert np.allclose(np.cumsum(out, -1), np.minimum(np.cumsum(inc, -1), ENV))
    assert (out >= -1e-12).all()


def test_cap_does_nothing_inside_the_range():
    inc = np.full((1, 365), 0.5)
    assert np.allclose(S.cap_inc(inc, ENV), inc)


def test_flag_only_from_1_april_to_peak_and_strictly_above():
    env = np.cumsum(np.full(365, 2.0))
    inc = np.zeros((3, 365))
    inc[0] = 2.5                                        # above E after 1 April
    inc[1] = 1.9                                        # below E every day
    inc[2] = 2.0                                        # exactly E: not flagged
    assert S.flagged(inc, env, 120).tolist() == [True, False, False]
    assert not S.flagged(inc, env, 90).any()            # window empty: peak on or before 1 April
    march = np.zeros((1, 365))
    march[0, :30] = 50.0                                # rich in March only, flat after: bank 1500 > E later too
    assert S.flagged(march, env, 120)[0]
    assert not S.flagged(march, np.full(365, 2000.0), 120)[0]


def test_envelope_is_max_over_place_years():
    cum = np.zeros((2, 2, 365))
    cum[0, 0] = 1.0
    cum[1, 1] = np.arange(365)
    e = S.envelope(cum, [(0, 0), (1, 1), (1, 1)])
    assert np.allclose(e, np.maximum(1.0, np.arange(365)))


def test_check_envelope_rejects_bad_input():
    S.check_envelope(ENV)
    for bad in (ENV[:364], np.r_[ENV[:-1], np.nan], ENV[::-1]):
        with pytest.raises(ValueError):
            S.check_envelope(bad)


def test_widen_reaches_calendar_and_never_moves_inside():
    assert S.widen(114, 124, 135, True) == (114, 135)        # 2026 south peak
    assert S.widen(96.9, 108, 118.4, True) == (96.9, 118.4)  # 2026 middle strip onset
    assert S.widen(110, 120, 115, True) == (110, 120)        # calendar already inside
    assert S.widen(110, 120, 100, True) == (100, 120)
    assert S.widen(114, 124, 135, False) == (114, 124)


def test_strip_flag_any_weighted_hex():
    assert S.strip_flag([False, True, False], [1, 2, 3])
    assert not S.strip_flag([False, True], [1, 0])
