"""Build src/data/warmth-trend.json: is the same spring warmth arriving earlier at a few Midwest towns? (Daymet, public domain.)

For each town and year, the day the spot has banked MILESTONE_DD degree-days since 1 March (base 10 C, double-sine, the
luna moth model's own count: median target 225.6 degree-days). A straight line through those days gives days earlier per
decade, with its standard error. A year-to-year swing of about a week sits on top of a trend of a day or two a decade, so
only a few towns show a clear change: the About panel says so rather than drawing a line.
Run from the repo root (needs network the first time; Daymet downloads are cached in notebooks/data/drift/, git-ignored):
  python3 pipeline/drift/build_warmth.py
"""
import io
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
from hatch_p1.degree_days import accumulate  # noqa: E402

CACHE = ROOT / "notebooks/data/drift"
OUT = ROOT / "src/data/warmth-trend.json"
FIRST, LAST = 1980, 2024
MILESTONE_DD = 225.6
# North to south, so the chart reads like the map.
SITES = [
    ("Minneapolis", 44.98, -93.27), ("Madison", 43.07, -89.40), ("Detroit", 42.33, -83.05), ("Des Moines", 41.59, -93.62),
    ("Chicago", 41.88, -87.63), ("Columbus", 39.96, -83.00), ("Indianapolis", 39.77, -86.16), ("St. Louis", 38.63, -90.20),
]
URL = "https://daymet.ornl.gov/single-pixel/api/data?lat={}&lon={}&vars=tmax,tmin&start={}-01-01&end={}-12-31&format=csv"


def fetch(name, lat, lng):
    path = CACHE / f"{name.replace(' ', '_').replace('.', '')}.csv"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_bytes(urllib.request.urlopen(URL.format(lat, lng, FIRST, LAST), timeout=120).read())
    lines = path.read_text().split("\n")
    head = next(i for i, l in enumerate(lines) if l.startswith("year"))
    df = pd.read_csv(io.StringIO("\n".join(lines[head:])))
    df.columns = [c.split(" (")[0] for c in df.columns]
    return df


def milestone_days(df, dd=MILESTONE_DD):
    """{year: day of a 365-day calendar (1 = 1 Jan) the spot reaches `dd` degree-days}. Daymet drops 31 Dec in leap years
    and keeps 29 Feb, which holds no degree-days, so removing it lines every year up on the same calendar."""
    out = {}
    for year, g in df.groupby("year"):
        g = g[g["yday"] != 60] if len(g) == 365 and year % 4 == 0 else g
        g = g.sort_values("yday")
        cum = accumulate(g["tmin"].to_numpy()[None, :], g["tmax"].to_numpy()[None, :], 10.0)[0]
        hit = np.searchsorted(cum, dd)
        out[int(year)] = int(hit) + 1 if hit < len(cum) else None
    return out


def trend(days):
    """(days earlier per decade, its standard error) from {year: day}. Positive = earlier."""
    ys = np.array([y for y, d in days.items() if d is not None], float)
    ds = np.array([d for d in days.values() if d is not None], float)
    slope, icpt = np.polyfit(ys, ds, 1)
    resid = ds - (slope * ys + icpt)
    se = resid.std(ddof=2) / np.sqrt(((ys - ys.mean()) ** 2).sum())
    return -slope * 10, se * 10


def main():
    sites = []
    for name, lat, lng in SITES:
        per_decade, se = trend(milestone_days(fetch(name, lat, lng)))
        sites.append({"name": name, "lat": lat, "lng": lng, "perDecade": round(per_decade, 2), "se": round(se, 2)})
        print(f"{name:13s} {per_decade:+.2f} +/- {se:.2f} days earlier per decade")
    OUT.write_text(json.dumps({"years": [FIRST, LAST], "milestoneDD": MILESTONE_DD, "sites": sites}, indent=1) + "\n")


if __name__ == "__main__":
    main()
