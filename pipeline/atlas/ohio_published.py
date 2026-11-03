"""The paper's own Ohio butterfly trends on the Atlas species card: species.json's "trend".

Source: Wepprich et al. 2019, "Butterfly abundance declines over 20 years of systematic monitoring in Ohio, USA",
PLoS ONE 14(7): e0216270 (doi:10.1371/journal.pone.0216270), main-text Table 2, as deposited in `speciesTrends.csv`
(Dryad doi:10.5061/dryad.cf78420, CC0; fetched and checked by ohio_fetch.py). Counts by the Ohio Lepidopterists'
volunteers, 1996-2016. These are the published, peer-reviewed estimates, used as they are: our own refit
(ohio_trends.py) failed its check against them and stays research only (RESULT_OHIO.md).

trend = [source, pct, lo, hi, n_sites, n_years]: source "oh" (the app maps it to "Ohio counts 1996-2016" and the
credit); the year coefficient β of the paper's GLMM as an annual % change, 100·(e^β − 1), with its 95% interval
β ± 1.96·SE; how many sites and years the paper's model used. One decimal.
"Declining" or "increasing" only when that interval excludes 0; otherwise "no clear trend" (the app reads the sign
of lo and hi). Species at under 10 sites (the paper itself warns about those) or 10 years get nothing.

  python3 pipeline/atlas/ohio_published.py   # rewrites public/atlas/species.json's "trend" in place (network once)
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.atlas.ohio_trends import atlas_names  # noqa: E402

OUT = ROOT / "public/atlas"
SOURCE = "oh"
MIN_SITES, MIN_YEARS = 10, 10
Z = 1.959964
# Matched by name but left out on purpose, with why.
EXCLUDE = {
    # The Atlas names Lethe eurydice "Appalachian Brown", the sibling species (L. appalachia) the deposit counts
    # separately; the two are often confused in the field and in photos, so the line could land on the wrong one.
    "Northern Eyed Brown": "sibling-species confusion and an Atlas common-name mismatch",
}


def convert(beta: float, se: float) -> tuple[float, float, float]:
    """A log-scale annual coefficient and its SE -> (% per year, lower, upper) of the 95% Wald interval."""
    pct = lambda b: 100 * math.expm1(b)  # noqa: E731
    return pct(beta), pct(beta - Z * se), pct(beta + Z * se)


def verdict(lo: float, hi: float) -> str:
    return "declining" if hi < 0 else "increasing" if lo > 0 else "no clear trend"


def records(paper: pd.DataFrame, atlas: set) -> tuple[dict, pd.DataFrame]:
    """Atlas name -> trend, and a table of every published species: its Atlas match (or why none) and its line."""
    match = atlas_names(paper[["CommonName", "Latin"]], atlas)
    out, rows = {}, []
    for r in paper.rename(columns={"std.error": "se"}).itertuples():
        pct, lo, hi = convert(r.estimate, r.se)
        name = match.get(r.CommonName)
        why = ("excluded: " + EXCLUDE[r.CommonName] if r.CommonName in EXCLUDE
               else "complex (no single Atlas species)" if r.CommonName == "Azures"
               else "not in the Atlas" if name is None
               else f"under {MIN_SITES} sites" if r.nsite < MIN_SITES
               else f"under {MIN_YEARS} years" if r.yrs < MIN_YEARS else "")
        if not why:
            out[name] = [SOURCE, round(pct, 1), round(lo, 1), round(hi, 1), int(r.nsite), int(r.yrs)]
        rows.append({"CommonName": r.CommonName, "Latin": r.Latin, "atlas": name, "pct": round(pct, 2),
                     "lo": round(lo, 2), "hi": round(hi, 2), "nsite": r.nsite, "yrs": r.yrs,
                     "verdict": verdict(lo, hi), "shipped": not why, "why_not": why})
    return out, pd.DataFrame(rows)


def main():
    from pipeline.atlas.ohio_fetch import fetch
    paper = pd.read_csv(fetch() / "speciesTrends.csv")
    path = OUT / "species.json"
    species = json.loads(path.read_text())
    ship, table = records(paper, {s["name"] for s in species})
    for s in species:
        s.pop("trend", None)
        if s["name"] in ship:
            s["trend"] = ship[s["name"]]
    path.write_text(json.dumps(species, separators=(",", ":"), ensure_ascii=False))
    res = ROOT / "pipeline/atlas/results/ohio"
    res.mkdir(parents=True, exist_ok=True)
    table.to_csv(res / "published.csv", index=False)
    v = [verdict(t[2], t[3]) for t in ship.values()]
    print(f"species.json: {len(ship)} species with a trend: {v.count('declining')} declining, "
          f"{v.count('increasing')} increasing, {v.count('no clear trend')} no clear trend")
    print(table[~table.shipped].groupby("why_not").CommonName.apply(", ".join).to_string())


if __name__ == "__main__":
    main()
