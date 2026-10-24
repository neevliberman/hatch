#!/usr/bin/env python3
"""Download the firefly inputs into notebooks/data/ (gitignored); reruns are offline.

- iNaturalist records of the common eastern firefly (Photinus pyralis, taxon 129350) in the 7 states, with licence.
- Daily beetle records per state (the effort background: who was out looking at beetles that day).
- Daymet temperatures for every core res-4 cell and every hex with a record (shared cache with the luna build).
"""
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

from hatch_p1 import inat, run  # noqa: E402

TAXON = 129350
LAST_DOY = 240     # one generation: every strip's window runs 1 March to this day (fit, map and live forecast)
COLEOPTERA = 47208
RAW = run.DATA / "firefly_inat.parquet"
EFFORT = run.DATA / "firefly_beetle_effort_by_state.parquet"


def fetch_records(out: Path = RAW) -> pd.DataFrame:
    if out.exists():
        return pd.read_parquet(out)
    rows, last = [], 0
    while True:
        js = inat._get("observations", {
            "taxon_id": TAXON, "place_id": ",".join(map(str, inat.MIDWEST_PLACES)),
            "per_page": 200, "order_by": "id", "order": "asc", "id_above": last})
        res = js["results"]
        if not res:
            break
        for o in res:
            r = inat._row(o)
            r["license_code"] = o.get("license_code")
            rows.append(r)
        last = res[-1]["id"]
        time.sleep(1)
    df = pd.DataFrame(rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    return df


def fetch_effort(years=range(2015, 2026), out: Path = EFFORT) -> pd.DataFrame:
    """Daily verifiable beetle observations per state, minus fireflies' own family (Lampyridae, 47731)."""
    if out.exists():
        return pd.read_parquet(out)
    from fit.data import STATE_PLACES
    parts = []
    for ab, place in STATE_PLACES.items():
        for y in years:
            js = inat._get("observations/histogram", {
                "taxon_id": COLEOPTERA, "without_taxon_id": 47731, "place_id": place,
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
    raw = fetch_records()
    print(f"{len(raw)} firefly records", flush=True)
    fetch_effort()
    print("effort done", flush=True)
    from hatch_p1.prep import clean
    from replay.build_replay import core_cells, daymet_cube
    hexes = sorted(set(core_cells()) | set(clean(raw).hex))
    print(f"daymet for {len(hexes)} hexes", flush=True)
    daymet_cube(hexes, run.DATA / "daymet")
    print("daymet done", flush=True)


if __name__ == "__main__":
    main()
