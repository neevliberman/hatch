#!/usr/bin/env python3
"""Nightly live forecast: this season's luna moth first brood, per res-4 hex -> public/live/latest.json.

How one night's forecast is put together (analogy: finishing a sentence someone has started):
1. The words already said: real weather from 1 March to yesterday (PRISM, adjusted to the Daymet scale the model
   was fitted on, see build_static.py).
2. The next few words, fairly sure: a 7-day weather forecast (Open-Meteo).
3. The rest, unknown: each past year 2015-2025 of Daymet weather run forward from there, 11 possible endings.
Each of the 11 weather endings is run through each of the 11 leave-one-year-out fits of the frozen P3 model
(fold_fits.json, the same fits the replay uses), so 121 forecasts per hex. The median is the forecast; the spread,
widened by how far past forecasts actually missed (the replay's scored band-years), is the "likely" range.

Run: python3 pipeline/live/build_live.py --season 2026 --as-of 2026-06-01 [--no-forecast]
     python3 pipeline/live/build_live.py --auto     (what the nightly job runs; no-op outside 2 Mar..7 Oct)
"""
import argparse
import datetime as dt
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

import h3  # noqa: E402
from fit import data as fdata, model as M  # noqa: E402
from hatch_p1 import inat  # noqa: E402
from hatch_p1.daymet import temperature_cube  # noqa: E402
from hatch_p1.degree_days import double_sine  # noqa: E402
from hatch_p1.prep import BANDS, BAND_LABELS  # noqa: E402

from live import sources  # noqa: E402

REPLAY = ROOT / "src" / "data" / "luna-replay.json"
FOLD_FITS = ROOT / "pipeline" / "replay" / "fold_fits.json"
OUT = ROOT / "public" / "live" / "latest.json"
ANALOG_YEARS = (2015, 2025)
BASE, UPPER, START_DOY = 10.0, 30.0, 60
QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95]
MAX_DOY = 300
FORECAST_DAYS = 7
SEASON = ((3, 2), (10, 7))      # --auto runs between these (month, day) dates; outside, the last file stands
MAX_BAD_CELLS = 0.02            # more cells than this with no observed weather -> fail loudly
TAXON = 47916
LICENCES = ("cc0", "cc-by", "cc-by-nc")
SECOND_BROOD_FALLBACK = 240
APPROX_ACCURACY_M = 5000


# ---------------------------------------------------------------- small pure helpers (tested)
def day_index(d: dt.date) -> int:
    """Day index used by every cube: calendar day of year - 1 (so 1 March = 59 in non-leap years)."""
    return d.timetuple().tm_yday - 1


def first_reach(cdf, quantiles=QUANTILES, max_doy=MAX_DOY):
    """Calendar doy on which `cdf` (by day index) first reaches each quantile, else None (as build_replay.py)."""
    out = []
    for q in quantiles:
        i = int(np.searchsorted(cdf, q, side="left"))
        out.append(i + 1 if i + 1 <= max_doy and i < len(cdf) else None)
    return out


def band_index(lat):
    return np.clip(np.digitize(lat, BANDS[1:-1]), 0, len(BAND_LABELS) - 1)


def fill_gaps(x):
    """Fill NaN days in each row by linear interpolation in time (ends: nearest value). Rows all-NaN stay NaN."""
    x = np.array(x, float)
    t = np.arange(x.shape[-1])
    for row in x:
        ok = ~np.isnan(row)
        if ok.any() and not ok.all():
            row[~ok] = np.interp(t[~ok], t[ok], row[ok])
    return x


def ensemble_summary(days, resid):
    """days: [member, cell, quantile] doy (np.inf = never). resid: past real-minus-forecast errors (days).

    median: the members' median day (None if most members never get there).
    lo / hi: 10th / 90th percentile of (member day + past error) over every member x error pair: weather spread
    and model error together, so a date already fixed by real weather still carries the model's honest error.
    """
    med = np.quantile(days, 0.5, axis=0, method="inverted_cdf")
    tot = (days[:, None] + np.asarray(resid, float)[None, :, None, None]).reshape(-1, *days.shape[1:])
    lo = np.quantile(tot, 0.1, axis=0, method="inverted_cdf")
    hi = np.quantile(tot, 0.9, axis=0, method="inverted_cdf")

    def ints(a):
        return [[None if not np.isfinite(v) else int(round(v)) for v in row] for row in a]
    m = ints(med)
    lo_, hi_ = ints(lo), ints(hi)
    for i, row in enumerate(m):          # no range around a date the forecast itself calls "never"
        for k, v in enumerate(row):
            if v is None:
                lo_[i][k] = hi_[i][k] = None
    return m, lo_, hi_


# ---------------------------------------------------------------- weather
def observed(cells, start, end, offsets):
    """PRISM Tmin/Tmax for start..end per cell, plus the Daymet offset for each day's month. [cell, day]."""
    if end < start:
        return np.zeros((len(cells), 0)), np.zeros((len(cells), 0)), 0
    ll = [h3.cell_to_latlng(c) for c in cells]
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(lambda p: sources.prism_point(p[0], p[1], start, end), ll))
    tmin = np.array([g[0] for g in got])
    tmax = np.array([g[1] for g in got])
    months = np.array([d.month - 1 for d in sources.dates(start, end)])
    tmin += offsets[:, months, 0]
    tmax += offsets[:, months, 1]
    tmin, tmax = fill_gaps(tmin), fill_gaps(tmax)
    bad = np.isnan(tmin).any(1) | np.isnan(tmax).any(1)
    if bad.mean() > MAX_BAD_CELLS:
        raise SystemExit(f"PRISM: {bad.sum()}/{len(cells)} cells have no data for {start}..{end}; not writing.")
    good = np.where(~bad)[0]
    for i in np.where(bad)[0]:           # a rare all-missing cell borrows its nearest neighbour's weather
        j = min(good, key=lambda g: h3.great_circle_distance(ll[i], ll[g], "km"))
        tmin[i], tmax[i] = tmin[j], tmax[j]
    return tmin, tmax, int(bad.sum())


def last_prism_day(today):
    """Newest date PRISM has for a mid-Midwest point (it usually lags a day or two)."""
    tmin, tmax = sources.prism_point(41.9, -88.0, today - dt.timedelta(days=10), today)
    ok = np.where(~np.isnan(tmin) & ~np.isnan(tmax))[0]
    if not len(ok):
        raise SystemExit("PRISM has nothing for the last 10 days; not writing.")
    return today - dt.timedelta(days=10) + dt.timedelta(days=int(ok[-1]))


def check_temps(name, *arrs):
    for a in arrs:
        if a.size and (np.nanmin(a) < -45 or np.nanmax(a) > 50):
            raise SystemExit(f"{name}: temperature out of range ({np.nanmin(a):.1f}..{np.nanmax(a):.1f} C); not writing.")


# ---------------------------------------------------------------- sightings so far
def season_sightings(season, as_of, cutoffs):
    """This season's openly licensed luna sightings to date: [id, year, doy, lat, lng, flags].
    flags: bit0 second brood, bit1 approximate location, bit2 not yet confirmed (iNat 'needs ID')."""
    rows, last = [], 0
    while True:
        js = inat._get("observations", {
            "taxon_id": TAXON, "place_id": ",".join(map(str, inat.MIDWEST_PLACES)),
            "d1": f"{season}-03-01", "d2": as_of.isoformat(), "quality_grade": "research,needs_id",
            "license": ",".join(LICENCES), "captive": "false",
            "per_page": 200, "order_by": "id", "order": "asc", "id_above": last})
        res = js["results"]
        if not res:
            break
        for o in res:
            r = inat._row(o)
            if r["lat"] is None or not r["observed_on"]:
                continue
            if r["life_stage"] not in (None, "adult") or (o.get("license_code") or "").lower() not in LICENCES:
                continue
            rows.append(r)
        last = res[-1]["id"]
        time.sleep(1)
    out, seen = [], set()
    for r in rows:
        y, doy = fdata.iso_day(r["observed_on"])
        hexid = h3.latlng_to_cell(r["lat"], r["lng"], 4)
        key = (r["user_id"], hexid, r["observed_on"][:10])
        if y != season or key in seen:
            continue
        seen.add(key)
        cut = cutoffs[band_index(r["lat"])]
        second = doy > (cut if cut is not None else SECOND_BROOD_FALLBACK) or doy > SECOND_BROOD_FALLBACK
        approx = bool(r["obscured"]) or bool(r["geoprivacy"]) or (r["accuracy_m"] or 0) > APPROX_ACCURACY_M
        pending = r["quality_grade"] != "research"
        out.append([int(r["id"]), y, doy, round(r["lat"], 3), round(r["lng"], 3),
                    int(second) + 2 * int(approx) + 4 * int(pending)])
    return sorted(out, key=lambda s: (s[2], s[0]))


# ---------------------------------------------------------------- main
def build(season, as_of, use_forecast, today):
    t0 = time.time()
    replay = json.loads(REPLAY.read_text())
    cells = replay["cells"]
    ff = json.loads(FOLD_FITS.read_text())
    spec = M.SPECS[ff["spec"]]
    folds = [dict(f["params"], u=np.array([])) for f in ff["folds"].values()]
    cuts = [f["cuts"] for f in ff["folds"].values()]
    eff = json.loads((HERE / "effort_profile.json").read_text())
    off = json.loads((HERE / "prism_offsets.json").read_text())
    if off["cells"] != cells:
        raise SystemExit("prism_offsets.json was built for a different cell list; rerun build_static.py")
    offsets = np.array(off["offsets"])                          # [cell, month, (tmin, tmax)]

    clat = np.array([h3.cell_to_latlng(c)[0] for c in cells])
    clng = np.array([h3.cell_to_latlng(c)[1] for c in cells])
    cstate = [eff["states"].index(s) for s in fdata.state_of(clat, clng)]
    eprof = np.array(eff["profile"])[cstate]
    cband = [BAND_LABELS[i] for i in band_index(clat)]

    # 1. analog years (Daymet), the base every trajectory is written onto
    _, years, a_min, a_max = temperature_cube(cells, *ANALOG_YEARS, fdata.DATA / "daymet")
    # 2. observed this season
    start = dt.date(season, 3, 1)
    o_min, o_max, n_borrowed = observed(cells, start, as_of, offsets)
    check_temps("PRISM", o_min, o_max)
    i0, i1 = day_index(start), day_index(as_of) + 1             # observed day indices [i0, i1)
    # 3. forecast days after as_of
    f_min = f_max = np.zeros((len(cells), 0))
    f_end = as_of
    if use_forecast:
        f_start, f_end = as_of + dt.timedelta(days=1), as_of + dt.timedelta(days=FORECAST_DAYS)
        f_min, f_max = sources.open_meteo(clat, clng, f_start, f_end)
        months = np.array([d.month - 1 for d in sources.dates(f_start, f_end)])
        f_min, f_max = f_min + offsets[:, months, 0], f_max + offsets[:, months, 1]
        keep = ~(np.isnan(f_min).any(0) | np.isnan(f_max).any(0))   # trim days the API did not cover for all cells
        n_ok = int(np.argmin(keep)) if not keep.all() else len(keep)
        f_min, f_max = f_min[:, :n_ok], f_max[:, :n_ok]
        f_end = as_of + dt.timedelta(days=n_ok)
        check_temps("Open-Meteo", f_min, f_max)
    i2 = i1 + f_min.shape[1]

    # 4. 11 weather endings x 11 fits
    members, out_now, dd_now = [], [], None
    resid = [s["obs_peak"] - s["heat_peak"] for s in replay["scores"]]
    for yi in range(len(years)):
        tmin, tmax = a_min[:, yi].astype(float), a_max[:, yi].astype(float)
        if i1 > i0:
            tmin[:, i0:i1], tmax[:, i0:i1] = o_min, o_max
        if i2 > i1:
            tmin[:, i1:i2], tmax[:, i1:i2] = f_min, f_max
        inc = double_sine(tmin, tmax, BASE, UPPER)
        inc[:, :START_DOY - 1] = 0
        if dd_now is None:
            dd_now = np.cumsum(inc, 1)[:, max(i1 - 1, 0)] if i1 > i0 else np.zeros(len(cells))
        for p, cut in zip(folds, cuts):
            cut_idx = np.array([cut[b] - 1 for b in cband])
            share = M.cell_sighting_share(p, spec, inc, clat, cut_idx, eprof)
            members.append([[np.inf if v is None else v for v in first_reach(s)] for s in share])
            out_now.append(share[:, i1 - 1] if i1 > i0 else np.zeros(len(cells)))
    days = np.array(members, float)
    median, lo, hi = ensemble_summary(days, resid)

    sightings = season_sightings(season, as_of, [b["cutoff"] for b in replay["bands"]])
    now = dt.datetime.now(dt.timezone.utc)
    out = {
        "version": 1, "kind": "live", "season": season,
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": as_of.isoformat(), "forecast_through": f_end.isoformat(),
        "backfill": as_of < today - dt.timedelta(days=4),
        "stale_after_hours": 36,
        "model": {"id": replay["model"]["id"], "spec": ff["spec"],
                  "ensemble": f"{len(folds)} leave-one-year-out fits x {len(years)} weather endings ({years[0]}-{years[-1]})",
                  "frozen": "one model for the whole season; never refit in-season"},
        "sources": {
            "observed": "PRISM daily (via RCC-ACIS), adjusted to the Daymet scale the model was fitted on",
            "forecast": ("Open-Meteo 7-day forecast (CC BY 4.0)" if use_forecast
                         else "none (rebuilt after the fact: real weather up to the as-of date, then past years)"),
            "after": f"Daymet {years[0]}-{years[-1]}, each year's weather run forward",
            "sightings": "iNaturalist (CC0 / CC BY / CC BY-NC only; research grade and needs-ID)"},
        "quantiles": QUANTILES,
        "cells": cells,
        "median": median, "lo": lo, "hi": hi,
        "out_now": [int(round(100 * v)) for v in np.median(np.array(out_now), 0)],
        "dd": [int(round(v)) for v in dd_now],
        "sightings": sightings,
        "checks": {"cells": len(cells), "observed_days": max(0, (as_of - start).days + 1),
                   "forecast_days": int(f_min.shape[1]), "members": int(days.shape[0]),
                   "cells_borrowed_weather": n_borrowed, "sightings": len(sightings),
                   "seconds": round(time.time() - t0)},
    }
    return out


def in_season(today, season):
    return dt.date(season, *SEASON[0]) <= today <= dt.date(season, *SEASON[1])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int)
    ap.add_argument("--as-of", type=dt.date.fromisoformat, help="last observed weather day (default: newest PRISM day)")
    ap.add_argument("--no-forecast", action="store_true", help="skip the 7-day forecast (backfills)")
    ap.add_argument("--auto", action="store_true", help="nightly mode: this season, newest data, skip off-season")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args(argv)
    today = dt.datetime.now(dt.timezone.utc).date()
    season = a.season or today.year
    if a.auto and not in_season(today, season):
        print(f"off-season ({today}): live forecast runs {SEASON[0]}..{SEASON[1]} (month, day); leaving the last file.")
        return 0
    as_of = a.as_of or min(last_prism_day(today), dt.date(season, 9, 30))
    if as_of < dt.date(season, 2, 28) or as_of > dt.date(season, 9, 30):
        raise SystemExit(f"--as-of {as_of} is outside {season}'s season (28 Feb .. 30 Sep)")
    use_forecast = not a.no_forecast and as_of >= today - dt.timedelta(days=4)
    out = build(season, as_of, use_forecast, today)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    tmp.replace(a.out)
    print(f"wrote {a.out} ({a.out.stat().st_size / 1024:.0f} KB): {json.dumps(out['checks'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
