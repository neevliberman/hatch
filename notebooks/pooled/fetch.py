#!/usr/bin/env python3
"""Download inputs for the pooled-species prototype (EXPLORATORY, not pre-registered).

Raw downloads go to notebooks/data/ (gitignored). Only small derived tables are committed
(notebooks/pooled/species.csv, written by select.py).

1. Candidate list: iNat species counts of moths (Lepidoptera minus butterflies) in the 7 states,
   2015-2025, research grade, annotated adult, open licence (CC0 / CC BY / CC BY-NC).
2. Records for the top candidates (same filters), one parquet per species under data/pooled_raw/.
3. Moth effort background per state (the luna P3 file, shared cache: fit.data.fetch_effort).
4. Daymet at every res-4 hex holding a record (shared cache with luna/firefly).

Usage: python3 notebooks/pooled/fetch.py [--top 80]
"""
import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / "notebooks", ROOT / "pipeline"):
    sys.path.insert(0, str(p))

from hatch_p1 import inat  # noqa: E402

DATA = ROOT / "notebooks" / "data"
RAW = DATA / "pooled_raw"
LEPIDOPTERA, BUTTERFLIES = 47157, 47224
LICENSES = "cc0,cc-by,cc-by-nc"
BASE_Q = {"place_id": ",".join(map(str, inat.MIDWEST_PLACES)), "quality_grade": "research",
          "d1": "2015-01-01", "d2": "2025-12-31", "term_id": 1, "term_value_id": 2, "license": LICENSES}

# Left out before any fit, for a biological reason the heat model can't handle (decided from names only).
# 24 names; 15 of them occur among the candidates actually ranked (the rest were listed pre-emptively).
# Hypena scabra and Emmelina monodactyla were added after the first download had started but before any fit,
# so their raw files exist; select.py reads this dict and drops them ("adult overwinters" in species.csv).
EXCLUDE = {
    # migrants: most Midwest adults fly in from the south, so local warmth doesn't time them
    "Agrotis ipsilon": "migrant", "Helicoverpa zea": "migrant", "Spodoptera frugiperda": "migrant",
    "Spodoptera ornithogalli": "migrant", "Mythimna unipuncta": "migrant", "Pseudaletia unipuncta": "migrant",
    "Peridroma saucia": "migrant", "Nomophila nearctica": "migrant", "Hyles lineata": "migrant",
    "Plutella xylostella": "migrant", "Orthonama obstipata": "migrant", "Spoladea recurvalis": "migrant",
    "Hymenia perspectalis": "migrant", "Anagrapha falcifera": "partly migrant", "Udea rubigalis": "partly migrant",
    "Agrius cingulata": "migrant", "Chrysodeixis includens": "migrant", "Trichoplusia ni": "migrant",
    # adults overwinter or aestivate, so the 'emerge once warmth is banked' story doesn't apply
    "Scoliopteryx libatrix": "adult overwinters", "Hypena scabra": "adult overwinters",
    "Emmelina monodactyla": "adult overwinters", "Noctua pronuba": "adult aestivates",
    # indoor / stored-product moths
    "Pyralis farinalis": "stored products", "Plodia interpunctella": "stored products",
}


def species_counts(out=DATA / "pooled_candidates.json"):
    if out.exists():
        return json.loads(out.read_text())
    js = inat._get("observations/species_counts", {**BASE_Q, "taxon_id": LEPIDOPTERA,
                                                   "without_taxon_id": BUTTERFLIES, "per_page": 500})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(js))
    return js


def families(taxa, out=DATA / "pooled_families.json"):
    """{taxon id: family name} from each taxon's ancestor ids."""
    if out.exists():
        return {int(k): v for k, v in json.loads(out.read_text()).items()}
    anc = sorted({a for t in taxa for a in t["ancestor_ids"]})
    fam = {}
    for i in range(0, len(anc), 30):
        js = inat._get("taxa/" + ",".join(map(str, anc[i:i + 30])), {})
        fam.update({r["id"]: r["name"] for r in js["results"] if r.get("rank") == "family"})
        time.sleep(1)
    res = {t["id"]: next((fam[a] for a in t["ancestor_ids"] if a in fam), None) for t in taxa}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res))
    return res


def fetch_species(taxon_id):
    f = RAW / f"{taxon_id}.parquet"
    if f.exists():
        return pd.read_parquet(f)
    rows, last = [], 0
    while True:
        js = inat._get("observations", {**BASE_Q, "taxon_id": taxon_id, "per_page": 200,
                                        "order_by": "id", "order": "asc", "id_above": last})
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
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(f)
    return df


def candidates(top):
    js = species_counts()
    taxa = [r["taxon"] for r in js["results"]]
    fam = families(taxa)
    rows = [{"taxon_id": r["taxon"]["id"], "name": r["taxon"]["name"],
             "common": r["taxon"].get("preferred_common_name"), "family": fam.get(r["taxon"]["id"]),
             "inat_count": r["count"], "excluded": EXCLUDE.get(r["taxon"]["name"])}
            for r in js["results"] if r["taxon"].get("rank") == "species"]
    c = pd.DataFrame(rows)
    keep = c[c.excluded.isna()].head(top)
    return c, keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=80)
    a = ap.parse_args()
    allc, keep = candidates(a.top)
    DATA.mkdir(parents=True, exist_ok=True)
    allc.head(a.top + 40).to_csv(DATA / "pooled_candidates.csv", index=False)
    print(f"{len(keep)} candidates; smallest count {keep.inat_count.min()}", flush=True)
    for i, x in enumerate(keep.itertuples()):
        d = fetch_species(x.taxon_id)
        print(f"{i + 1}/{len(keep)} {x.name}: {len(d)}", flush=True)
    from fit.data import fetch_effort, EFFORT
    fetch_effort(out=EFFORT)
    print("effort done", flush=True)
    from hatch_p1.prep import clean
    hexes = set()
    for x in keep.itertuples():
        hexes |= set(clean(pd.read_parquet(RAW / f"{x.taxon_id}.parquet")).hex)
    from hatch_p1.daymet import temperature_cube
    print(f"daymet for {len(hexes)} hexes", flush=True)
    temperature_cube(sorted(hexes), 2015, 2025, DATA / "daymet", workers=4)
    print("daymet done", flush=True)


if __name__ == "__main__":
    main()
