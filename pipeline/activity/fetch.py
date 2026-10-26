"""Download daily iNaturalist counts and hourly weather for the study set. Cached in notebooks/data/activity/.

iNat: one histogram call per (region, year, taxon), 1 s apart. Weather: Open-Meteo archive, one call per
(region, year), hourly, local time.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .regions import BUTTERFLIES, END, FIREFLIES, LEPIDOPTERA, REGIONS, START, YEARS, box

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "notebooks" / "data" / "activity"
UA = {"User-Agent": "hatch-notebook/0.1 (github.com/neevliberman/hatch)"}
TAXA = {"lepi": LEPIDOPTERA, "butterfly": BUTTERFLIES, "firefly": FIREFLIES, "all": None}
HOURLY = "temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_gusts_10m,cloud_cover,precipitation,shortwave_radiation"


def _get(url, tries=6):
    for a in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - retry any network or 429/5xx failure
            if getattr(e, "code", 500) not in (429,) and getattr(e, "code", 500) < 500:
                raise
            time.sleep(2 ** a)
    raise RuntimeError(url)


def _wx_get(url):
    """Open-Meteo's free tier caps calls per hour; wait it out."""
    for _ in range(12):
        try:
            return _get(url, tries=1)
        except RuntimeError:
            time.sleep(300)
    raise RuntimeError(url)


def inat_counts(region, year, taxon):
    f = CACHE / f"inat_{region}_{year}_{taxon or 'all'}.json"
    if not f.exists():
        q = dict(box(region), date_field="observed", interval="day", d1=f"{year}-{START}", d2=f"{year}-{END}")
        if taxon:
            q["taxon_id"] = taxon
        out = _get("https://api.inaturalist.org/v1/observations/histogram?" + urllib.parse.urlencode(q))
        f.write_text(json.dumps(out["results"]["day"]))
        time.sleep(1.1)
    return json.loads(f.read_text())


def weather(region, year):
    f = CACHE / f"wx_{region}_{year}.json"
    if not f.exists():
        lat, lng = REGIONS[region]
        q = dict(latitude=lat, longitude=lng, start_date=f"{year}-{START}", end_date=f"{year}-{END}",
                 hourly=HOURLY, timezone="auto", wind_speed_unit="ms")
        f.write_text(json.dumps(_wx_get("https://archive-api.open-meteo.com/v1/archive?" + urllib.parse.urlencode(q))["hourly"]))
        time.sleep(0.5)
    return json.loads(f.read_text())


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    for r in REGIONS:
        for y in YEARS:
            weather(r, y)
            for t in TAXA.values():
                inat_counts(r, y, t)
        print("done", r, flush=True)
