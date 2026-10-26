"""Tonight's moth activity, for the nightly live file: for each anchor and each of the next 4 nights, 0 slow,
1 typical, 2 busy, against that place's own nights in the same week of 2017-2025.

The forecast is Open-Meteo's hourly forecast; the model and cut-offs come from moth_static.json. Never raises
into the caller: build_live treats a missing block as "no activity line on the map".
"""
import datetime as dt
import json
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from .anchors import ANCHORS, nearest_region
from .fetch import HOURLY
from .features import moon_illum, weather_features
from .terms import add_terms, lift_from

STATIC = Path(__file__).parent / "moth_static.json"
NIGHTS = 4


def fetch_forecast():
    names = list(ANCHORS)
    q = dict(latitude=",".join(str(ANCHORS[n][0]) for n in names), longitude=",".join(str(ANCHORS[n][1]) for n in names),
             hourly=HOURLY, timezone="auto", wind_speed_unit="ms", forecast_days=NIGHTS + 1)
    req = urllib.request.Request("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q),
                                 headers={"User-Agent": "hatch-live/0.1 (github.com/neevliberman/hatch)"})
    with urllib.request.urlopen(req, timeout=90) as r:
        out = json.load(r)
    return dict(zip(names, out if isinstance(out, list) else [out]))


def night_classes(wx, region, static, today):
    """Classes for `today` and the nights after it, from one place's hourly forecast."""
    import pandas as pd
    f = weather_features(wx["hourly"])
    f = f[f.date.apply(lambda d: d >= today)].head(NIGHTS)
    rows = []
    for _, r in f.iterrows():
        d = r.date
        row = r.to_dict()
        row.update(moon=moon_illum(d), total=1)
        rows.append(row)
    df = pd.DataFrame(rows)
    if df.empty:
        return []
    df = add_terms(df.dropna(subset=["n_tmin", "n_rh", "n_wind", "n_cloud", "n_rain", "e_rain"]))
    out = []
    for (_, r), lift in zip(df.iterrows(), lift_from(static["coef"], df)):
        doy = r.date.timetuple().tm_yday
        lo, hi = static["window"]
        cut = static["cuts"][region].get(str(doy // 7))
        out.append(None if not cut or not lo <= doy <= hi else int(lift > cut[0]) + int(lift > cut[1]))
    return out


def build(today=None, forecast=None):
    static = json.loads(STATIC.read_text())
    today = today or dt.datetime.now(dt.timezone.utc).date()
    forecast = forecast or fetch_forecast()
    rows = []
    for name, wx in forecast.items():
        lat, lng = ANCHORS[name]
        cls = night_classes(wx, nearest_region(lat, lng, static["cuts"]), static, today)
        if cls:
            rows.append([lat, lng] + cls + [None] * (NIGHTS - len(cls)))
    return {"asof": today.isoformat(), "nights": [(today + dt.timedelta(days=i)).isoformat() for i in range(NIGHTS)],
            "moth": rows}
