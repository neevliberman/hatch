"""Sighting dots for every Atlas species: public/atlas/dots/<species index>.bin, one small file each, fetched only when
that species is on the map.

The colours are the network's expectation; the dots are the photos themselves (iNaturalist research grade, via
GBIF, after load_records' burst filter: one per observer, species, warmth cell and day), in the map's seven states.
A typical year draws the photos of FIRST_YEAR-LAST_YEAR (the years the network learned from) on their day of the
year; YEAR draws its own.
Each part keeps at most CAP photos, a random sample (fixed seed), so the busiest species stay readable and small.

<i>.bin, n photos sorted by year then day, as parallel little-endian arrays:
  uint32 iNaturalist observation id [n] | uint16 day of year (data.py's, 29 Feb kept) [n] | uint16 lat [n] |
  uint16 lng [n] | uint8 year - 2000 [n]
  lat/lng: 0-65535 across config.BOX (about 22 m by 29 m steps).
Analogy: the map is the weather forecast; the dots are the rain gauges.
  python3 pipeline/atlas/dots.py           # needs the records through YEAR (fetch_gbif.py 2015 2026)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas.config import BOX, FIRST_YEAR, LAST_YEAR  # noqa: E402
OUT = ROOT / "public/atlas"
YEAR = 2026  # export.YEAR (export.py needs torch)

CAP = 5_000
STATES = ("Minnesota", "Wisconsin", "Michigan", "Iowa", "Illinois", "Indiana", "Ohio")
Q = 65_535


def pack(df):
    df = df.sort_values(["year", "doy"], kind="stable")
    lat = np.round((df.lat.to_numpy() - BOX["s"]) / (BOX["n"] - BOX["s"]) * Q)
    lng = np.round((df.lng.to_numpy() - BOX["w"]) / (BOX["e"] - BOX["w"]) * Q)
    return b"".join([
        df.inat_id.to_numpy().astype("<u4").tobytes(),
        df.doy.to_numpy().astype("<u2").tobytes(),
        np.clip(lat, 0, Q).astype("<u2").tobytes(),
        np.clip(lng, 0, Q).astype("<u2").tobytes(),
        (df.year.to_numpy() - 2000).astype("u1").tobytes(),
    ])


def main():
    species = json.loads((OUT / "species.json").read_text())
    df = D.load_records(last_year=YEAR)
    df = df[df.taxon.notna() & df.inat_id.notna() & ((df.year <= LAST_YEAR) | (df.year == YEAR))]
    df = df[df.year >= FIRST_YEAR]
    df = df[df.state.isin(STATES)]  # the seven states the map shows (the box also takes in its neighbours' corners)
    by = {name: g for name, g in df.groupby("taxon")}
    out = OUT / "dots"
    out.mkdir(exist_ok=True)
    for f in out.glob("*.bin"):
        f.unlink()
    total = shown = 0
    for i, s in enumerate(species):
        g = by.get(s["name"])
        if g is None:  # an empty file, so the page never asks for one that isn't there
            (out / f"{i}.bin").write_bytes(b"")
            continue
        parts = [p.sample(CAP, random_state=i) if len(p) > CAP else p
                 for p in (g[g.year <= LAST_YEAR], g[g.year == YEAR])]
        keep = pd.concat(parts)
        (out / f"{i}.bin").write_bytes(pack(keep))
        total += len(g)
        shown += len(keep)
    size = sum(f.stat().st_size for f in out.glob("*.bin"))
    print(f"{len(list(out.glob('*.bin')))} species, {shown:,} of {total:,} photos, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
