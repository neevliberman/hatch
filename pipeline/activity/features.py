"""One row per (box, day): sightings, the "people out" control, calendar terms and weather features.

Night features (moths, fireflies) read 21:00 of the day to 05:00 next morning; day features (butterflies) read the
sunny hours, 10:00-17:00. All times are local.
"""
import datetime as dt

import numpy as np
import pandas as pd

from .fetch import TAXA, inat_counts, weather
from .regions import REGIONS, YEARS

SYNODIC = 29.530588853
NEW_MOON = dt.datetime(2000, 1, 6, 18, 14)   # a known new moon, UTC


def moon_illum(date):
    """Fraction of the moon's disc lit at local midnight of `date` (about +-0.03; ignores time zone)."""
    days = (dt.datetime.combine(date, dt.time(6)) - NEW_MOON).total_seconds() / 86400   # midnight local ~ 06 UTC
    phase = (days % SYNODIC) / SYNODIC
    return (1 - np.cos(2 * np.pi * phase)) / 2


def moth_week(date):
    """National Moth Week runs the last full Sat-Sun week of July (approximated as the 7 days ending the last Sunday <= 31 Jul... close enough)."""
    last = dt.date(date.year, 7, 31)
    while last.weekday() != 6:
        last -= dt.timedelta(days=1)
    return int(last - dt.timedelta(days=8) <= date <= last)


def _hours(wx):
    t = pd.Series(pd.to_datetime(wx["time"]))
    df = pd.DataFrame({k: wx[k] for k in wx if k != "time"})
    df["t"] = t
    df["date"] = t.dt.date
    df["hour"] = t.dt.hour
    return df


def weather_features(wx):
    h = _hours(wx)
    # evening part of the night belongs to its own date, the small hours to the date before
    h["night_date"] = np.where(h.hour < 12, (h.t - pd.Timedelta(days=1)).dt.date, h.date)
    ev = h[(h.hour >= 21) | (h.hour <= 4)]
    g = ev.groupby("night_date")
    night = pd.DataFrame({
        "n_tmin": g.temperature_2m.min(), "n_tmean": g.temperature_2m.mean(),
        "n_rh": g.relative_humidity_2m.mean(), "n_dew": g.dew_point_2m.mean(),
        "n_wind": g.wind_speed_10m.mean(), "n_gust": g.wind_gusts_10m.max(),
        "n_cloud": g.cloud_cover.mean(), "n_rain": g.precipitation.sum(),
    })
    dayh = h[(h.hour >= 10) & (h.hour <= 17)].groupby("date")
    day = pd.DataFrame({
        "d_temp": dayh.temperature_2m.mean(), "d_wind": dayh.wind_speed_10m.mean(),
        "d_cloud": dayh.cloud_cover.mean(), "d_sun": dayh.shortwave_radiation.mean(),
        "d_rain": dayh.precipitation.sum(),
    })
    dusk = h[(h.hour >= 18) & (h.hour <= 22)].groupby("date")
    dusk = pd.DataFrame({"e_temp": dusk.temperature_2m.mean(), "e_wind": dusk.wind_speed_10m.mean(),
                         "e_rh": dusk.relative_humidity_2m.mean(), "e_rain": dusk.precipitation.sum()})
    out = day.join(night, how="outer").join(dusk, how="outer")
    out.index.name = "date"
    return out.reset_index()


def build(regions=None, years=None, wx_fn=None):
    import os
    regions = regions or (os.environ['ACTIVITY_REGIONS'].split(',') if os.environ.get('ACTIVITY_REGIONS') else None)
    rows = []
    for r in regions or REGIONS:
        for y in years or YEARS:
            c = {k: inat_counts(r, y, v) for k, v in TAXA.items()}
            f = weather_features((wx_fn or weather)(r, y)).set_index("date")
            for day, tot in c["all"].items():
                d = dt.date.fromisoformat(day)
                if d not in f.index:
                    continue
                lepi, bf = c["lepi"].get(day, 0), c["butterfly"].get(day, 0)
                rows.append(dict(region=r, year=y, date=d, doy=d.timetuple().tm_yday, total=tot,
                                 moth=max(lepi - bf, 0), butterfly=bf, firefly=c["firefly"].get(day, 0),
                                 weekend=int(d.weekday() >= 5), mothweek=moth_week(d), moon=moon_illum(d),
                                 **f.loc[d].to_dict()))
    df = pd.DataFrame(rows)
    return df.dropna().reset_index(drop=True)
