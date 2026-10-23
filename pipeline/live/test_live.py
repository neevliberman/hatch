"""Offline tests for the live pipeline's pure helpers: python3 -m pytest pipeline/live"""
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live import build_live as L  # noqa: E402

HERE = Path(__file__).resolve().parent


def test_day_index_matches_daymet_convention():
    assert L.day_index(dt.date(2027, 3, 1)) == 59          # model window starts at index 59 (fit.model.D0)
    assert L.day_index(dt.date(2028, 2, 29)) == 59         # leap year: 29 Feb takes index 59, as in Daymet
    assert L.day_index(dt.date(2027, 1, 1)) == 0


def test_first_reach_is_one_based_and_caps():
    cdf = np.linspace(0, 1, 365)
    got = L.first_reach(cdf, [0.5], max_doy=365)
    assert got == [int(np.searchsorted(cdf, 0.5)) + 1]
    assert L.first_reach(np.zeros(365), [0.5]) == [None]
    assert L.first_reach(cdf, [0.99], max_doy=100) == [None]


def test_fill_gaps_interpolates_and_keeps_empty_rows():
    x = np.array([[1, np.nan, 3, np.nan], [np.nan] * 4])
    y = L.fill_gaps(x)
    assert y[0].tolist() == [1, 2, 3, 3]
    assert np.isnan(y[1]).all()


def test_ensemble_summary_median_and_honest_range():
    days = np.array([[[150, 160]], [[152, 162]], [[154, np.inf]]], float)  # 3 members, 1 cell, 2 quantiles
    med, lo, hi = L.ensemble_summary(days, [0.0])
    assert med == [[152, 162]]
    assert lo[0][0] <= 152 <= hi[0][0]
    # a date fixed by real weather (every member agrees) still gets the model's past error as its range
    fixed = np.full((4, 1, 1), 170.0)
    med, lo, hi = L.ensemble_summary(fixed, [-6, -2, 0, 3, 5])
    assert med == [[170]] and lo[0][0] < 170 < hi[0][0]
    # "never" for most members -> null, and no range around it
    never = np.array([[[np.inf]], [[np.inf]], [[200]]], float)
    med, lo, hi = L.ensemble_summary(never, [0.0])
    assert med == [[None]] and lo == [[None]] and hi == [[None]]


def test_season_window():
    assert not L.in_season(dt.date(2027, 3, 1), 2027)      # nothing observed yet on 1 March
    assert L.in_season(dt.date(2027, 3, 2), 2027)
    assert L.in_season(dt.date(2027, 10, 7), 2027)
    assert not L.in_season(dt.date(2027, 10, 8), 2027)


def test_static_inputs_match_the_replay_cells():
    cells = json.loads(L.REPLAY.read_text())["cells"]
    off = json.loads((HERE / "prism_offsets.json").read_text())
    assert off["cells"] == cells
    a = np.array(off["offsets"])
    assert a.shape == (len(cells), 12, 2) and np.abs(a).max() < 6
    eff = json.loads((HERE / "effort_profile.json").read_text())
    prof = np.array(eff["profile"])
    assert prof.shape == (7, 365) and (prof > 0).all()
