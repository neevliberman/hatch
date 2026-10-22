"""Dates are keyed by iNat's local `observed_on` ISO date, never by UTC."""
import datetime as dt

import pandas as pd

from fit import data
from hatch_p1.prep import clean


def test_late_evening_sighting_stays_on_local_day():
    # 9:45 pm in Ohio (EDT, UTC-4) on 1 June 2021 is 01:45 on 2 June in UTC
    local = dt.datetime(2021, 6, 1, 21, 45, tzinfo=dt.timezone(dt.timedelta(hours=-4)))
    utc = local.astimezone(dt.timezone.utc)
    assert utc.date().isoformat() == "2021-06-02"
    assert data.iso_day("2021-06-01") == (2021, 152)
    assert data.iso_day(local.isoformat()) == (2021, 152)   # a full timestamp string: its local date wins
    raw = pd.DataFrame([{
        "id": 1, "observed_on": "2021-06-01", "created_at": utc.isoformat(), "lat": 40.0, "lng": -83.0,
        "accuracy_m": 10, "obscured": False, "geoprivacy": None, "quality_grade": "research",
        "captive": False, "user_id": 7, "life_stage": None}])
    c = clean(raw)
    assert c.iloc[0]["doy"] == 152 and c.iloc[0]["yday"] == 152


def test_leap_year_day_of_year():
    # 2020 is a leap year: 1 June is day 153; Daymet keeps 29 Feb, so its yday is also 153
    assert data.iso_day("2020-06-01") == (2020, 153)
    assert data.iso_day("2020-02-29") == (2020, 60)
    assert data.iso_day("2021-03-01") == (2021, 60)


def test_effort_matrix_uses_iso_dates():
    eff = pd.DataFrame({"state": ["OH", "OH"], "date": ["2020-06-01", "2021-06-01T00:00:00-04:00"], "n": [5, 9]})
    E = data.effort_matrix(eff, [2020, 2021], floor=1.0)
    oh = data.STATES.index("OH")
    assert E[oh, 0, 152] == 6 and E[oh, 1, 151] == 10
    assert E.sum() == 2 * 7 * 365 + 14
