"""Pull iNaturalist observations for one taxon across the 7 Midwest states.

Paging uses id_above (iNat's recommended way past 10k results) and a 1 s
pause between calls to stay well under iNat's rate limit.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

API = "https://api.inaturalist.org/v1"
# WI IL MN IA MI IN OH
MIDWEST_PLACES = [32, 35, 38, 24, 29, 20, 31]
UA = {"User-Agent": "hatch-notebook/0.1 (github.com/neevliberman/hatch)"}

# iNat controlled terms: 1 = Life Stage, 2 = Adult
LIFE_STAGE, ADULT = 1, 2


def _get(path, params):
    url = f"{API}/{path}?{urllib.parse.urlencode(params, doseq=True)}"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise  # a 4xx is our bug; retrying won't help
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed: {url}")


def _row(o):
    stage = None
    for a in o.get("annotations") or []:
        if a.get("controlled_attribute_id") == LIFE_STAGE:
            stage = a.get("controlled_value_id")
    lat, lng = (o.get("geojson") or {}).get("coordinates", [None, None])[::-1]
    return {
        "id": o["id"],
        "observed_on": o.get("observed_on"),  # local date, as the observer saw it
        "created_at": o.get("created_at"),
        "lat": lat,
        "lng": lng,
        "accuracy_m": o.get("positional_accuracy"),
        "obscured": o.get("obscured"),
        "geoprivacy": o.get("geoprivacy"),
        "quality_grade": o.get("quality_grade"),
        "captive": o.get("captive"),
        "user_id": (o.get("user") or {}).get("id"),
        "life_stage": {ADULT: "adult"}.get(stage, None if stage is None else f"other:{stage}"),
        "community_taxon_id": o.get("community_taxon_id"),
        "taxon_id": (o.get("taxon") or {}).get("id"),
    }


def fetch_taxon(taxon_id, out: Path, refresh=False):
    if out.exists() and not refresh:
        return pd.read_parquet(out)
    rows, last = [], 0
    while True:
        js = _get("observations", {
            "taxon_id": taxon_id, "place_id": ",".join(map(str, MIDWEST_PLACES)),
            "per_page": 200, "order_by": "id", "order": "asc", "id_above": last,
        })
        res = js["results"]
        if not res:
            break
        rows += [_row(o) for o in res]
        last = res[-1]["id"]
        time.sleep(1)
    df = pd.DataFrame(rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    return df


def fetch_daily_effort(taxon_id, without_taxon_id, years, out: Path, refresh=False):
    """Daily count of observations of a background group (all Midwest), per year."""
    if out.exists() and not refresh:
        return pd.read_parquet(out)
    parts = []
    for y in years:
        js = _get("observations/histogram", {
            "taxon_id": taxon_id, "without_taxon_id": without_taxon_id,
            "place_id": ",".join(map(str, MIDWEST_PLACES)), "date_field": "observed",
            "interval": "day", "d1": f"{y}-01-01", "d2": f"{y}-12-31", "verifiable": "true",
        })
        d = js["results"]["day"]
        parts.append(pd.DataFrame({"date": list(d.keys()), "n": list(d.values())}))
        time.sleep(1)
    df = pd.concat(parts)
    df["date"] = pd.to_datetime(df["date"])
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    return df
