"""Offline checks of the interval-calibration helpers (pipeline/fit/calibration.py)."""
import json

from fit import calibration as C


def test_clopper_pearson_edges():
    assert C.cp(0, 10)[0] == 0.0 and C.cp(10, 10)[1] == 1.0
    lo, hi = C.cp(25, 31)
    assert lo < 25 / 31 < hi and 0.6 < lo < 0.7 and 0.88 < hi < 0.95


def test_honest_window_never_sees_its_own_year():
    # year 2020's miss is huge; sized from other years only, its window cannot stretch to cover it
    scores = [{"year": y, "obs_peak": 100 + d, "heat_peak": 100, "obs_onset": 90, "heat_onset": 90}
              for y, d in [(2015, -2), (2016, -1), (2017, 0), (2018, 1), (2019, 2), (2020, 30)]]
    import pandas as pd
    hits, _ = C.honest_hits(pd.DataFrame(scores), "peak")
    assert hits[-1] is False


def test_shipped_files_carry_the_check():
    for path in C.REPLAYS.values():
        d = json.loads(path.read_text())
        assert d["interval"]["checked"]["peak"][:2] == C.checked(d["scores"])["peak"][:2]
        assert d["interval"]["checked"]["peak"][1] == len(d["scores"])
