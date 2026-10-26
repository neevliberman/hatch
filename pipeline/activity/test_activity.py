import datetime as dt

import numpy as np
import pandas as pd

from .features import moon_illum, moth_week, weather_features
from .live import night_classes
from .terms import add_terms, lift_from


def test_moon_known_phases():
    assert moon_illum(dt.date(2024, 7, 5)) < 0.05    # new moon 5 Jul 2024
    assert moon_illum(dt.date(2024, 6, 22)) > 0.95   # full moon 22 Jun 2024


def test_moth_week_is_late_july():
    assert moth_week(dt.date(2024, 7, 24)) == 1
    assert moth_week(dt.date(2024, 6, 1)) == 0


def _hourly(days, tmin, rain=0.0):
    t = pd.date_range("2024-07-01", periods=24 * days, freq="h")
    n = len(t)
    hod = t.hour.values
    temp = tmin + 6 * np.sin(np.pi * ((hod - 6) % 24) / 24)   # coolest near 06:00
    return {"time": [x.isoformat() for x in t], "temperature_2m": list(temp), "relative_humidity_2m": [70] * n,
            "dew_point_2m": [12] * n, "wind_speed_10m": [2.0] * n, "wind_gusts_10m": [4.0] * n, "cloud_cover": [40] * n,
            "precipitation": [rain] * n, "shortwave_radiation": [300] * n}


def test_night_belongs_to_the_evening_it_starts():
    f = weather_features(_hourly(3, 15)).set_index("date")
    assert dt.date(2024, 7, 1) in f.index and f.loc[dt.date(2024, 7, 1), "n_tmin"] < 22


def test_warm_night_beats_cold_night():
    cold = add_terms(pd.DataFrame([dict(n_tmin=6, n_rh=70, n_wind=2, n_rain=0, e_rain=0, n_cloud=40, moon=0.5,
                                        d_temp=20, d_sun=300, d_wind=3, d_rain=0)]))
    warm = cold.assign(n_tmin=18)
    warm = add_terms(warm.drop(columns=[c for c in warm.columns if c in ("tmin", "tmin2", "rh", "wind", "rain", "cloud", "moon_cloud", "temp", "temp2", "sun", "wind_d", "rain_d")]))
    coef = {"tmin": 0.33, "tmin2": -0.05}
    assert lift_from(coef, warm)[0] > lift_from(coef, cold)[0]


def test_night_classes_follow_the_cut_offs():
    static = {"coef": {"tmin": 0.33, "tmin2": -0.05}, "window": [121, 288],
              "cuts": {"chicago": {str(dt.date(2024, 7, 2).timetuple().tm_yday // 7): [1.0, 1.4]}}}
    wx = {"hourly": _hourly(4, 15)}
    out = night_classes(wx, "chicago", static, dt.date(2024, 7, 2))
    assert len(out) == 2 and all(c in (0, 1, 2, None) for c in out)
    static["cuts"]["chicago"] = {k: [0.0, 0.5] for k in static["cuts"]["chicago"]}
    assert night_classes(wx, "chicago", static, dt.date(2024, 7, 2))[0] == 2


def test_a_missing_night_is_none_not_a_shift():
    static = {"coef": {"tmin": 0.33, "tmin2": -0.05}, "window": [121, 288], "cuts": {"chicago": {
        str(dt.date(2024, 7, 2).timetuple().tm_yday // 7): [0.0, 0.5], str(dt.date(2024, 7, 3).timetuple().tm_yday // 7): [0.0, 0.5]}}}
    hourly = _hourly(4, 15)
    hourly["temperature_2m"][24 + 23] = None   # a missing evening hour on 2 Jul
    out = night_classes({"hourly": hourly}, "chicago", static, dt.date(2024, 7, 2))
    assert len(out) == 2 and out[0] is None and out[1] in (0, 1, 2)
