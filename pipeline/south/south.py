#!/usr/bin/env python3
"""Southern shadow track: a local heat clock forecasts when Christmas beetles (Anoplognathus) first show and peak
in each cell of eastern and southern Australia, graded against each cell's calendar (SOUTH_2026.md).
Nothing here reaches the map; it tests the "local heat clock" recipe for a brand-new region, in the hemisphere
whose spring is happening now.

Analogy: the same kitchen timer as the eastern track, but set in a kitchen on the other side of the world.

Each night (the south-forecast workflow, or by hand):
1. Weather: Open-Meteo archive Tmin/Tmax at each cell's record-weighted centre from 1 July to about three days ago,
   then the forecast API for the 7 days after that (about 4 of them still ahead); the rest of the season is each 2018-2025 year's warmth as one of 8 endings (south_static.json).
2. Forecast: per cell, the day the season's warmth reaches the cell's frozen onset / peak pile; the median over the
   endings is the forecast, the 10th-90th percentile its spread. Saved to <live>/archive_south/<season>/<issued>.json.
3. Grading (Mondays, and whenever no table exists): one pull of the season's research-grade records, each cell scored
   once it has 20+ records, against the newest sealed forecast issued 7+ days before the real date.

Run by hand: python3 pipeline/south/south.py --live live --season 2026 [--today 2027-02-22]
"""
import argparse
import datetime as dt
import gzip
import hashlib
import io
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
STATIC = HERE / "south_static.json"
TAXON = 201869                                          # Anoplognathus
BOX = {"swlat": -44, "swlng": 112, "nelat": -10, "nelng": 154}
BASE_C, UPPER_C = 6.0, 30.0                             # degree-day base and cap (SOUTH_2026.md)
FIRST_DOY = 60                                          # days after 1 July; earlier records are strays
LAST_DOY = 260
CELL_DEG = 2
MIN_N = 20
LEAD_DAYS = 7
ARCHIVE_LAG = 3
FORECAST_DAYS = 7
MARGIN, MIN_CELLS, MIN_RECORDS = 1.0, 8, 800            # SOUTH_2026.md
SETTLE = dt.date(2027, 2, 15)                           # verdict: the week of this day; later records never count
SEASONS = (2026,)                                       # season = 1 Jul of that year to 30 Jun
LAYER = "south"


# ---------------------------------------------------------------- small helpers
def _get(url, tries=6, pause=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(pause * (i + 1))


def write_atomic(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def season_start(season: int) -> dt.date:
    return dt.date(season, 7, 1)


def cell_of(lat, lng):
    """2-degree cell id: its south-west corner, '<lat>_<lng>' as whole degrees."""
    return (np.floor(np.asarray(lat) / CELL_DEG) * CELL_DEG).astype(int).astype(str) + "_" + \
        (np.floor(np.asarray(lng) / CELL_DEG) * CELL_DEG).astype(int).astype(str)


def inc(tmin, tmax):
    """Daily degree-days above BASE_C: mean of the day's extremes, capped at UPPER_C."""
    t = (np.minimum(np.asarray(tmin, float), UPPER_C) + np.minimum(np.asarray(tmax, float), UPPER_C)) / 2
    return np.maximum(t - BASE_C, 0.0)


def reach(dd, target):
    """Fractional day index at which cumulative dd reaches target (interpolated within the day)."""
    i = int(np.searchsorted(dd, target))
    if i == 0:
        return 0.0
    if i >= len(dd):
        return float(len(dd) - 1)
    return i - 1 + (target - dd[i - 1]) / (dd[i] - dd[i - 1])


# ---------------------------------------------------------------- data
def fetch_records(d1: dt.date, d2: dt.date, pause=0.8) -> pd.DataFrame:
    """Research-grade Anoplognathus records in Australia observed d1..d2: id, date, lat, lng, created_at."""
    rows, last = [], 0
    while True:
        p = {"taxon_id": TAXON, **BOX, "quality_grade": "research", "d1": d1.isoformat(), "d2": d2.isoformat(),
             "per_page": 200, "order_by": "id", "order": "asc", "id_above": last, "geoprivacy": "open",
             "fields": "id,observed_on,location,created_at"}
        res = _get("https://api.inaturalist.org/v1/observations?" + urllib.parse.urlencode(p))["results"]
        if not res:
            break
        for o in res:
            if o.get("observed_on") and o.get("location"):
                la, ln = map(float, o["location"].split(","))
                rows.append((o["id"], o["observed_on"], la, ln, (o.get("created_at") or "")[:10]))
        last = res[-1]["id"]
        time.sleep(pause)
    df = pd.DataFrame(rows, columns=["id", "date", "lat", "lng", "created_at"])
    df["date"] = pd.to_datetime(df["date"])
    return df


def with_cells(df: pd.DataFrame, season: int) -> pd.DataFrame:
    """Add cell and doy (days after 1 July of `season`); keep the scoring window."""
    d = df.assign(cell=cell_of(df.lat, df.lng) if len(df) else [], doy=(df.date - pd.Timestamp(season_start(season))).dt.days)
    return d[d.doy.between(FIRST_DOY, LAST_DOY)]


def archive_weather(lat, lng, start: dt.date, end: dt.date):
    u = "https://archive-api.open-meteo.com/v1/archive?" + urllib.parse.urlencode(
        {"latitude": round(lat, 2), "longitude": round(lng, 2), "start_date": start.isoformat(),
         "end_date": end.isoformat(), "daily": "temperature_2m_max,temperature_2m_min", "timezone": "auto"})
    d = _get(u)["daily"]
    return np.array(d["temperature_2m_min"], float), np.array(d["temperature_2m_max"], float)


def forecast_weather(lat, lng, start: dt.date, end: dt.date):
    u = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(
        {"latitude": round(lat, 2), "longitude": round(lng, 2), "start_date": start.isoformat(),
         "end_date": end.isoformat(), "daily": "temperature_2m_max,temperature_2m_min", "timezone": "auto"})
    d = _get(u)["daily"]
    return np.array(d["temperature_2m_min"], float), np.array(d["temperature_2m_max"], float)


def load_static(path=STATIC):
    return json.loads(path.read_text())


def model_of(path=STATIC):
    return {"id": "south-clock-v1", "hash": sha256(path)[:12]}


# ---------------------------------------------------------------- nightly forecast
def season_inc(cell_info, season, as_of: dt.date, fetch_obs=None, fetch_fc=None):
    """Observed (to as_of) then forecast degree-days for one cell from 1 July: -> (array, last day covered)."""
    fetch_obs = fetch_obs or archive_weather
    fetch_fc = fetch_fc or forecast_weather
    start = season_start(season)
    la, ln = cell_info["lat"], cell_info["lng"]
    if as_of < start:
        return np.zeros(0), start - dt.timedelta(days=1)
    tmin, tmax = fetch_obs(la, ln, start, as_of)
    good = ~(np.isnan(tmin) | np.isnan(tmax))
    n_obs = int(np.argmin(good)) if not good.all() else len(good)
    if good[n_obs:].any():
        raise RuntimeError(f"south: {cell_info['lat']},{cell_info['lng']} has holes inside the observed weather")
    out = inc(tmin[:n_obs], tmax[:n_obs])               # the archive's newest days can still be empty: drop them
    as_of = start + dt.timedelta(days=n_obs - 1)
    end = as_of
    f0, f1 = as_of + dt.timedelta(days=1), as_of + dt.timedelta(days=FORECAST_DAYS)
    fmin, fmax = fetch_fc(la, ln, f0, f1)
    ok = ~(np.isnan(fmin) | np.isnan(fmax))
    n_ok = int(np.argmin(ok)) if not ok.all() else len(ok)
    out = np.concatenate([out, inc(fmin[:n_ok], fmax[:n_ok])])
    return out, end + dt.timedelta(days=n_ok)


def forecast(static, seen_by_cell):
    """Per cell: onset / peak day (days after 1 July; median over endings) and the 10-90% spread."""
    out = []
    for c, p in static["cells"].items():
        seen = seen_by_cell[c]
        members = {"onset": [], "peak": []}
        for clim in p["climate_dd"]:
            clim = np.asarray(clim, float)
            dd = np.cumsum(np.concatenate([seen, clim[len(seen):]]))
            for q in members:
                members[q].append(reach(dd, p["target_dd"][q]))
        row = {"band": c}
        for q, m in members.items():
            row[q] = round(float(np.median(m)), 1)
            row[f"{q}_lo"], row[f"{q}_hi"] = (round(float(v), 1) for v in np.percentile(m, [10, 90]))
        out.append(row)
    return out


def sealed_entry(static, season, as_of: dt.date, issued: dt.date, model, fetch_obs=None, fetch_fc=None):
    seen, ends = {}, []
    for c, p in static["cells"].items():
        seen[c], e = season_inc(p, season, as_of, fetch_obs, fetch_fc)
        ends.append(e)
    return {"version": 1, "season": season, "issued": issued.isoformat(), "as_of": as_of.isoformat(),
            "forecast_through": min(ends).isoformat(), "model": model, "bands": forecast(static, seen)}


def nightly(live: Path, season: int, today: dt.date, static_path=STATIC, fetch_obs=None, fetch_fc=None):
    """Tonight's sealed envelope -> the path written, or None outside the track's season."""
    if season not in SEASONS or today < season_start(season) or today > SETTLE + dt.timedelta(days=7):
        return None
    p = live / "archive_south" / str(season) / f"{today.isoformat()}.json"
    if p.exists():
        return p                                        # sealed means sealed: a rerun never rewrites a night
    entry = sealed_entry(load_static(static_path), season, today - dt.timedelta(days=ARCHIVE_LAG), today,
                         model_of(static_path), fetch_obs, fetch_fc)
    write_atomic(p, (json.dumps(entry, separators=(",", ":"), allow_nan=False) + "\n").encode())
    return p


def load_archive(live: Path, season: int):
    d = live / "archive_south" / str(season)
    return [json.loads(f.read_text()) for f in sorted(d.glob("*.json"))] if d.exists() else []


# ---------------------------------------------------------------- weekly grading
def week_start(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())


def newest_before(entries, model, cell, quantity, real_day: float, season: int):
    """The forecast (day after 1 July) of the newest sealed entry issued at least LEAD_DAYS before the real date."""
    cutoff = season_start(season) + dt.timedelta(days=int(np.floor(real_day)) - LEAD_DAYS)
    best = None
    for e in entries:
        if e.get("model") != model or dt.date.fromisoformat(e["issued"]) > cutoff:
            continue
        for b in e["bands"]:
            if b["band"] == cell:
                best = (e["issued"], b[quantity])
    return best


def score_cell(cell, recs, p, season, entries, model):
    r = recs[recs.cell == cell]
    if len(r) < MIN_N:
        return {"band": cell, "status": "too_few", "n": int(len(r))}
    real = {"onset": float(r.doy.quantile(0.1)), "peak": float(r.doy.median())}
    miss, cal = {}, {}
    for q in real:
        f = newest_before(entries, model, cell, q, real[q], season)
        if f is None:
            return {"band": cell, "status": "no_forecast_in_time", "n": int(len(r))}
        miss[q] = abs(f[1] - real[q])
        cal[q] = abs(p["calendar"][q] - real[q])
    return {"band": cell, "status": "scored", "n": int(len(r)),
            "onset": round(real["onset"], 1), "peak": round(real["peak"], 1),
            "miss": round((miss["onset"] + miss["peak"]) / 2, 1),
            "calendar_miss": round((cal["onset"] + cal["peak"]) / 2, 1)}


def tally(rows, draws=2000):
    sc = [r for r in rows if r.get("status") == "scored"]
    n = sum(r["n"] for r in sc)
    if not sc:
        return {"cells": 0, "records": 0, "clock": None, "calendar": None, "D": None, "clock_wins": 0, "ties": 0,
                "D_unweighted": None, "D_interval_cells": None}
    w = np.array([r["n"] for r in sc], float)
    x = np.array([r["miss"] for r in sc], float)
    c = np.array([r["calendar_miss"] for r in sc], float)
    hx, hc = float((w * x).sum() / n), float((w * c).sum() / n)
    rng = np.random.default_rng(0)
    boot = [float((w[i] * (x[i] - c[i])).sum() / w[i].sum()) for i in rng.integers(0, len(sc), (draws, len(sc)))]
    return {"cells": len(sc), "records": n, "clock": round(hx, 2), "calendar": round(hc, 2),
            "D": round(hx - hc, 6), "clock_wins": int((x < c).sum()), "ties": int((x == c).sum()),
            "D_unweighted": round(float((x - c).mean()), 2),
            "D_interval_cells": [round(float(v), 2) for v in np.percentile(boot, [2.5, 97.5])]}


def decide(t, final):
    """SOUTH_2026.md. -> (verdict, reason)."""
    if not final:
        return "in_progress", "the verdict is given on the week of 15 Feb 2027"
    if t["cells"] < MIN_CELLS or t["records"] < MIN_RECORDS:
        return "no_verdict", f"fewer than {MIN_CELLS} scored cells or {MIN_RECORDS} records"
    if t["D"] <= -MARGIN and 2 * t["clock_wins"] >= t["cells"]:
        return "clock_wins", "the clock missed at least 1 day less and won at least half the cells"
    return "calendar_stays", "the clock did not clear the bar"


def grade(live: Path, season, today: dt.date, raw, static_path=STATIC):
    static = load_static(static_path)
    model = model_of(static_path)
    entries = [e for e in load_archive(live, season) if e.get("model") == model]
    monday = week_start(today)
    d = raw
    if len(d):
        posted = pd.to_datetime(d["created_at"], errors="coerce")
        d = d[posted.isna() | (posted <= pd.Timestamp(monday))]
        d = d[d.date <= pd.Timestamp(monday)]
    recs = with_cells(d, season) if len(d) else pd.DataFrame(columns=["cell", "doy"])
    rows = [score_cell(c, recs, p, season, entries, model) for c, p in static["cells"].items()]
    t = tally(rows)
    verdict, reason = decide(t, monday >= week_start(SETTLE))
    return {"version": 1, "kind": "league_south", "species": "Christmas beetles (Anoplognathus)", "season": season,
            "score_date": monday.isoformat(),
            "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "model": model, "nights": len(entries), "cells": rows, "tally": t, "verdict": verdict, "reason": reason,
            "verdict_date": SETTLE.isoformat(),
            "rule": {"margin_days": MARGIN, "min_cells": MIN_CELLS, "min_records": MIN_RECORDS,
                     "plain": "the clock counts as working in a new region only if its record-weighted miss is at "
                              "least 1 day lower than each cell's calendar and it wins at least half the scored cells"}}


def weekly_run(live: Path, season, today: dt.date, fetch=fetch_records, force=False, static_path=STATIC):
    """Once per scoring week (capped at the verdict week). -> the path written, or None."""
    if season not in SEASONS:
        return None
    today = min(today, SETTLE + dt.timedelta(days=6))
    out = live / "league_south.json"
    monday = week_start(today)
    if not force and out.exists():
        old = json.loads(out.read_text())
        if old.get("season") == season and old.get("score_date") == monday.isoformat():
            return None
    p = live / "records" / str(season) / "south" / f"{monday.isoformat()}.csv.gz"
    sidecar = p.with_suffix(".sha256")
    if p.exists() and sidecar.exists():
        if sidecar.read_text().split()[0] != sha256(p):
            raise RuntimeError(f"{p} does not match its sha256")
        raw = pd.read_csv(p, parse_dates=["date"])
    else:
        raw = fetch(season_start(season), today)
        older = sorted(q for q in p.parent.glob("*.csv.gz") if q.name < p.name)
        if older and len(raw) < 0.9 * len(pd.read_csv(older[-1])):
            raise RuntimeError(f"south records pull: {len(raw)} rows, under 90% of last week's; not saving it")
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
            gz.write(raw.to_csv(index=False).encode())
        write_atomic(p, buf.getvalue())
        write_atomic(sidecar, f"{sha256(p)}  {p.name}\n".encode())
    table = grade(live, season, today, raw, static_path)
    write_atomic(out, (json.dumps(table, separators=(",", ":"), allow_nan=False) + "\n").encode())
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--live", type=Path, required=True, help="the folder the archive and tables are written under (the south-data branch's live/)")
    ap.add_argument("--season", type=int)
    ap.add_argument("--today", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    ap.add_argument("--force", action="store_true", help="rerun this week's table even if it exists")
    a = ap.parse_args(argv)
    season = a.season or (a.today.year if a.today.month >= 7 else a.today.year - 1)
    p = nightly(a.live, season, a.today)
    print(f"south: {'archived ' + str(p) if p else 'no forecast tonight'}")
    if a.today.weekday() == 0 or not (a.live / "league_south.json").exists() or a.force:
        p = weekly_run(a.live, season, a.today, force=a.force)
        print(f"south: {'wrote ' + str(p) if p else 'no table due'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
