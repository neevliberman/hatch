"""Ohio butterfly trends, 1996-2016, for the Atlas species card: species.json's "ohio" (method: PREREG_OHIO.md).

ohio = [pct, lo, hi, n_sites, n_years]: annual % change in the Ohio Lepidopterists' effort-corrected population
index (Wepprich et al. 2019, PLoS ONE, doi:10.1371/journal.pone.0216270; data doi:10.5061/dryad.cf78420, CC0), its
95% two-way (site × year) bootstrap interval, and how many sites and years counted the species. Species below the
thresholds, or not in the Atlas, get no "ohio".

Model: log E[index] = site + β·year + log(survey minutes), Poisson quasi-likelihood with the site effects profiled
out exactly, so each fit is a 1-D Newton solve. numpy and pandas only.

  python3 pipeline/atlas/ohio_trends.py            # fetches (cached), fits, validates, rewrites species.json's "ohio"
  python3 pipeline/atlas/ohio_trends.py --report   # same, plus results/ohio/ tables; species.json untouched
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
OUT = ROOT / "public/atlas"
RESULTS = ROOT / "pipeline/atlas/results/ohio"
FIRST, LAST = 1996, 2016
MIN_SURVEYS, MIN_SITE_YEARS = 10, 3   # the paper's site-year filter
MIN_SITES, MIN_YEARS = 10, 10         # PREREG thresholds for a line
BOOT, SEED = 1000, 20261103
MAX_DROPPED = 0.05
PAPER_TOTAL_PCT = -2.0                # Wepprich et al. 2019, Table 1: B = -0.0203 per year

# Ohio common name -> the Atlas's (iNaturalist's) name for the same species, where the deposit's Latin differs.
# Straight renames only (PREREG); complexes are left out.
SYNONYMS = {
    "Acadian Hairstreak": "Strymon acadica", "American Copper": "Lycaena hypophlaeas",
    "Black Dash": "Euphyes conspicua", "Bronze Copper": "Tharsalea hyllus",
    "Common Checkered-Skipper": "Burnsius communis", "Common Roadside Skipper": "Mastor vialis",
    "Pepper and Salt Skipper": "Mastor hegon", "Coral Hairstreak": "Harkenclenus titus",
    "Eastern Tailed Blue": "Elkalyce comyntas", "Zebra Swallowtail": "Protographium marcellus",
    "Henry's Elfin": "Incisalia henrici", "Hoary Edge Skipper": "Cecropterus lyciades",
    "Hobomok Skipper": "Lon hobomok", "Zabulon Skipper": "Lon zabulon", "Little Glassy Wing": "Vernia verna",
    "Little Wood Satyr": "Euptychia cymela", "Milbert's Tortoise Shell": "Aglais milberti",
    "Northern Broken-Dash": "Polites egeremet", "Northern Eyed Brown": "Lethe eurydice",
    "Northern Pearly-Eye": "Lethe anthedon", "Olive Hairstreak": "Mitoura gryneus",
    "Sleepy Orange": "Abaeis nicippe", "Southern Dogface": "Zerene cesonia", "Mustard White": "Pieris oleracea",
    "Red-spotted Purple": "Limenitis astyanax",  # the deposit files it under Limenitis arthemis with White Admiral
}
COMPLEXES = {"Azures"}  # spring + summer azure combined: no single Atlas species


def load(cache: Path | None = None) -> pd.DataFrame:
    """allpops.csv filtered as the paper: 1996-2016, site-years with 10+ surveys, at sites with 3+ such years."""
    if cache is None:
        from pipeline.atlas.ohio_fetch import fetch
        cache = fetch()
    d = pd.read_csv(cache / "allpops.csv", dtype={"SiteID": str})
    d = d[(d.Year >= FIRST) & (d.Year <= LAST) & (d.SurvPerYear >= MIN_SURVEYS)]
    d = d[d.Index.notna() & d.meanTime.notna() & (d.meanTime > 0)]
    years = d.groupby("SiteID").Year.nunique()
    d = d[d.SiteID.isin(years[years >= MIN_SITE_YEARS].index)].copy()
    d["minutes"] = d.meanTime * d.SurvPerYear
    return d


def fit(site, x, y, offset, w=None, beta0=0.0, iters=50):
    """β of log E[y] = α_site + β·x + offset, Poisson (quasi-)likelihood, α profiled out; weights w (bootstrap
    multiplicities). Returns (β, observed information) or (nan, nan) when β is not identified or does not converge."""
    site = np.asarray(site)
    x, y, offset = (np.asarray(a, float) for a in (x, y, offset))
    w = np.ones_like(y) if w is None else np.asarray(w, float)
    keep = w > 0
    site, x, y, offset, w = site[keep], x[keep], y[keep], offset[keep], w[keep]
    _, g = np.unique(site, return_inverse=True)
    G = g.max() + 1 if len(g) else 0
    wy = w * y
    Y = np.bincount(g, wy, G)
    if Y.sum() <= 0 or len(np.unique(x[wy > 0])) < 2:
        return np.nan, np.nan
    sxy = np.sum(wy * x)
    xc = x - x.mean()
    beta = beta0
    for _ in range(iters):
        eta = offset + beta * xc
        e = w * np.exp(eta - eta.max())
        s0 = np.bincount(g, e, G)
        s1 = np.bincount(g, e * xc, G)
        s2 = np.bincount(g, e * xc * xc, G)
        ok = (Y > 0) & (s0 > 0)
        m1, m2 = s1[ok] / s0[ok], s2[ok] / s0[ok]
        score = sxy - np.sum(wy * x.mean()) - np.sum(Y[ok] * m1)
        info = np.sum(Y[ok] * (m2 - m1 * m1))
        if not np.isfinite(info) or info <= 0:
            return np.nan, np.nan
        step = score / info
        beta += float(np.clip(step, -0.5, 0.5))
        if abs(beta) > 3:
            return np.nan, np.nan
        if abs(step) < 1e-10:
            return beta, info
    return np.nan, np.nan


def dispersion(site, x, y, offset, beta):
    """Pearson χ²/(n − sites − 1) at the profiled fit, for quasi-Poisson standard errors."""
    df = pd.DataFrame({"g": site, "x": np.asarray(x, float), "y": y, "o": offset})
    df["e"] = np.exp(df.o + beta * df.x)
    a = df.groupby("g").y.transform("sum") / df.groupby("g").e.transform("sum")
    mu = a * df.e
    used = df[mu > 0]
    n, p = len(used), used.g.nunique() + 1
    return float(np.sum((used.y - mu[mu > 0]) ** 2 / mu[mu > 0]) / max(n - p, 1))


def boot(site, x, y, offset, n=BOOT, seed=SEED):
    """Two-way pairs bootstrap: resample sites and years with replacement, independently; a site-year's weight is its
    site's count times its year's count. Returns the β of each resample (nan where not identified)."""
    rng = np.random.default_rng(seed)
    site, x = np.asarray(site), np.asarray(x)
    us, si = np.unique(site, return_inverse=True)
    uy, yi = np.unique(x, return_inverse=True)
    out = np.empty(n)
    for b in range(n):
        ws = np.bincount(rng.integers(0, len(us), len(us)), minlength=len(us))
        wy = np.bincount(rng.integers(0, len(uy), len(uy)), minlength=len(uy))
        out[b] = fit(site, x, y, offset, ws[si] * wy[yi])[0]
    return out


def trend(d: pd.DataFrame, response="Index", offset="minutes", n_boot=BOOT, seed=SEED, extra=None) -> dict:
    """One species' (or the total's) trend from its rows: β, %/yr, bootstrap and quasi-Poisson 95% intervals."""
    ever = d.groupby("SiteID")["YearTotal"].transform("sum") > 0
    d = d[ever]
    y = d[response].to_numpy(float)
    off = np.log(d[offset].to_numpy(float))
    if extra is not None:  # a covariate: profile it too, by adding its fitted effect into the offset (2 passes)
        z = d[extra].to_numpy(float) - d[extra].mean()
        gam = 0.0
        for _ in range(20):
            beta, _ = fit(d.SiteID, d.Year, y, off + gam * z)
            gam_new, _ = fit(d.SiteID, z, y, off + beta * (d.Year - d.Year.mean()).to_numpy())
            if not np.isfinite(gam_new) or abs(gam_new - gam) < 1e-9:
                break
            gam = gam_new
        off = off + gam * z
    beta, info = fit(d.SiteID, d.Year, y, off)
    seen = d[d.YearTotal > 0]
    res = {"beta": beta, "pct": 100 * np.expm1(beta), "n_sites": seen.SiteID.nunique(),
           "n_years": seen.Year.nunique(), "n_rows": len(d), "counted": int(d.YearTotal.sum())}
    if not np.isfinite(beta):
        return res | {"lo": np.nan, "hi": np.nan, "q_lo": np.nan, "q_hi": np.nan, "dropped": 1.0}
    phi = dispersion(d.SiteID.to_numpy(), d.Year - d.Year.mean(), y, off, beta)
    se = np.sqrt(phi / info)
    res |= {"q_lo": 100 * np.expm1(beta - 1.96 * se), "q_hi": 100 * np.expm1(beta + 1.96 * se), "phi": phi}
    if n_boot:
        b = boot(d.SiteID.to_numpy(), d.Year.to_numpy(), y, off, n_boot, seed)
        ok = b[np.isfinite(b)]
        res["dropped"] = 1 - len(ok) / n_boot
        lo, hi = np.percentile(ok, [2.5, 97.5]) if len(ok) else (np.nan, np.nan)
        res |= {"lo": 100 * np.expm1(lo), "hi": 100 * np.expm1(hi)}
    return res


def shown(r: dict) -> bool:
    return (r["n_sites"] >= MIN_SITES and r["n_years"] >= MIN_YEARS and np.isfinite(r.get("lo", np.nan))
            and r.get("dropped", 1) <= MAX_DROPPED)


def verdict(lo, hi) -> str:
    return "declining" if hi < 0 else "increasing" if lo > 0 else "no clear trend"


def atlas_names(names: pd.DataFrame, atlas: set) -> dict:
    """Ohio common name -> Atlas scientific name, for the species in both (exact Latin, then SYNONYMS)."""
    out = {}
    for r in names.itertuples():
        if r.CommonName in COMPLEXES:
            continue
        n = SYNONYMS.get(r.CommonName, r.Latin)
        if n in atlas:
            out[r.CommonName] = n
    dupes = pd.Series(out).value_counts()
    assert (dupes == 1).all(), f"two Ohio names on one Atlas species: {list(dupes[dupes > 1].index)}"
    return out


def run(n_boot=BOOT):
    from pipeline.atlas.ohio_fetch import fetch
    cache = fetch()
    d = load(cache)
    rows = []
    for name, g in d.groupby("CommonName"):
        rows.append({"CommonName": name} | trend(g, n_boot=n_boot))
    sp = pd.DataFrame(rows)
    tot = d.groupby(["SiteID", "Year"], as_index=False).agg(Index=("Index", "sum"), YearTotal=("YearTotal", "sum"),
                                                             minutes=("minutes", "first"), meanLL=("meanLL", "first"),
                                                             SurvPerYear=("SurvPerYear", "first"))
    total = trend(tot, n_boot=n_boot)
    return d, sp, tot, total, cache


def main():
    report = "--report" in sys.argv
    d, sp, tot, total, cache = run()
    paper = pd.read_csv(cache / "speciesTrends.csv")
    names = pd.read_csv(cache / "species_names.csv")
    species = json.loads((OUT / "species.json").read_text())
    match = atlas_names(names, {s["name"] for s in species})
    sp["shown"] = sp.apply(lambda r: shown(r.to_dict()), axis=1)
    sp["verdict"] = [verdict(a, b) for a, b in zip(sp.lo, sp.hi)]
    sp["atlas"] = sp.CommonName.map(match)
    m = sp.merge(paper[["CommonName", "estimate", "std.error", "p.value"]], on="CommonName", how="inner")
    r = float(np.corrcoef(m.beta, m.estimate)[0, 1])
    both = m[(m.verdict != "no clear trend") & (m["p.value"] < 0.05)]
    flips = int((np.sign(both.beta) != np.sign(both.estimate)).sum())
    ok_total = abs(total["pct"] - PAPER_TOTAL_PCT) <= 1.0
    ok_species = r >= 0.8 and flips <= 1
    print(f"total: {total['pct']:+.2f}%/yr ({total['lo']:+.2f} to {total['hi']:+.2f}); quasi "
          f"({total['q_lo']:+.2f} to {total['q_hi']:+.2f}); paper -2.0  -> {'PASS' if ok_total else 'FAIL'}")
    print(f"species vs paper: n={len(m)} r={r:.3f}, both-significant {len(both)}, opposite signs {flips} "
          f"-> {'PASS' if ok_species else 'FAIL'}")
    if report:
        RESULTS.mkdir(parents=True, exist_ok=True)
        sp.merge(paper[["CommonName", "estimate", "std.error", "p.value"]], on="CommonName", how="left").to_csv(
            RESULTS / "species.csv", index=False, float_format="%.5g")
        sens = {"primary": total,
                "raw_per_survey": trend(tot, response="YearTotal", offset="SurvPerYear"),
                "with_list_length": trend(tot, extra="meanLL")}
        (RESULTS / "total.json").write_text(json.dumps(sens, indent=1, default=float))
        alt = []
        for name, g in d.groupby("CommonName"):
            a = trend(g, response="YearTotal", offset="SurvPerYear", n_boot=0)
            c = trend(g, extra="meanLL", n_boot=0)
            alt.append({"CommonName": name, "raw_beta": a["beta"], "ll_beta": c["beta"]})
        pd.DataFrame(alt).to_csv(RESULTS / "sensitivity.csv", index=False, float_format="%.5g")
        return
    if not (ok_total and ok_species):
        sys.exit("validation failed: species.json not touched (PREREG_OHIO.md)")
    ship = {r.atlas: [round(r.pct, 1), round(r.lo, 1), round(r.hi, 1), int(r.n_sites), int(r.n_years)]
            for r in sp[sp.shown & sp.atlas.notna()].itertuples()}
    for s in species:
        s.pop("ohio", None)
        if s["name"] in ship:
            s["ohio"] = ship[s["name"]]
    (OUT / "species.json").write_text(json.dumps(species, separators=(",", ":"), ensure_ascii=False))
    v = [verdict(a[1], a[2]) for a in ship.values()]
    print(f"species.json: {len(ship)} species with an Ohio line: {v.count('declining')} declining, "
          f"{v.count('increasing')} increasing, {v.count('no clear trend')} no clear trend")


if __name__ == "__main__":
    main()
