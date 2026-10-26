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


def test_load_envelopes_refuses_other_folds(tmp_path):
    import json
    p = tmp_path / "env.json"
    p.write_text(json.dumps({"folds": ["2015", "2016"], "envelopes": [ENV.tolist(), ENV.tolist()]}))
    assert S.load_envelopes(p, ["2015", "2016"]).shape == (2, 365)
    with pytest.raises(ValueError, match="folds"):
        S.load_envelopes(p, ["2015", "2017"])
    fits = tmp_path / "fits.json"
    fits.write_text("{}")
    with pytest.raises(ValueError, match="another fits.json"):
        S.load_envelopes(p, ["2015", "2016"], fits)
    import hashlib
    p.write_text(json.dumps({"folds": ["2015", "2016"], "envelopes": [ENV.tolist(), ENV.tolist()],
                             "fits_sha256": hashlib.sha256(b"{}").hexdigest()}))
    assert S.load_envelopes(p, ["2015", "2016"], fits).shape == (2, 365)


def test_live_flags_use_only_known_weather_and_the_widest_envelope():
    envs = np.array([ENV, np.minimum(ENV + 5, 205.0)])     # the widest is ENV + 5 (capped at 205)
    known = np.zeros((2, 120))                             # 120 known days (index 0..119)
    known[0, 100] = 204.0                                  # one hex: 204 banked from index 100 (< 205 there)
    known[1, 100] = 210.0                                  # the other: past the widest envelope
    w = np.array([[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]])
    assert S.live_flags(known, envs, w, [150, 150, 150]) == [False, True, False]
    assert S.live_flags(known, envs, w, [100, 100, None]) == [False, False, False]   # peak before the bank jumps
    assert S.live_flags(known, envs, np.array([[0.0, 1.0]]), [float("inf")]) == [True]  # "never": all known days
