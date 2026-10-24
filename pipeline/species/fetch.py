#!/usr/bin/env python3
"""Download one species' inputs into notebooks/data/ (gitignored); reruns are offline.

    python3 pipeline/species/fetch.py japanese-beetle

- iNaturalist records of the species in the 7 states, with licence.
- Daily records of its background group per state (the effort background).
- Daymet temperatures for every core res-4 cell and every hex with a record (shared cache with luna and firefly).
"""
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

from hatch_p1 import inat, run  # noqa: E402
from species import get  # noqa: E402


def raw_path(sp):
    return run.DATA / f"{sp.key}_inat.parquet"


def effort_path(sp):
    return run.DATA / f"{sp.key}_effort_by_state.parquet"


def fetch_records(sp) -> pd.DataFrame:
    out = raw_path(sp)
    if out.exists():
        return pd.read_parquet(out)
    rows, last = [], 0
    while True:
        js = inat._get("observations", {
            "taxon_id": sp.taxon, "place_id": ",".join(map(str, inat.MIDWEST_PLACES)),
            "per_page": 200, "order_by": "id", "order": "asc", "id_above": last})
        res = js["results"]
        if not res:
            break
        for o in res:
            r = inat._row(o)
            r["license_code"] = o.get("license_code")
            rows.append(r)
        last = res[-1]["id"]
        if len(rows) % 2000 < 200:
            print(f"  {len(rows)} records", flush=True)
        time.sleep(1)
    df = pd.DataFrame(rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    return df


def fetch_effort(sp, years=range(2015, 2026)) -> pd.DataFrame:
    out = effort_path(sp)
    if out.exists():
        return pd.read_parquet(out)
    from fit.data import STATE_PLACES
    parts = []
    for ab, place in STATE_PLACES.items():
        for y in years:
            js = inat._get("observations/histogram", {
                "taxon_id": sp.effort_taxon, "without_taxon_id": sp.effort_without, "place_id": place,
                "date_field": "observed", "interval": "day", "verifiable": "true",
                "d1": f"{y}-01-01", "d2": f"{y}-12-31"})
            day = js["results"]["day"]
            parts.append(pd.DataFrame({"state": ab, "date": list(day), "n": list(day.values())}))
            time.sleep(1)
    df = pd.concat(parts, ignore_index=True)
    df["date"] = df["date"].astype(str).str[:10]
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    return df


def main():
    sp = get(sys.argv[1] if len(sys.argv) > 1 else "japanese-beetle")
    raw = fetch_records(sp)
    print(f"{len(raw)} {sp.name} records", flush=True)
    fetch_effort(sp)
    print("effort done", flush=True)
    from hatch_p1.prep import clean
    from replay.build_replay import core_cells, daymet_cube
    hexes = sorted(set(core_cells()) | set(clean(raw).hex))
    print(f"daymet for {len(hexes)} hexes", flush=True)
    daymet_cube(hexes, run.DATA / "daymet")
    print("daymet done", flush=True)


if __name__ == "__main__":
    main()
