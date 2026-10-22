"""Simulate-and-recover: weigh a known 1 kg block before trusting the scale.

Make fake luna sightings from a threshold we choose, using the real
temperatures, the real places and counts, and the real day-to-day moth
effort; then ask the fitter to find the threshold again.
"""
import numpy as np
import pandas as pd
from scipy.stats import norm

from . import model


def effort_matrix(effort, years):
    """effort[y, t]: Midwest moth records per day, on Daymet's 365-day calendar."""
    e = np.zeros((len(years), 365))
    d = effort.copy()
    d["year"] = d.date.dt.year
    d = d[d.year.isin(years)]
    doy = d.date.dt.dayofyear  # Daymet yday = calendar doy (it drops 31 Dec, not 29 Feb)
    ok = doy <= 365
    e[(d.year[ok] - years[0]).to_numpy(), (doy[ok] - 1).to_numpy()] = d.n[ok].to_numpy()
    return e + 1  # a floor so no day is impossible


def fake_records(rec, dd, eff, mu, sigma, rng, last_day=239):
    """Each hex-year's sightings fall on day t with probability equal to the share
    of moths whose degree-day target is crossed that day (the fitter's own model),
    times that day's effort (pass eff=None for no effort)."""
    rows = []
    for (h, y, band), n in rec.groupby(["h", "y", "band"]).size().items():
        cdf = norm.cdf((dd[h, y, : last_day + 1] - mu) / sigma)
        p = np.clip(np.diff(cdf, prepend=cdf[0]), 0, None)  # clip float noise
        if eff is not None:
            p = p * eff[y, : last_day + 1]
        if p.sum() <= 0:
            raise ValueError(f"hex {h}, year {y}: no day has any chance of a sighting")
        p /= p.sum()
        for t in rng.choice(last_day + 1, n, p=p):
            rows.append((h, y, band, t))
    f = pd.DataFrame(rows, columns=["h", "y", "band", "t"])
    f["year"] = f.y + 2015
    return f


def recover(rec, cubes, years, eff, true_bases=(8.0, 10.0, 12.0), reps=20, seed=0):
    """eff=None: the fitter's model is exactly true. eff=matrix: adds real weekly/seasonal effort."""
    rng = np.random.default_rng(seed)
    out = []
    for tb in true_bases:
        mu, sigma = model.fit_heat(rec, cubes[tb])
        for i in range(reps):
            f = fake_records(rec, cubes[tb], eff, mu, sigma, rng)
            tg = model.targets(f)
            got = model.learn_base(f, tg, cubes, years, list(years))
            out.append({"true_base": tb, "rep": i, "recovered": got, "mu": mu, "sigma": sigma})
    return pd.DataFrame(out)
