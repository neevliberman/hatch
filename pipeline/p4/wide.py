"""Eastern North America inputs for P4: luna records outside the Midwest, a gridded effort background,
and the latitude-sliding brood cut-off (FROZEN_P4.md).

Raw downloads are cached in notebooks/data/wide/ (gitignored).
"""
import time

import h3
import numpy as np
import pandas as pd

from . import WIDE
from fit import data as FD
from hatch_p1 import inat
from hatch_p1.brood import brood_cutoff
from hatch_p1.prep import RES

TAXON = 47916
BOX = dict(swlat=25, nelat=50, swlng=-100, nelng=-60)    # what is downloaded
LAT_LO, LAT_HI = 31.0, 49.0                              # what is used (no Florida / Gulf coast: flies before 1 March)
LNG_LO, LNG_HI = -100.0, -60.0
RECORDS = WIDE / "luna_wide.parquet"
EFFORT = WIDE / "effort_grid.parquet"
G_LAT0, G_LNG0, G_DLAT, G_DLNG, G_NLNG = 25, -100, 2, 4, 10   # effort grid: 2 x 4 degree cells
SECTOR_W = 6.0                                           # region cells: 2 degree band x 6 degree longitude sector


# ---------------------------------------------------------------- downloads
def _get(path, params, tries=8):
    """inat._get plus retries on dropped connections (a reset mid-read is an OSError it does not catch)."""
    for k in range(tries):
        try:
            return inat._get(path, params)
        except (OSError, RuntimeError):
            time.sleep(2 ** min(k, 5))
    raise RuntimeError(f"iNat failed: {path}")


def fetch_records(out=RECORDS):
    """All luna observations in BOX, 2015-2026, P1's columns plus license_code (id_above paging, 1 s apart).
    Checkpoints every 25 pages to out.parent/parts/, so a dropped connection resumes where it stopped."""
    if out.exists():
        return pd.read_parquet(out)
    parts_dir = out.parent / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    done = sorted(parts_dir.glob("part_*.parquet"))
    last = int(pd.read_parquet(done[-1]).id.max()) if done else 0
    rows = []
    while True:
        js = _get("observations", {"taxon_id": TAXON, **BOX, "d1": "2015-01-01", "d2": "2026-12-31",
                                   "per_page": 200, "order_by": "id", "order": "asc", "id_above": last})
        res = js["results"]
        for o in res:
            r = inat._row(o)
            r["license_code"] = o.get("license_code")
            rows.append(r)
        if res:
            last = res[-1]["id"]
        if rows and (len(rows) >= 5000 or not res):
            pd.DataFrame(rows).to_parquet(parts_dir / f"part_{last:012d}.parquet")
            rows = []
        if not res:
            break
        time.sleep(1)
    df = pd.concat([pd.read_parquet(f) for f in sorted(parts_dir.glob("part_*.parquet"))], ignore_index=True)
    df = df.drop_duplicates("id")
    df.to_parquet(out)
    return df


def fetch_effort(out=EFFORT):
    """Daily verifiable moth records (Lepidoptera minus butterflies) per 2 x 4 degree cell, 2015-2026.
    One histogram call per cell covers every year."""
    if out.exists():
        return pd.read_parquet(out)
    parts = []
    for lat in range(G_LAT0, 50, G_DLAT):
        for lng in range(G_LNG0, -60, G_DLNG):
            js = _get("observations/histogram", {
                "taxon_id": FD.LEPIDOPTERA, "without_taxon_id": FD.BUTTERFLIES, "swlat": lat, "nelat": lat + G_DLAT,
                "swlng": lng, "nelng": lng + G_DLNG, "date_field": "observed", "interval": "day",
                "verifiable": "true", "d1": "2015-01-01", "d2": "2026-12-31"})
            day = js["results"]["day"]
            parts.append(pd.DataFrame({"lat0": lat, "lng0": lng, "date": list(day), "n": list(day.values())}))
            time.sleep(1)
    df = pd.concat(parts, ignore_index=True)
    df["date"] = df["date"].astype(str).str[:10]
    df.to_parquet(out)
    return df


# ---------------------------------------------------------------- cells
def effort_cell(lat, lng):
    i = np.floor((np.asarray(lat, float) - G_LAT0) / G_DLAT).astype(int)
    j = np.floor((np.asarray(lng, float) - G_LNG0) / G_DLNG).astype(int)
    return i * G_NLNG + j


def n_effort_cells():
    return ((50 - G_LAT0) // G_DLAT + 1) * G_NLNG


def region_cell(lat, lng):
    """'33-35/-90' style label: 2 degree latitude band x 6 degree longitude sector."""
    b = (np.floor((np.asarray(lat, float) - LAT_LO) / 2) * 2 + LAT_LO).astype(int)
    s = (np.floor((np.asarray(lng, float) - LNG_LO) / SECTOR_W) * SECTOR_W + LNG_LO).astype(int)
    return np.array([f"{x}-{x + 2}/{y}" for x, y in zip(b, s)])


def cell_lat(label):
    return int(str(label).split("-")[0]) + 1.0


def effort_grid_matrix(effort, years, floor=1.0):
    """E[effort cell, year, day index] (day index i = calendar doy i + 1), plus a floor."""
    e = np.zeros((n_effort_cells(), len(years), 365))
    y0 = int(years[0])
    cell = effort_cell(effort.lat0 + 0.5, effort.lng0 + 0.5)
    for c, date, n in zip(cell, effort.date, effort.n):
        y, doy = FD.iso_day(date)
        if 0 <= y - y0 < len(years) and doy <= 365:
            e[c, y - y0, doy - 1] = n
    return e + floor


# ---------------------------------------------------------------- brood cut-off
SLIDE = 5.0   # days per degree of latitude the between-brood dip moves (FROZEN_P4.md)


def wide_cutoff(doy, lat, min_n=20):
    """P1's dip rule with the search window slid by latitude: [150, 220] at 42 N, 5 days earlier per degree south.
    Returns the last first-brood day of year, or 240 when there is no split (or too few records)."""
    doy = np.asarray(doy, int)
    if len(doy) < min_n:
        return 240
    shift = SLIDE * (42.0 - lat)
    lo, hi = int(max(90, 150 - shift)), int(min(240, 220 - shift))
    c = brood_cutoff(doy, lo=lo, hi=hi)
    return int(c) if c is not None else 240


# ---------------------------------------------------------------- records
def clean_wide(raw, years=(2015, 2025)):
    """P1's frozen filters on the wide download, one record per observer + res-4 hex + local date,
    inside LAT_LO..LAT_HI, LNG_LO..LNG_HI. No band column (cells come from region_cell)."""
    d = raw.copy()
    d["date"] = pd.to_datetime(d["observed_on"], errors="coerce")
    d = d.dropna(subset=["date", "lat", "lng"])
    d["year"] = d["date"].dt.year
    d["doy"] = d["date"].dt.dayofyear
    d["yday"] = d["doy"]
    keep = ((d.quality_grade == "research") & ~d.captive.fillna(False).astype(bool)
            & ~d.obscured.fillna(False).astype(bool) & (d.accuracy_m.isna() | (d.accuracy_m <= 5000))
            & (d.life_stage.isna() | (d.life_stage == "adult")) & d.year.between(*years)
            & d.lat.between(LAT_LO, LAT_HI, inclusive="left") & d.lng.between(LNG_LO, LNG_HI, inclusive="left"))
    d = d[keep].copy()
    d["hex"] = [h3.latlng_to_cell(a, b, RES) for a, b in zip(d.lat, d.lng)]
    return d.drop_duplicates(["user_id", "hex", "date"])


def outside_midwest(d, midwest_ids):
    """Drop records already in the Midwest set, and any other record inside a Midwest state polygon."""
    d = d[~d.id.isin(set(midwest_ids))]
    paths = FD._state_paths()
    pts = np.column_stack([d.lng.to_numpy(float), d.lat.to_numpy(float)])
    inside = np.zeros(len(d), bool)
    for ps in paths.values():
        for p in ps:
            inside |= p.contains_points(pts)
    return d[~inside]
