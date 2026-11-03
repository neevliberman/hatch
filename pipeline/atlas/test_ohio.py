"""No-network checks for the Ohio butterfly trend fit (ohio_trends.py, PREREG_OHIO.md): a synthetic series with a
known slope, the profiled site effects against a full dummy-variable Poisson fit, the bootstrap interval, the
thresholds and the name matching."""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline.atlas import ohio_trends as O

ROOT = Path(__file__).resolve().parents[2]


def synthetic(slope, sites=30, years=21, seed=1, noise=0.0):
    rng = np.random.default_rng(seed)
    site = np.repeat(np.arange(sites), years)
    year = np.tile(np.arange(1996, 1996 + years), sites)
    minutes = rng.uniform(300, 2000, sites * years)
    shock = rng.normal(0, noise, years)[year - 1996] if noise else 0
    mu = np.exp(rng.normal(-3, 1, sites)[site] + slope * (year - 2006) + shock) * minutes
    return pd.DataFrame({"SiteID": site.astype(str), "Year": year, "minutes": minutes,
                         "Index": rng.poisson(mu).astype(float), "YearTotal": rng.poisson(mu)})


def full_glm(site, x, y, off, iters=100):
    """Poisson IRLS with one dummy per site: the slow reference the profiled fit must equal."""
    _, g = np.unique(site, return_inverse=True)
    X = np.c_[np.eye(g.max() + 1)[g], x - x.mean()]
    b = np.r_[np.log(np.bincount(g, y) / np.bincount(g, np.exp(off)) + 1e-12), 0.0]
    for _ in range(iters):
        mu = np.exp(X @ b + off)
        b_new = b + np.linalg.solve(X.T @ (mu[:, None] * X), X.T @ (y - mu))
        if np.max(np.abs(b_new - b)) < 1e-12:
            break
        b = b_new
    return b[-1]


def test_known_slope_is_recovered_and_matches_the_full_glm():
    d = synthetic(np.log1p(-0.03))  # -3%/yr
    beta, info = O.fit(d.SiteID, d.Year, d.Index, np.log(d.minutes))
    assert abs(100 * np.expm1(beta) + 3) < 0.3 and info > 0
    assert abs(beta - full_glm(d.SiteID.to_numpy(), d.Year.to_numpy(float), d.Index.to_numpy(), np.log(d.minutes.to_numpy())))\
        < 1e-8
    # Doubling everyone's effort changes nothing; a site that never saw it carries no information.
    assert abs(O.fit(d.SiteID, d.Year, d.Index, np.log(2 * d.minutes))[0] - beta) < 1e-10
    extra = pd.DataFrame({"SiteID": "zero", "Year": range(1996, 2017), "minutes": 900.0, "Index": 0.0})
    e = pd.concat([d, extra])
    assert abs(O.fit(e.SiteID, e.Year, e.Index, np.log(e.minutes))[0] - beta) < 1e-10


def test_unidentified_fits_are_missing():
    d = synthetic(0.0)
    one_year = d[d.Year == 2000]
    assert np.isnan(O.fit(one_year.SiteID, one_year.Year, one_year.Index, np.log(one_year.minutes))[0])
    assert np.isnan(O.fit(d.SiteID, d.Year, 0 * d.Index, np.log(d.minutes))[0])


def test_bootstrap_interval_and_verdict():
    down = O.trend(synthetic(np.log1p(-0.05), noise=0.1), n_boot=200)
    assert down["lo"] < -5 < down["hi"] and down["hi"] < 0
    assert O.verdict(down["lo"], down["hi"]) == "declining"
    flat = O.trend(synthetic(0.0, noise=0.1, seed=3), n_boot=200)
    assert flat["lo"] < 0 < flat["hi"] and O.verdict(flat["lo"], flat["hi"]) == "no clear trend"
    assert O.verdict(0.5, 3) == "increasing"
    # Shared year shocks widen the interval: the two-way bootstrap sees them, the site-only view would not.
    calm = O.trend(synthetic(np.log1p(-0.05), seed=4), n_boot=200)
    rough = O.trend(synthetic(np.log1p(-0.05), seed=4, noise=0.3), n_boot=200)
    assert rough["hi"] - rough["lo"] > 2 * (calm["hi"] - calm["lo"])


def test_thresholds():
    base = {"n_sites": 10, "n_years": 10, "lo": -3.0, "hi": -1.0, "dropped": 0.0}
    assert O.shown(base)
    assert not O.shown(base | {"n_sites": 9}) and not O.shown(base | {"n_years": 9})
    assert not O.shown(base | {"dropped": 0.06}) and not O.shown(base | {"lo": np.nan})
    few = synthetic(-0.03, sites=8, years=21)
    r = O.trend(few, n_boot=0)
    assert r["n_sites"] == 8 and not O.shown(r | {"lo": -1, "hi": 1, "dropped": 0})


def test_names_match_renames_and_skip_complexes():
    atlas = {s["name"] for s in json.loads((ROOT / "public/atlas/species.json").read_text())}
    names = pd.DataFrame({"CommonName": ["Red-spotted Purple", "White Admiral", "Azures", "Monarch", "Sachem"],
                          "Latin": ["Limenitis arthemis", "Limenitis arthemis", "Celastrina ladon",
                                    "Danaus plexippus", "Atalopedes campestris"]})
    assert O.atlas_names(names, atlas) == {"Red-spotted Purple": "Limenitis astyanax",
                                           "White Admiral": "Limenitis arthemis", "Monarch": "Danaus plexippus"}
    assert set(O.SYNONYMS.values()) <= atlas
