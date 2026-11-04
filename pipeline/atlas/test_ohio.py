"""No-network checks for the Ohio butterfly trend fit (ohio_trends.py, PREREG_OHIO.md): a synthetic series with a
known slope, the profiled site effects against a full dummy-variable Poisson fit, the bootstrap interval, the
thresholds and the name matching."""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline.atlas import ohio_trends as O
from pipeline.atlas.config import records_name

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
    atlas = {records_name(s) for s in json.loads((ROOT / "public/atlas/species.json").read_text())}
    names = pd.DataFrame({"CommonName": ["Red-spotted Purple", "White Admiral", "Azures", "Monarch", "Sachem"],
                          "Latin": ["Limenitis arthemis", "Limenitis arthemis", "Celastrina ladon",
                                    "Danaus plexippus", "Atalopedes campestris"]})
    assert O.atlas_names(names, atlas) == {"Red-spotted Purple": "Limenitis astyanax",
                                           "White Admiral": "Limenitis arthemis", "Monarch": "Danaus plexippus"}
    assert set(O.SYNONYMS.values()) <= atlas


# The paper's own trends (ohio_published.py): rows copied from the deposit's speciesTrends.csv.
PUBLISHED = pd.DataFrame([
    ["Red-spotted Purple", "Limenitis arthemis", 6226, 87, 21, 913, -0.0639573151008051, 0.0186049899927946, 0.000586800612230841],
    ["Bronze Copper", "Lycaena hyllus", 656, 23, 21, 254, -0.062904279889323, 0.0385885470431892, 0.103074398447765],
    ["Eastern Tiger Swallowtail", "Papilio glaucus", 29299, 101, 21, 996, -0.0103721528938899, 0.0147821243533328, 0.482885842815634],
    ["Least Skipper", "Ancyloxypha numitor", 27506, 84, 21, 844, 0.0529930718469354, 0.0151674528964492, 0.00047607710653368],
    ["Gemmed Satyr", "Cyllopsis gemma", 1059, 6, 16, 81, 0.227739836170602, 0.0519625139394471, 1.17178883071611e-05],
    ["Monarch", "Danaus plexippus", 46070, 104, 21, 1005, -0.0701154108642979, 0.0228642111859387, 0.00216507713532567],
    ["Peck's Skipper", "Polites peckius", 1, 90, 21, 1, 0.0, 0.01, 1.0],
    ["Azures", "Celastrina ladon", 30000, 103, 21, 999, -0.01, 0.01, 0.3],
], columns=["CommonName", "Latin", "Total", "nsite", "yrs", "sy", "estimate", "std.error", "p.value"])


def test_published_trend_conversion_and_verdicts():
    from pipeline.atlas.ohio_published import convert, verdict
    pct, lo, hi = convert(np.log(0.97), 0.0)
    assert abs(pct + 3) < 1e-9 and lo == hi == pct
    pct, lo, hi = convert(-0.0639573151008051, 0.0186049899927946)
    assert (round(pct, 1), round(lo, 1), round(hi, 1)) == (-6.2, -9.6, -2.7)
    assert lo < pct < hi and abs(np.log1p(hi / 100) + np.log1p(lo / 100) - 2 * np.log1p(pct / 100)) < 1e-12  # symmetric in logs
    assert verdict(lo, hi) == "declining" and verdict(-4.0, 0.2) == "no clear trend" and verdict(0.1, 9) == "increasing"
    # The 95% interval excludes 0 exactly when the paper's two-sided p < 0.05 (both are Wald, from the same SE).
    for r in PUBLISHED.itertuples():
        _, lo, hi = convert(r.estimate, r._8)
        assert (verdict(lo, hi) != "no clear trend") == (r._9 < 0.05)


def test_values_are_rounded_once_to_what_the_card_writes():
    from pipeline.atlas.ohio_published import convert, shown
    _, _, hi = convert(-0.0701154108642979, 0.0228642111859387)  # the monarch's upper end
    # One decimal first gives -2.5, which the card (Math.round on the size, halves up) writes as 3: the old bug.
    assert -2.5 < hi < -2.49 and round(hi, 1) == -2.5 and shown(hi) == -2
    assert [shown(v) for v in (-9.47, 13.01, 0.19, -0.06, 0.004, 0.96)] == [-9, 13, 0.2, -0.1, 0.004, 1.0]


def test_published_records_match_thresholds_and_names():
    from pipeline.atlas.ohio_published import records
    atlas = {records_name(s) for s in json.loads((ROOT / "public/atlas/species.json").read_text())}
    ship, table = records(PUBLISHED, atlas)
    assert ship == {"Limenitis astyanax": ["oh", -6, -10, -3, 87, 21], "Tharsalea hyllus": ["oh", -6, -13, 1, 23, 21],
                    "Papilio glaucus": ["oh", -1, -4, 2, 101, 21], "Ancyloxypha numitor": ["oh", 5, 2, 9, 84, 21],
                    # Monarch: -6.77 (-10.86 to -2.4998). Rounded once: -7 (-11 to -2), never -2.5 and then -3.
                    "Danaus plexippus": ["oh", -7, -11, -2, 104, 21], "Polites coras": ["oh", 0.0, -2, 2, 90, 21]}
    why = dict(zip(table.CommonName, table.why_not))
    assert why["Gemmed Satyr"] == "not in the Atlas" and why["Azures"].startswith("complex")


def test_shipped_trends_are_butterflies_and_well_formed():
    species = json.loads((ROOT / "public/atlas/species.json").read_text())
    with_trend = [s for s in species if "trend" in s]
    assert 50 <= len(with_trend) <= 69 and not any("ohio" in s for s in species)
    for s in with_trend:
        src, pct, lo, hi, n_sites, n_years = s["trend"]
        assert src == "oh" and s["order"] == "Lepidoptera" and lo <= pct <= hi and n_sites >= 10 and n_years >= 10
    t = {records_name(s): s["trend"] for s in with_trend}  # GBIF's names, as the Ohio tables join them
    assert t["Limenitis astyanax"] == ["oh", -6, -10, -3, 87, 21] and t["Danaus plexippus"] == ["oh", -7, -11, -2, 104, 21]
    assert "Polites coras" in t and "Atrytone delaware" in t and t["Papilio glaucus"][2] < 0 < t["Papilio glaucus"][3]
    assert "Bombus impatiens" not in t and "Lethe eurydice" not in t and "Celastrina ladon" not in t
