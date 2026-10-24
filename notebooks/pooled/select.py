#!/usr/bin/env python3
"""Pick the species for the pooled prototype from the downloaded candidates (rules fixed before any fit).

Rules:
- not on fetch.EXCLUDE (migrants, adults that overwinter or aestivate, stored-product moths);
- >= 400 cleaned records (P1 filters: research grade, adult, not captive/obscured, <= 5 km,
  one per observer + res-4 hex + day, 2015-2025) up to day 240 (28 Aug), the model's window;
- median sighting day between 130 (10 May) and 205 (24 Jul): a spring/summer flier whose flight the
  1 March warmth account can plausibly time (very early spring and autumn fliers are left out);
- >= 70% of its records on or before day 240.

Writes notebooks/pooled/species.csv (small, committed). Traits come from traits.csv (hand-entered).
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for p in (ROOT / "notebooks", ROOT / "pipeline", HERE):
    sys.path.insert(0, str(p))

from hatch_p1.prep import clean  # noqa: E402
import fetch  # noqa: E402

MIN_N, DOY_LO, DOY_HI, IN_WINDOW = 400, 130, 205, 0.70
MAX_SPECIES = 60


def main():
    cand = pd.read_csv(fetch.DATA / "pooled_candidates.csv")
    rows = []
    for x in cand.itertuples():
        f = fetch.RAW / f"{x.taxon_id}.parquet"
        if not f.exists():
            continue
        d = clean(pd.read_parquet(f))
        w = d[d.doy <= 240]
        rows.append({"taxon_id": x.taxon_id, "name": x.name, "common": x.common, "family": x.family,
                     "excluded": fetch.EXCLUDE.get(x.name, ""),
                     "n_clean": len(d), "n_window": len(w), "share_window": round(len(w) / max(len(d), 1), 3),
                     "median_doy": float(np.median(d.doy)) if len(d) else np.nan,
                     "n_years": int(w.year.nunique()), "n_observers": int(w.user_id.nunique())})
    s = pd.DataFrame(rows)
    why = []
    for x in s.itertuples():
        r = x.excluded or ("too few records" if x.n_window < MIN_N else
                           "median day outside 130-205" if not DOY_LO <= x.median_doy <= DOY_HI else
                           "under 70% in window" if x.share_window < IN_WINDOW else "")
        why.append(r)
    s["dropped_because"] = why
    s["selected"] = s.dropped_because == ""
    sel = s[s.selected].sort_values("n_window", ascending=False)
    if len(sel) > MAX_SPECIES:
        s.loc[sel.index[MAX_SPECIES:], ["selected", "dropped_because"]] = [False, "over the 60-species cap"]
    s.sort_values(["selected", "n_window"], ascending=False).to_csv(HERE / "species.csv", index=False)
    print(s.dropped_because.replace("", "SELECTED").value_counts().to_string())
    print(s[s.selected][["name", "family", "n_window", "median_doy"]].to_string())


if __name__ == "__main__":
    main()
