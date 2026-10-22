"""Simulate-and-recover: weigh a known 1 kg block before trusting the scale.

Build a small synthetic Midwest (made-up temperatures by latitude, a few years, a weekly
effort rhythm), plant known parameters, draw fake sightings from the model's own
record density, then check the fitter finds the planted values again.
"""
import numpy as np
import pandas as pd

from . import model as M
from hatch_p1.degree_days import accumulate


def synthetic_world(n_hex=12, n_years=6, lat_range=(37.5, 47.5), seed=0):
    rng = np.random.default_rng(seed)
    lat = np.linspace(*lat_range, n_hex)
    day = np.arange(365)
    seasonal = -10 * np.cos(2 * np.pi * (day - 15) / 365)          # coldest mid-Jan
    tmean = (23 - 1.1 * (lat[:, None, None] - 37)) + 1.2 * seasonal[None, None, :] - 9
    tmean = tmean + rng.normal(0, 2.5, (n_hex, n_years, 1))          # warm and cold years
    tmean = tmean + rng.normal(0, 3, (n_hex, n_years, 365))          # weather
    tmin, tmax = tmean - 6, tmean + 6
    cum = accumulate(tmin, tmax, 10.0)
    inc = np.diff(cum, axis=-1, prepend=0)
    weekly = 1 + 1.5 * (day % 7 >= 5)                               # weekend effort spike
    E = np.broadcast_to(weekly * (1 + day / 120.0), (1, n_years, 365)).copy()
    return lat, inc, E


def draw_records(params, spec, lat, inc, E, n_per=40, seed=1, cut=239):
    """Fake sightings from the model's own density: flight share x effort over the window."""
    rng = np.random.default_rng(seed)
    rows = []
    days = np.arange(M.D0, cut + 1)
    for h in range(len(lat)):
        for y in range(inc.shape[1]):
            pp = dict(params)
            pp["u"] = np.array([params["u"][y]]) if len(params.get("u", [])) else np.array([])
            doy = np.arange(1, 366)
            dayl = M.daylength_hours(np.array([[lat[h]]]), doy[None, :]) / 12.0
            a = M.flight(pp, spec, inc[h:h + 1, y], dayl, np.array([lat[h]]), np.array([0]))[0]
            p = a[days] * E[0, y, days]
            p = (1 - M.EPS) * p / p.sum() + M.EPS * E[0, y, days] / E[0, y, days].sum()
            for t in rng.choice(days, n_per, p=p / p.sum()):
                rows.append((h, y, int(t), lat[h], 0, int(rng.integers(0, 10**6))))
    r = pd.DataFrame(rows, columns=["h", "y", "t", "hex_lat", "s", "user_id"])
    r["band"] = "all"
    r["year"] = r.y + 2015
    r["doy"] = r.t + 1
    return r
