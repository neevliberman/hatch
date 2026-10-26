"""Offline tests for the warmth-trend maths. python3 -m pytest pipeline/drift"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_warmth as W  # noqa: E402


def test_trend_recovers_a_known_slope():
    days = {y: 150 - 0.2 * (y - 1980) for y in range(1980, 2025)}   # 2 days earlier per decade, no noise
    per_decade, se = W.trend(days)
    assert abs(per_decade - 2.0) < 1e-6 and se < 1e-6


def test_trend_skips_years_that_never_reach_the_milestone():
    days = {y: 150 - 0.2 * (y - 1980) for y in range(1980, 2025)}
    days[2001] = None
    assert abs(W.trend(days)[0] - 2.0) < 1e-6


def _year(year, tmin, tmax):
    n = 366 if year % 4 == 0 else 365
    n = 365  # Daymet drops 31 Dec in leap years
    return pd.DataFrame({"year": year, "yday": np.arange(1, n + 1), "tmin": tmin, "tmax": tmax})


def test_leap_and_ordinary_years_land_on_the_same_calendar_day():
    # Constant weather from 1 March (warm, 20 C mean): the same calendar day in a leap year and an ordinary one.
    def warm(year):
        df = _year(year, 10.0, 30.0)
        df.loc[df["yday"] < (61 if year % 4 == 0 else 60), ["tmin", "tmax"]] = -10.0   # nothing before 1 March
        return df
    days = W.milestone_days(pd.concat([warm(2023), warm(2024)]))
    assert days[2023] == days[2024]
