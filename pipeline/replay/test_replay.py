"""Tests for build_replay. Run: python3 -m pytest pipeline/replay"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_replay as b  # noqa: E402

OUT = b.OUT


def test_doy_convention_tiny_series():
    # 100 training sightings at 1..100 degree-days; day index i has i degree-days (calendar day i + 1)
    train = np.arange(1, 101)
    dd = np.arange(365, dtype=float)
    q = b.cell_forecast(dd, train)
    # share(i) = i/100, so q05 is first reached at index 5 = calendar day 6
    assert q == [6, 26, 51, 76, 96]


def test_first_reach_never_and_day_300_limit():
    train = np.arange(1, 101)
    assert b.cell_forecast(np.zeros(365), train) == [None] * 5
    dd = np.zeros(365)
    dd[299:] = 1000.0          # share jumps on index 299 = calendar day 300: allowed
    assert b.cell_forecast(dd, train) == [300] * 5
    dd = np.zeros(365)
    dd[300:] = 1000.0          # index 300 = day 301: too late
    assert b.cell_forecast(dd, train) == [None] * 5


def test_monotone_quantiles():
    rng = np.random.default_rng(1)
    train = rng.gamma(4, 60, 500)
    dd = np.cumsum(rng.uniform(0, 8, 365))
    q = b.cell_forecast(dd, train)
    v = [x for x in q if x is not None]
    assert v == sorted(v)


def test_typical_median_and_nulls():
    yrs = [[10, 20, 30, 40, None]] * 3 + [[12, 22, 32, 42, None]] * 2 + [[None] * 5] * 6
    assert b.typical(yrs) == [None] * 5               # only 5 of 11 non-null: fewer than half
    yrs = [[10, 20, 30, 40, 50], [12, 22, 32, 42, 52]] * 3 + [[None] * 5] * 5
    assert b.typical(yrs)[0] == 11
    yrs = [[10, 20, 30, 40, 50]] * 6 + [[None] * 5] * 5
    assert b.typical(yrs) == [10, 20, 30, 40, 50]


def test_flags_bits():
    cutoffs = [180, None, 176, 190, None]
    lat = np.array([36.0, 38.0, 40.0, 49.5, 46.0, 46.0])
    doy = np.array([200, 170, 250, 200, 235, 241])
    band = b.band_index(lat)
    assert band.tolist() == [0, 0, 1, 4, 4, 4]          # clamped at both ends
    approx = np.array([False, True, False, False, False, True])
    f = b.flags_for(doy, band, cutoffs, approx)
    # lat 36 doy 200 > 180 -> 1 ; lat 38 doy 170 approx -> 2 ; band1 no cutoff, 250>240 -> 1
    # band4 no cutoff: 200 -> 0 ; 235 -> 0 ; 241 approx -> 3
    assert f.tolist() == [1, 2, 1, 0, 0, 3]


def test_core_cells_sorted_unique():
    cells = b.core_cells()
    assert cells == sorted(set(cells)) and len(cells) > 100


@pytest.mark.skipif(not OUT.exists(), reason="output not built")
def test_output_schema():
    d = json.loads(OUT.read_text())
    # P2 keys, in order, then the optional P3 additions (backwards compatible)
    assert list(d) == ["version", "generated", "species", "years", "quantiles", "cells", "seen",
                       "forecast", "bands", "scores", "sightings", "counts", "licences",
                       "model", "interval", "scorecard"]
    assert d["version"] == 1 and d["model"]["id"].startswith("p3")
    lo, hi = d["interval"]["peak"]
    assert d["interval"]["level"] == 0.8 and lo < 0 < hi
    assert [x["band"] for x in d["scorecard"]] == ["37-39", "39-41", "41-43", "43-45", "45-49"]
    n = len(d["cells"])
    assert d["years"] == list(range(2015, 2026)) and d["quantiles"] == [0.05, 0.25, 0.5, 0.75, 0.95]
    assert len(d["seen"]) == n and set(d["seen"]) <= {0, 1}
    assert list(d["forecast"]) == [str(y) for y in d["years"]] + ["typical"]
    for rows in d["forecast"].values():
        assert len(rows) == n
        for r in rows:
            assert len(r) == 5
            v = [x for x in r if x is not None]
            assert v == sorted(v) and all(1 <= x <= 300 for x in v)
    assert [x["label"] for x in d["bands"]] == ["37-39", "39-41", "41-43", "43-45", "45-49"]
    assert set(d["scores"][0]) == {"band", "year", "n", "obs_onset", "obs_peak",
                                   "heat_onset", "heat_peak", "cal_onset", "cal_peak", "p1_onset", "p1_peak"}
    s = d["sightings"]
    assert all(len(x) == 6 and 0 <= x[5] <= 3 and 60 <= x[2] <= 300 for x in s)
    assert [(x[1], x[2]) for x in s] == sorted((x[1], x[2]) for x in s)
    c = d["counts"]
    assert c["sightings"] == len(s) == c["first_brood"] + c["second_brood"]
    assert c["cells"] == n and c["seen_cells"] == sum(d["seen"])
    assert set(d["licences"]) == {"cc0", "cc-by", "cc-by-nc"} and sum(d["licences"].values()) == len(s)
    assert "licence_dropped" in c
