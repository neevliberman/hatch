"""Bulk-pull research-grade iNaturalist insect records for the Atlas box from GBIF, into Parquet files by year.

GBIF's search API pages 300 records at a time, stops at offset 100,000 and gets slow past a few thousand, so the box
is split into date ranges of at most CAP records, halving a range until it fits (a July day can hold ~4,000).
Each finished range is written to its own Parquet file, so a killed run resumes where it stopped. Then `combine()`
writes one file per year into notebooks/data/atlas/records/year=YYYY/ for DuckDB.

No GBIF account needed. When the account's password is available, a monthly GBIF *download* (one zip) replaces this.
Run from the repo root (about an hour, ~20 GB of JSON on the wire):
  python3 pipeline/atlas/fetch_gbif.py
"""
import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas.config import BOX, DATA, FIRST_YEAR, LAST_YEAR  # noqa: E402

INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"  # iNaturalist research-grade observations
INSECTA = 216
API = "https://api.gbif.org/v1/occurrence/search"
PAGE = 300
CAP = 6_000  # deep offsets are slow (GBIF refuses past 100,000 anyway)
INNER = 2  # parallel pages per range; 8 ranges at once = 16 requests in flight
CHUNKS = DATA / "gbif_chunks"
FIELDS = ["key", "taxonID", "taxonRank", "speciesKey", "species", "genus", "family", "order", "decimalLatitude",
          "decimalLongitude", "coordinateUncertaintyInMeters", "eventDate", "eventTime", "year", "month", "day",
          "recordedBy", "stateProvince", "catalogNumber"]


def _params(d0, d1, offset=0, limit=PAGE):
    return {"datasetKey": INAT_DATASET, "classKey": INSECTA, "eventDate": f"{d0},{d1}",
            "decimalLatitude": f"{BOX['s']},{BOX['n']}", "decimalLongitude": f"{BOX['w']},{BOX['e']}",
            "hasGeospatialIssue": "false", "offset": offset, "limit": limit}


def _get(params):
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(10):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "hatch-atlas (github.com/neevliberman/hatch)"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception:
            time.sleep(min(2 ** attempt, 60))
    raise RuntimeError(f"GBIF kept failing: {url}")


def ranges(y0=FIRST_YEAR, y1=LAST_YEAR):
    """Date ranges (inclusive ISO days), each holding at most CAP records."""
    out, todo = [], []
    for y in range(y0, y1 + 1):
        for m in range(1, 13):
            d0 = dt.date(y, m, 1)
            d1 = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
            todo.append((d0, d1))
    with ThreadPoolExecutor(8) as ex:
        while todo:
            counts = list(ex.map(lambda r: _get(_params(*r, limit=0))["count"], todo))
            nxt = []
            for (d0, d1), n in zip(todo, counts):
                if n <= CAP or d0 == d1:
                    if n:
                        out.append((d0, d1, n))
                else:
                    mid = d0 + (d1 - d0) // 2
                    nxt += [(d0, mid), (mid + dt.timedelta(days=1), d1)]
            todo = nxt
    return sorted(out)


def _pull(d0, d1, n):
    f = CHUNKS / f"{d0}_{d1}.parquet"
    if f.exists():
        return len(pd.read_parquet(f, columns=["key"]))
    with ThreadPoolExecutor(INNER) as ex:  # pages of one range in parallel
        pages = ex.map(lambda o: _get(_params(d0, d1, o))["results"], range(0, n, PAGE))
        rows = [{k: r.get(k) for k in FIELDS} for page in pages for r in page]
    df = pd.DataFrame(rows, columns=FIELDS).drop_duplicates("key")
    tmp = f.with_suffix(".tmp")
    df.to_parquet(tmp, index=False)
    tmp.replace(f)  # atomic: a killed run never leaves half a chunk
    return len(df)


def combine():
    """Chunks -> one Parquet file per year, with the columns the Atlas uses."""
    import duckdb
    out = DATA / "records"
    con = duckdb.connect()
    con.execute(f"""
        COPY (
          SELECT key::BIGINT AS gbif_id, catalogNumber::BIGINT AS inat_id, taxonID::BIGINT AS inat_taxon,
                 taxonRank AS rank, speciesKey::BIGINT AS species_key, species, genus, family, "order",
                 decimalLatitude AS lat, decimalLongitude AS lng, coordinateUncertaintyInMeters AS accuracy_m,
                 year::INT AS year, month::INT AS month, day::INT AS day, eventTime AS event_time,
                 recordedBy AS observer, stateProvince AS state
          FROM read_parquet('{CHUNKS}/*.parquet', union_by_name=true)
          WHERE day IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY key) = 1
        ) TO '{out}' (FORMAT parquet, PARTITION_BY (year), OVERWRITE_OR_IGNORE true)
    """)
    print(con.execute(f"SELECT year, count(*) FROM read_parquet('{out}/*/*.parquet', hive_partitioning=true) "
                      "GROUP BY 1 ORDER BY 1").fetchall())


def main(y0=FIRST_YEAR, y1=LAST_YEAR, workers=8):
    CHUNKS.mkdir(parents=True, exist_ok=True)
    # counting takes a few minutes; reuse it when resuming the same snapshot
    cache = CHUNKS / ("ranges.json" if (y0, y1) == (FIRST_YEAR, LAST_YEAR) else f"ranges_{y0}_{y1}.json")
    if cache.exists():
        rs = [(dt.date.fromisoformat(a), dt.date.fromisoformat(b), n) for a, b, n in json.loads(cache.read_text())]
    else:
        rs = ranges(y0, y1)
        cache.write_text(json.dumps([(str(a), str(b), n) for a, b, n in rs]))
    keep = {f"{d0}_{d1}.parquet" for d0, d1, _ in rs}
    for f in CHUNKS.glob("*.parquet"):  # chunks from an older split would double-count
        if y0 <= int(f.name[:4]) <= y1 and f.name not in keep:
            f.unlink()
    print(f"{len(rs)} ranges, {sum(n for *_, n in rs):,} records", flush=True)
    done = 0
    with ThreadPoolExecutor(workers) as ex:
        for got in ex.map(lambda r: _pull(*r), rs):
            done += got
            print(f"  {done:,}", flush=True)
    combine()


if __name__ == "__main__":
    main(*map(int, sys.argv[1:3]))  # optional: first and last year, e.g. 2026 2026
