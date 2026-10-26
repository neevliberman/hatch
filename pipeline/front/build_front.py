#!/usr/bin/env python3
"""Spring arrival tracker data for the migrants (monarch, red admiral): sightings only, no forecast.

    python3 pipeline/front/build_front.py monarch      # past springs -> public/species/monarch/front.json

Migrants arrive from the south rather than emerge from warmth (the species check, /mnt/project-files/species-pick), so
Hatch shows where they have been seen so far, not when they will be. The page draws these as dots and a northern edge.
Rows are the live file's: [iNat id, year, day of year, lat, lng, flags] (flag 2 = rough location, 4 = not yet
confirmed), adults only, openly licensed (CC0 / CC BY / CC BY-NC), one per person, place and day, 1 March to FRONT_END.
`live_front()` is the same for this season, which pipeline/live/build_live.py adds to the nightly file under `front`.
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

from hatch_p1.prep import BANDS  # noqa: E402

FRONT_END = 196          # 15 July: the migrants' spring wave is in by then; later dots are the summer's own broods
FIRST_YEAR = 2019        # earlier springs have a few dozen sightings each
LAST_YEAR = 2025         # the season menu offers the luna replay's years (2015-2025)
SPECIES = {
    "monarch": {"name": "Monarch", "sci": "Danaus plexippus", "taxon": 48662},
    "red-admiral": {"name": "Red admiral", "sci": "Vanessa atalanta", "taxon": 49133},
}


def spring(key: str, year: int, as_of: dt.date, fetch=None) -> list:
    """The year's sightings so far: [id, year, doy, lat, lng, flags], by day. `fetch` is build_live.season_sightings;
    the nightly job hands over its own copy (it runs as __main__, so importing it here would load a second one)."""
    if fetch is None:
        from live import build_live  # here, not above: build_live imports this module for the nightly file
        fetch = build_live.season_sightings
    end = min(as_of, dt.date(year, 1, 1) + dt.timedelta(days=FRONT_END - 1))
    return fetch(year, end, [None] * len(BANDS), SPECIES[key]["taxon"], last_doy=FRONT_END)


def live_front(season: int, as_of: dt.date, prev: dict | None = None, fetch=None) -> dict:
    """What the nightly file's `front` holds: per species, this season's sightings so far. A species whose iNat pull
    fails keeps its entry from `prev` (last night's) so a dead night never empties the map."""
    out = {}
    for key in SPECIES:
        try:
            rows = spring(key, season, as_of, fetch)
        except Exception as e:  # noqa: BLE001 - one species must never stop the forecast
            print(f"WARNING: front {key} failed ({e}); keeping the previous file's", flush=True)
            if prev and key in prev:
                out[key] = prev[key]
            continue
        out[key] = {"season": season, "as_of": as_of.isoformat(), "sightings": rows}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("key", choices=SPECIES)
    a = ap.parse_args(argv)
    sp = SPECIES[a.key]
    years = list(range(FIRST_YEAR, LAST_YEAR + 1))
    rows = []
    for y in years:
        got = spring(a.key, y, dt.date(y, 12, 31))
        print(f"  {y}: {len(got)} sightings", flush=True)
        rows += got
    out = ROOT / "public" / "species" / a.key / "front.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = {"version": 1, "kind": "front", "key": a.key, "species": {"name": sp["name"], "sci": sp["sci"], "inat_taxon": sp["taxon"]},
           "generated": dt.date.today().isoformat(), "years": years, "end_doy": FRONT_END, "sightings": rows}
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB, {len(rows)} sightings)")


if __name__ == "__main__":
    main()
