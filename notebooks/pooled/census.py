#!/usr/bin/env python3
"""How many Midwest moth species have enough records? (counts only; ~10 iNat calls, cached)

Counts research-grade, adult-annotated, openly licensed (CC0 / CC BY / CC BY-NC) moth records,
2015-2025, 7 states, per species (the same filter as fetch.py). Cleaning (one per observer+hex+day,
accuracy, captive) removes roughly a fifth more; the ratio from the fetched species is applied.
Writes notebooks/pooled/results/census.json.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for p in (ROOT / "notebooks", ROOT / "pipeline", HERE):
    sys.path.insert(0, str(p))

from hatch_p1 import inat  # noqa: E402
import fetch  # noqa: E402

CACHE = fetch.DATA / "pooled_census.json"


def counts():
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    out, page = [], 1
    while True:
        js = inat._get("observations/species_counts", {**fetch.BASE_Q, "taxon_id": fetch.LEPIDOPTERA,
                                                       "without_taxon_id": fetch.BUTTERFLIES, "per_page": 500,
                                                       "page": page})
        res = js["results"]
        out += [{"id": r["taxon"]["id"], "name": r["taxon"]["name"], "rank": r["taxon"].get("rank"),
                 "count": r["count"]} for r in res]
        if not res or res[-1]["count"] < 10 or len(out) >= js["total_results"]:
            break
        page += 1
        time.sleep(1)
    CACHE.write_text(json.dumps(out))
    return out


def main():
    c = pd.DataFrame(counts())
    c = c[c["rank"] == "species"]
    sp = pd.read_csv(HERE / "species.csv")
    cand = pd.read_csv(fetch.DATA / "pooled_candidates.csv")[["taxon_id", "inat_count"]]
    m = sp.merge(cand, on="taxon_id")
    ratio = float(np.median(m.n_window / m.inat_count))   # cleaned, in-window records per raw count
    th = [10, 25, 50, 100, 200, 400, 1000]
    res = {"species_total": int(len(c)), "clean_in_window_ratio": round(ratio, 3),
           "species_with_at_least_raw": {t: int((c["count"] >= t).sum()) for t in th},
           "species_with_at_least_clean_est": {t: int((c["count"] * ratio >= t).sum()) for t in th}}
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "census.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
