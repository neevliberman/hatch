"""Offline tests for the lead-time backtest's own logic (grid lookup, daily extremes, no-peeking replay, lead bins).
python3 -m pytest pipeline/live/test_leadtime.py"""
import datetime as dt
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live import leadtime as T, scorecard as S  # noqa: E402


def test_bilinear_hits_grid_points_and_interpolates():
    lat = np.arange(90, -90.5, -0.5)
    lng = np.arange(0, 360, 0.5)
    field = lat[:, None] * 10 + lng[None, :]            # linear in both, so bilinear is exact
    pts_lat, pts_lng = np.array([41.9, 38.25, 45.0]), np.array([-88.0, -90.1, -93.5])
    got = T.bilinear(field, pts_lat, pts_lng)
    assert np.allclose(got, pts_lat * 10 + pts_lng % 360)


def test_bilinear_wraps_at_the_date_line():
    field = np.zeros((361, 720))
    field[:, 719] = 1.0                                   # 359.5 E
    assert np.isclose(T.bilinear(field, [0.0], [359.75])[0], 0.5)   # halfway back to 0 E


def test_daily_extremes_groups_four_windows_per_day():
    wmax = np.array([[1, 5, 9, 3, 2, 2, 8, 2]], float)
    wmin = np.array([[0, -1, 4, 2, 1, -3, 5, 0]], float)
    tmin, tmax = T.daily_extremes(wmax, wmin, 2)
    assert tmax.tolist() == [[9, 8]] and tmin.tolist() == [[-1, -3]]


def test_without_year_drops_scores_and_sightings_only():
    rep = {"cells": ["a"], "scores": [{"year": 2023, "band": "37-39"}, {"year": 2024, "band": "37-39"}],
           "sightings": [[1, 2023, 150, 38, -89, 0], [2, 2022, 150, 38, -89, 0]]}
    out = T.without_year(rep, 2023)
    assert [s["year"] for s in out["scores"]] == [2024]
    assert [s[1] for s in out["sightings"]] == [2022]
    assert out["cells"] == ["a"] and len(rep["scores"]) == 2     # the original is untouched


def test_date_errors_lead_counts_from_issue_to_real_day():
    row = {"status": "scored", "onset": {"real": 120.4, "error": -3.0, "calendar_error": 6.0},
           "peak": {"real": 140.0, "error": 2.0, "calendar_error": -1.0}}
    got = T.date_errors(row, 2025, dt.date(2025, 4, 1))
    assert got[0] == ("onset", (S.doy_date(2025, 120) - dt.date(2025, 4, 1)).days, 3.0, 6.0)
    assert got[1][1] == 140 - 91 and got[1][2:] == (2.0, 1.0)      # 1 Apr 2025 is day 91
    assert T.date_errors({"status": "no_forecast"}, 2025, dt.date(2025, 4, 1)) == []


def test_by_lead_bins_and_skips_empty():
    errs = [(10, {"a": 2.0}, 4.0), (12, {"a": 4.0}, 6.0), (50, {"a": 9.0}, 3.0)]
    got = T.by_lead(errs, bins=((7, 14), (14, 28), (42, 63)))
    assert got == [(7, 14, 2, {"a": 3.0}, 5.0), (42, 63, 1, {"a": 9.0}, 3.0)]


def test_forecast_days_use_only_runs_out_by_the_issue_morning():
    """The 2 days between the last PRISM day and the issue day come from those days' own 00Z runs, the rest from the
    issue day's run: model output only, never real weather the issuer could not have had."""
    issue = dt.date(2026, 4, 15)
    as_of = issue - dt.timedelta(days=3)
    asked = []

    def model_day(run, n):                 # value = run date's day of month * 100 + lead day
        asked.append((run, n))
        v = np.array([[run.day * 100 + k for k in range(n)]], float)
        return v, v + 0.5
    tmin, tmax = T.forecast_days(as_of, issue, 7, model_day)
    assert asked == [(dt.date(2026, 4, 13), 1), (dt.date(2026, 4, 14), 1), (issue, 7)]
    assert tmin.tolist() == [[1300, 1400, 1500, 1501, 1502, 1503, 1504]] and np.allclose(tmax - tmin, 0.5)
    assert all(run <= issue for run, _ in asked)


def test_won_counts_the_forecast_with_the_7_day_weather():
    """'Strips where the forecast won' is the gfs column (the forecast as the live job makes it), not the first one."""
    def row(v, miss):
        return {"season": 2026, "issue": "04-01", "variant": v, "band": "37-39", "dates": [],
                "row": {"status": "scored", "miss": miss, "calendar_miss": 5.0}}
    by_issue, _ = T.summarise([row("analogs", 6.0), row("gfs", 4.0), row("perfect", 6.0)])
    assert by_issue[0]["beat_calendar"] == 1 and by_issue[0]["beat_calendar_variant"] == "gfs"
