#!/usr/bin/env python3
"""Freeze the eastern heat clock for 2027 (run once, offline): writes pipeline/league/east_static.json.

The clock (tryouts/REGIONAL_RESULT.md): each eastern place remembers how much warmth (degree-days above 10 C since
1 March, P3's measure) had piled up by its moths' onset and peak in past seasons; a season's forecast is the day that
season's warmth reaches the same pile. This script fixes, from every 2015-2025 season, everything east.py needs at
night, so the nightly job never touches the 67k-record download:
- places: the 2 x 6 degree cells outside the Midwest with at least one scored season (20+ first-brood records);
- per place: its 8 most-recorded hexes and their weights (8 score the same as all: 4.72 vs 4.73 d), brood cut-off
  (P4's), warmth targets for onset and peak, calendar dates (its mean onset and peak), seasons scored;
- per hex: the Daymet-minus-PRISM offset per month (as live/prism_offsets.json);
- per place and 2015-2025 year: daily degree-days from 1 March, the 11 weather endings for the rest of a season.

Run: python3 pipeline/league/build_east.py   (~10 min: loads P4's data, then 11 years of PRISM per hex from ACIS)
"""
import json
import sys
import time
from pathlib import Path

import h3
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "tryouts"))
import clock as C  # noqa: E402
import regional as G  # noqa: E402

OUT = HERE / "east_static.json"
ACIS = "https://data.rcc-acis.org/GridData"
TOP_HEXES = 8
FIRST_DOY = 60                                   # live/scorecard.py


def prism_ok(h, tries=3):
    """Whether PRISM (US only) has this hex. ACIS answers a point outside it with an empty body, which the shared
    reader retries for half a minute, so a 3-day probe asks first. Inside: its 2015-2025 history is cached."""
    import urllib.request
    from live import build_static
    lat, lng = h3.cell_to_latlng(h)
    url = f"{ACIS}?loc={lng:.4f},{lat:.4f}&sdate=2020-06-01&edate=2020-06-03&grid=21&elems=maxt&output=json"
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                body = r.read()
            break
        except OSError:
            time.sleep(5 * (i + 1))
    else:
        raise SystemExit(f"ACIS unreachable for {h}")
    if not body.strip():
        return False
    vals = [v for _, v in json.loads(body).get("data", [])]
    if not vals or any(v in (-999, "M", None) for v in vals):     # outside the grid, or over water
        return False
    build_static._prism_hist(h)
    return True


def places(usable=None):
    """usable(hex) -> bool: hexes the nightly weather can reach (PRISM covers the US only)."""
    rec = G.D.rec
    cuts = G.R4._wide_cuts(rec)                                 # doy, from every season
    fb = G.R4._with_cut(rec[rec.region != "mw"], {}, cuts)
    fb = fb[fb.doy >= FIRST_DOY]                 # as the grader (scorecard.FIRST_DOY): nothing before 1 March counts
    out = {}
    for cell, g in fb.groupby("region"):
        years = [(int(y), t) for y, t in g.groupby("year").t if len(t) >= G.EV.MIN_N]
        if not years:
            continue
        hx, w = G.EV.hex_weights(g)
        if usable is not None:
            keep = np.array([usable(G.D.hexes[h]) for h in hx[:4 * TOP_HEXES]] + [False] * max(0, len(hx) - 4 * TOP_HEXES))
            hx, w = hx[keep], w[keep]
            if not len(hx):
                continue                                # a Canadian place: no PRISM, so no nightly forecast
        hx, w = hx[:TOP_HEXES], w[:TOP_HEXES] / w[:TOP_HEXES].sum()
        y0 = int(G.D.years[0])
        tgt = {q: float(np.mean([C.dd_at(C.heat(hx, w, y - y0), t.quantile(.1 if q == "onset" else .5))
                                 for y, t in years])) for q in ("onset", "peak")}
        out[cell] = {"hexes": [G.D.hexes[h] for h in hx], "weights": [round(float(v), 4) for v in w],
                     "cutoff": int(cuts[cell]), "seasons": [y for y, _ in years], "records": int(len(g)),
                     "target_dd": {q: round(v, 1) for q, v in tgt.items()},
                     # day index (t) + 1 = day of year, the scorecard's unit
                     "calendar": {q: round(float(np.mean([t.quantile(.1 if q == "onset" else .5) for _, t in years]))
                                           + 1, 2) for q in ("onset", "peak")},
                     "climate_dd": [[round(float(v), 1) for v in
                                     (w[:, None] * G.R4.inc_cube((G.R4.BASE, G.R4.UPPER, 0))[hx, yi, G.D0:G.D1]).sum(0)]
                                    for yi in range(len(G.D.years))]}
    return out


def main():
    G.load()
    seen = {}
    pl = places(lambda h: seen.setdefault(h, prism_ok(h)))
    print(f"{sum(seen.values())}/{len(seen)} candidate hexes inside PRISM", flush=True)
    hexes = sorted({h for p in pl.values() for h in p["hexes"]})
    from live import build_static
    off = build_static.prism_offsets(hexes)      # every hex's PRISM history is cached by now
    if np.isnan(np.array(off, float)).any():
        raise SystemExit("a hex has no PRISM-Daymet offset for some month; the nightly weather would be NaN there")
    static = {"version": 1, "model": "east-clock-v1", "years": [int(y) for y in G.D.years],
              "first_day_index": G.D0, "base_c": G.R4.BASE, "upper_c": G.R4.UPPER,
              "note": "eastern heat clock frozen for 2027 (EAST_2027.md); built by build_east.py",
              "places": pl, "offsets": {"hexes": hexes, "offsets": off}}
    OUT.write_text(json.dumps(static, separators=(",", ":")) + "\n")
    print(f"wrote {OUT.name}: {len(pl)} places, {len(hexes)} hexes, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
