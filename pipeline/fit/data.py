"""Inputs for the P3 fit: cleaned luna records, states, effort background, temperatures.

Raw downloads are cached in notebooks/data/ (gitignored). Nothing here runs in tests
except the pure helpers (iso_day, state_of, daylength_hours, effort_matrix).
"""
import datetime as dt
import json
import time

import h3
import numpy as np
import pandas as pd
from matplotlib.path import Path as MPath

from . import DATA, ROOT
from hatch_p1 import inat
from hatch_p1.prep import clean

# iNat place ids, same order as hatch_p1.inat.MIDWEST_PLACES
STATE_PLACES = {"WI": 32, "IL": 35, "MN": 38, "IA": 24, "MI": 29, "IN": 20, "OH": 31}
STATES = list(STATE_PLACES)
LEPIDOPTERA, BUTTERFLIES = 47157, 47224   # background = moths: Lepidoptera minus Papilionoidea
RAW_LUNA = DATA / "luna_replay_inat.parquet"   # written by pipeline/replay (P1 columns + license_code)
EFFORT = DATA / "p3_moth_effort_by_state.parquet"
STATES_GEOJSON = ROOT / "src" / "data" / "midwest-states.json"


# ---------------------------------------------------------------- dates
def iso_day(observed_on: str):
    """(year, calendar day-of-year) of iNat's local `observed_on` ISO date.

    Never derived from a UTC timestamp: a 9:45 pm sighting in Ohio on 1 June is
    2 June in UTC, but it is 1 June for the moth and for us.
    """
    d = dt.date.fromisoformat(str(observed_on)[:10])
    return d.year, d.timetuple().tm_yday


# ---------------------------------------------------------------- states
def _state_paths(path=STATES_GEOJSON):
    gj = json.loads(path.read_text())
    out = {}
    for f in gj["features"]:
        ab = f["properties"]["abbr"]
        if ab not in STATE_PLACES:
            continue
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        out[ab] = [MPath(np.asarray(p[0])) for p in polys]   # outer rings (lng, lat)
    return out


def state_of(lat, lng, paths=None):
    """State abbreviation for each point; points outside every polygon go to the nearest one."""
    paths = paths or _state_paths()
    pts = np.column_stack([np.asarray(lng, float), np.asarray(lat, float)])
    res = np.array([None] * len(pts), dtype=object)
    for ab, ps in paths.items():
        inside = np.zeros(len(pts), bool)
        for p in ps:
            inside |= p.contains_points(pts)
        res[inside & (res == None)] = ab  # noqa: E711
    for i in np.where(res == None)[0]:  # noqa: E711
        best = min(((np.min(np.hypot(*(p.vertices - pts[i]).T)), ab) for ab, ps in paths.items() for p in ps))
        res[i] = best[1]
    return res


# ---------------------------------------------------------------- daylength
def daylength_hours(lat, doy):
    """Daylength (sunrise to sunset, sun's top at the horizon) by the CBM model
    (Forsythe et al. 1995, p = 0.8333). Broadcasts over lat and doy."""
    lat = np.radians(np.asarray(lat, float))
    doy = np.asarray(doy, float)
    theta = 0.2163108 + 2 * np.arctan(0.9671396 * np.tan(0.00860 * (doy - 186)))
    phi = np.arcsin(0.39795 * np.cos(theta))
    p = np.radians(0.8333)
    x = (np.sin(p) + np.sin(lat) * np.sin(phi)) / (np.cos(lat) * np.cos(phi))
    return 24 - 24 / np.pi * np.arccos(np.clip(x, -1, 1))


# ---------------------------------------------------------------- records
def luna_records(raw=None):
    """P1-cleaned luna records (frozen filters, one per observer+hex+day) plus state and hex latitude."""
    raw = pd.read_parquet(RAW_LUNA) if raw is None else raw
    d = clean(raw).copy()
    d["state"] = state_of(d.lat.to_numpy(), d.lng.to_numpy())
    d["hex_lat"] = [h3.cell_to_latlng(h)[0] for h in d.hex]
    return d


# ---------------------------------------------------------------- effort background
def fetch_effort(years=range(2015, 2026), out=EFFORT, refresh=False):
    """Daily verifiable moth observations (Lepidoptera minus butterflies) per state.

    77 histogram calls (7 states x 11 years), 1 s apart. Cached.
    """
    if out.exists() and not refresh:
        return pd.read_parquet(out)
    parts = []
    for ab, place in STATE_PLACES.items():
        for y in years:
            js = inat._get("observations/histogram", {
                "taxon_id": LEPIDOPTERA, "without_taxon_id": BUTTERFLIES, "place_id": place,
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


def effort_matrix(effort, years, states=STATES, floor=1.0):
    """E[state, year, day index] = moth records that day + floor (day index i = calendar doy i + 1)."""
    e = np.zeros((len(states), len(years), 365))
    si = {s: i for i, s in enumerate(states)}
    y0 = int(years[0])
    for s, date, n in effort[["state", "date", "n"]].itertuples(index=False):
        y, doy = iso_day(date)
        if s in si and 0 <= y - y0 < len(years) and doy <= 365:
            e[si[s], y - y0, doy - 1] = n
    return e + floor
