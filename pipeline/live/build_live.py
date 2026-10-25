#!/usr/bin/env python3
"""Nightly live forecast: this season's first wave of every live species (luna moth, firefly, Japanese beetle, ...;
registry.py), per res-4 hex -> public/live/latest.json (luna at the top level, the others under "species").

How one night's forecast is put together (analogy: finishing a sentence someone has started):
1. The words already said: real weather from 1 March to yesterday (PRISM, adjusted to the Daymet scale the model
   was fitted on, see build_static.py).
2. The next few words, fairly sure: a 7-day weather forecast (Open-Meteo).
3. The rest, unknown: each past year 2015-2025 of Daymet weather run forward from there, 11 possible endings.
Each of the 11 weather endings is run through each of the 11 leave-one-year-out fits of the species' frozen model
(luna: P3, fold_fits.json, the same fits the replay uses; the others: their own fits in result.json), so 121 forecasts
per hex. The weather is fetched once and shared by every species. The median is the forecast; the spread,
widened by how far past forecasts actually missed (the replay's scored band-years), is the "likely" range.

Run: python3 pipeline/live/build_live.py --season 2026 --as-of 2026-06-01 [--no-forecast]
     python3 pipeline/live/build_live.py --auto     (what the nightly job runs; no-op outside 2 Mar..7 Oct)
"""
import argparse
import datetime as dt
import hashlib
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

from live import registry, sources  # noqa: E402

REPLAY = ROOT / "src" / "data" / "luna-replay.json"
FOLD_FITS = ROOT / "pipeline" / "replay" / "fold_fits.json"
OUT = ROOT / "public" / "live" / "latest.json"
ANALOG_YEARS = (2015, 2025)
BASE, UPPER, START_DOY = 10.0, 30.0, 60
QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95]
MAX_DOY = 300
FORECAST_DAYS = 7
MIN_FORECAST_DAYS = 5           # fewer complete Open-Meteo days than this -> fail loudly
SEASON = ((3, 2), (10, 7))      # --auto runs between these (month, day) dates; outside, the last file stands
PRISM_LAG_DAYS = 3              # the morning job's newest full weather day is today - 3: ACIS has PRISM through about
                                # today - 2 (its day ends at 7 am and posts later that day), and that date's high belongs
                                # to the day before (sources.weather_days). Backtests use the same lag.
MAX_BAD_CELLS = 0.02            # more cells than this with no observed weather -> fail loudly
TAXON = 47916
LICENCES = ("cc0", "cc-by", "cc-by-nc")
SECOND_BROOD_FALLBACK = 240
APPROX_ACCURACY_M = 5000
BAND_Q = [0.10, 0.50]           # band onset / peak, the quantities P3 scores (FROZEN_P3.md) and scorecard.py grades


def model_hash(path=FOLD_FITS):
    """First 12 hex digits of the sha256 of the frozen fits file: the season's model version, written into every
    forecast so the scorecard can refuse to grade a forecast made by a different model."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:12]


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


def band_weights(cells, sightings):
    """[band, cell] weight: each cell's share of its band's past first-wave sightings (the replay's openly licensed
    2015-2025 records, exact locations), as P3 weights a band's hexes by their share of its training records."""
    at = {c: i for i, c in enumerate(cells)}
    lat = np.array([h3.cell_to_latlng(c)[0] for c in cells])
    w = np.zeros((len(BAND_LABELS), len(cells)))
    for s in sightings:
        if s[5] & 3:            # second wave or rough location
            continue
        i = at.get(h3.latlng_to_cell(s[3], s[4], 4))
        if i is not None:
            w[band_index(lat[i]), i] += 1
    return w


def band_reach(share, w, quantiles=BAND_Q):
    """Band onset / peak doy: the weighted mix of each cell's cumulative sighting share (cells with no expected
    sightings drop out), first reaching each quantile. share: [cell, day]; w: [band, cell]. -> [band, quantile]."""
    has = share[:, -1] > 0
    out = []
    for wb in w:
        wb = np.where(has, wb, 0.0)
        if wb.sum() <= 0:
            out.append([np.inf] * len(quantiles))
            continue
        mix = (wb[:, None] * share).sum(0) / wb.sum()
        out.append([np.inf if v is None else v for v in first_reach(mix, quantiles)])
    return out


def fill_gaps(x):
    """Fill interior NaN days in each row by linear interpolation in time. Leading/trailing NaNs stay NaN: a
    missing last day is missing data, not something to invent from yesterday."""
    x = np.array(x, float)
    t = np.arange(x.shape[-1])
    for row in x:
        ok = ~np.isnan(row)
        if ok.sum() >= 2 and not ok.all():
            a, b = np.argmax(ok), len(ok) - 1 - np.argmax(ok[::-1])
            gap = ~ok & (t > a) & (t < b)
            row[gap] = np.interp(t[gap], t[ok], row[ok])
    return x


def ensemble_summary(days, resid):
    """days: [member, cell, quantile] doy (np.inf = never). resid: past real-minus-forecast errors (days), either
    one list for every quantile or [error, quantile] (onset errors for the early quantiles, peak errors after).

    median: the members' median day (None if most members never get there).
    lo / hi: 10th / 90th percentile of (member day + past error) over every member x error pair: weather spread
    and model error together, so a date already fixed by real weather still carries the model's honest error.
    """
    med = np.quantile(days, 0.5, axis=0, method="inverted_cdf")
    r = np.asarray(resid, float)
    r = r[:, None] if r.ndim == 1 else r                       # [error, quantile or 1]
    tot = (days[:, None] + r[None, :, None, :]).reshape(-1, *days.shape[1:])
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
    if (np.isnan(tmin[:, -1]) | np.isnan(tmax[:, -1])).mean() > MAX_BAD_CELLS:
        raise SystemExit(f"PRISM: {end} is missing for too many cells (not posted yet?); not writing.")
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
def season_sightings(season, as_of, cutoffs, taxon=TAXON, last_doy=None):
    """This season's openly licensed sightings of `taxon` to date (default luna): [id, year, doy, lat, lng, flags].
    flags: bit0 second brood, bit1 approximate location, bit2 not yet confirmed (iNat 'needs ID'). A one-generation
    species (last_doy set) keeps only days up to last_doy, as its replay does."""
    rows, last = [], 0
    while True:
        js = inat._get("observations", {
            "taxon_id": taxon, "place_id": ",".join(map(str, inat.MIDWEST_PLACES)),
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
        if y != season or key in seen or (last_doy is not None and doy > last_doy):
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
def _paths(sp):
    """A species' replay and fits files. Luna's are read through this module's REPLAY / FOLD_FITS, so a backtest that
    points those at a subset (leadtime.py) still works."""
    return (REPLAY, FOLD_FITS) if sp.key == "luna" else (sp.replay, sp.fits)


def weather(season, as_of, use_forecast, cells):
    """The season's weather at every cell, shared by every species: Daymet analog years with real PRISM written over
    them from the model's first day to as_of, then the 7-day forecast. -> dict, with each analog year's daily
    degree-days (`inc`, [year] of [cell, day]) and the degree-days banked by as_of (`dd_now`)."""
    off = json.loads((HERE / "prism_offsets.json").read_text())
    if off["cells"] != cells:
        raise SystemExit("prism_offsets.json was built for a different cell list; rerun build_static.py")
    offsets = np.array(off["offsets"])                          # [cell, month, (tmin, tmax)]
    clat = np.array([h3.cell_to_latlng(c)[0] for c in cells])
    clng = np.array([h3.cell_to_latlng(c)[1] for c in cells])

    # 1. analog years (Daymet), the base every trajectory is written onto
    _, years, a_min, a_max = temperature_cube(cells, *ANALOG_YEARS, fdata.DATA / "daymet")
    # 2. observed this season, from the first model day (day index 59: 1 March, or 29 Feb in a leap year)
    start = dt.date(season, 1, 1) + dt.timedelta(days=START_DOY - 1)
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
        if n_ok < MIN_FORECAST_DAYS:
            raise SystemExit(f"Open-Meteo: only {n_ok} complete forecast days for all cells; not writing.")
        f_min, f_max = f_min[:, :n_ok], f_max[:, :n_ok]
        f_end = as_of + dt.timedelta(days=n_ok)
        check_temps("Open-Meteo", f_min, f_max)
    i2 = i1 + f_min.shape[1]

    # 4. one weather ending per analog year: daily degree-days
    incs, dd_now = [], None
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
        incs.append(inc)
    return {"cells": cells, "clat": clat, "clng": clng, "years": years, "start": start, "i0": i0, "i1": i1,
            "f_end": f_end, "forecast_days": int(f_min.shape[1]), "n_borrowed": n_borrowed, "incs": incs,
            "dd_now": dd_now, "use_forecast": use_forecast}


def forecast_species(sp, wx, season, as_of, today, prev=None, model_id=None, sightings=True):
    """One species' forecast on the shared weather: its 11 frozen fits x the 11 weather endings, summarised as in
    build() (the live file's layout). prev: that species' last published entry (its sightings if iNat is down).
    model_id / sightings=False: a bench challenger's night (pipeline/league), which names its own model and skips the
    sightings (the champion's entry carries them)."""
    t0 = time.time()
    replay_path, fits_path = _paths(sp)
    replay = json.loads(replay_path.read_text())
    cells = replay["cells"]
    if cells != wx["cells"]:
        raise ValueError(f"{sp.key}: its replay's cells differ from the weather's; the live job shares one cell list")
    if sp.key == "luna":
        ff = json.loads(fits_path.read_text())
        spec_name = ff["spec"]
        folds = [dict(f["params"], u=np.array([])) for f in ff["folds"].values()]
        cuts = [f["cuts"] for f in ff["folds"].values()]
        mhash = model_hash()
    else:
        spec_name, params, cuts = sp.folds()
        folds = [dict(p, u=np.array([])) for p in params]
        mhash = sp.model_hash()
    spec = M.SPECS[spec_name]
    eff = json.loads(sp.effort.read_text())
    clat, years, i0, i1 = wx["clat"], wx["years"], wx["i0"], wx["i1"]
    cstate = [eff["states"].index(s) for s in fdata.state_of(clat, wx["clng"])]
    eprof = np.array(eff["profile"])[cstate]
    cband = [BAND_LABELS[i] for i in band_index(clat)]
    bw = band_weights(cells, replay["sightings"])

    members, band_members, out_now = [], [], []
    # past real-minus-forecast errors per scored band-year: onset errors for q05/q25, peak errors for q50 onward
    resid = [[s["obs_onset"] - s["heat_onset"]] * 2 + [s["obs_peak"] - s["heat_peak"]] * 3 for s in replay["scores"]]
    for inc in wx["incs"]:
        for p, cut in zip(folds, cuts):
            cut_idx = np.array([cut[b] - 1 for b in cband])
            share = M.cell_sighting_share(p, spec, inc, clat, cut_idx, eprof)
            members.append([[np.inf if v is None else v for v in first_reach(s)] for s in share])
            band_members.append(band_reach(share, bw))
            out_now.append(share[:, i1 - 1] if i1 > i0 else np.zeros(len(cells)))
    days = np.array(members, float)
    median, lo, hi = ensemble_summary(days, resid)
    b_med, b_lo, b_hi = ensemble_summary(np.array(band_members, float),
                                         [[s["obs_onset"] - s["heat_onset"], s["obs_peak"] - s["heat_peak"]] for s in replay["scores"]])
    bands = [{"band": b, "onset": b_med[i][0], "onset_lo": b_lo[i][0], "onset_hi": b_hi[i][0],
              "peak": b_med[i][1], "peak_lo": b_lo[i][1], "peak_hi": b_hi[i][1]} for i, b in enumerate(BAND_LABELS)]

    seen, sightings_ok = [], True
    try:   # an iNat outage should not cost the night's forecast: keep the previous file's dots and flag it
        if sightings:
            seen = season_sightings(season, min(today, dt.date(season, *SEASON[1])), [b["cutoff"] for b in replay["bands"]],
                                    sp.taxon, sp.last_doy)
    except Exception as e:  # noqa: BLE001
        print(f"WARNING: iNat {sp.key} sightings failed ({e}); keeping the previous file's", flush=True)
        sightings_ok = False
        if prev is not None and prev.get("season") == season:
            seen = prev.get("sightings", [])
    now = dt.datetime.now(dt.timezone.utc)
    use_forecast, f_end, start = wx["use_forecast"], wx["f_end"], wx["start"]
    out = {
        "version": 1, "kind": "live", "season": season,
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": as_of.isoformat(), "forecast_through": f_end.isoformat(),
        "backfill": as_of < today - dt.timedelta(days=4),
        "stale_after_hours": 36,
        "model": {"id": model_id or replay["model"]["id"], "spec": spec_name, "hash": mhash,
                  "ensemble": f"{len(folds)} leave-one-year-out fits x {len(years)} weather endings ({years[0]}-{years[-1]})",
                  "frozen": "one model for the whole season; never refit in-season"},
        "sources": {
            "observed": "PRISM daily (via RCC-ACIS), adjusted to the Daymet scale the model was fitted on",
            "forecast": (f"Open-Meteo {wx['forecast_days']}-day forecast (CC BY 4.0)" if use_forecast
                         else "none (rebuilt after the fact: real weather up to the as-of date, then past years)"),
            "after": f"Daymet {years[0]}-{years[-1]}, each year's weather run forward",
            "sightings": "iNaturalist (CC0 / CC BY / CC BY-NC only; research grade and needs-ID)"},
        "quantiles": QUANTILES,
        "cells": cells,
        "median": median, "lo": lo, "hi": hi,
        # whole latitude strips: the day 10% / 50% of the strip's expected first-wave sightings have happened (the
        # dates P3 scores), with the same honest range; scorecard.py grades these once the season's sightings settle
        "bands": bands,
        "out_now": [int(round(100 * v)) for v in np.median(np.array(out_now), 0)],
        "dd": [int(round(v)) for v in wx["dd_now"]],
        "sightings": seen,
        "checks": {"cells": len(cells), "observed_days": max(0, (as_of - start).days + 1),
                   "forecast_days": wx["forecast_days"], "members": int(days.shape[0]),
                   "cells_borrowed_weather": wx["n_borrowed"], "sightings": len(seen), "sightings_fresh": sightings_ok,
                   "seconds": round(time.time() - t0)},
    }
    return out


def build(season, as_of, use_forecast, today, prev=None):
    """Luna's live file alone (what rehearse.py and leadtime.py rebuild)."""
    t0 = time.time()
    wx = weather(season, as_of, use_forecast, json.loads(REPLAY.read_text())["cells"])
    out = forecast_species(registry.LUNA, wx, season, as_of, today, prev)
    out["checks"]["seconds"] = round(time.time() - t0)
    return out


def build_all(season, as_of, use_forecast, today, prev=None, keys=None):
    """The nightly file: luna's forecast at the top level, exactly as build() writes it, and every other species in
    registry.SPECIES under "species" -> {key: an entry of the same layout, without the shared "cells"}. One weather
    download serves them all. A species that fails keeps its previous entry (if from this season) and the run says so
    loudly (checks.species_failed); luna failing fails the run, as before."""
    t0 = time.time()
    keys = keys or [s.key for s in registry.SPECIES]
    wx = weather(season, as_of, use_forecast, json.loads(REPLAY.read_text())["cells"])
    out = forecast_species(registry.LUNA, wx, season, as_of, today, prev)
    prev_sp = (prev or {}).get("species") or {}
    more, failed = {}, []
    for key in keys:
        if key == "luna":
            continue
        try:
            e = forecast_species(registry.get(key), wx, season, as_of, today, prev_sp.get(key))
        except (Exception, SystemExit) as err:  # noqa: BLE001 -- one species' failure must not cost luna's night
            print(f"::error::live forecast for {key} failed: {err!r}", flush=True)
            failed.append(key)
            old = prev_sp.get(key)
            if old and old.get("season") == season:
                more[key] = old
            continue
        if e["cells"] == out["cells"]:
            del e["cells"]                                      # the app reads the top-level cells
        more[key] = e
    out["species"] = more
    out["checks"]["species"] = sorted(more)
    out["checks"]["species_failed"] = failed
    out["shadows"], out["checks"]["shadows_failed"] = shadows(wx, season, as_of, today, ["luna", *keys])
    out["checks"]["seconds"] = round(time.time() - t0)
    return out


def shadows(wx, season, as_of, today, keys):
    """Tonight's bench challengers (pipeline/league/bench.py) on the same weather: {slug: strip dates only}, and the
    slugs that failed. A challenger's failure never costs a species' forecast; the scorecard step raises the alarm."""
    from league import bench
    out, failed = {}, []
    for ch in bench.tonight(season, keys):
        try:
            e = forecast_species(ch.live_species(), wx, season, as_of, today, model_id=ch.id, sightings=False)
            out[ch.slug] = bench.shadow_entry(e, ch)
        except (Exception, SystemExit) as err:  # noqa: BLE001
            print(f"::error::bench challenger {ch.slug} failed: {err!r}", flush=True)
            failed.append(ch.slug)
    return out, failed


def in_season(today, season):
    return dt.date(season, *SEASON[0]) <= today <= dt.date(season, *SEASON[1])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int)
    ap.add_argument("--as-of", type=dt.date.fromisoformat, help="last observed weather day (default: newest PRISM day)")
    ap.add_argument("--no-forecast", action="store_true", help="skip the 7-day forecast (backfills)")
    ap.add_argument("--auto", action="store_true", help="nightly mode: this season, newest data, skip off-season")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--prev", type=Path, help="last published file (its sightings are reused if iNat is down)")
    ap.add_argument("--species", nargs="+", choices=[s.key for s in registry.SPECIES],
                    help="only these species besides luna (default: every species in registry.py)")
    a = ap.parse_args(argv)
    today = dt.datetime.now(dt.timezone.utc).date()
    season = a.season or today.year
    if a.auto and not in_season(today, season):
        print(f"off-season ({today}): live forecast runs {SEASON[0]}..{SEASON[1]} (month, day); leaving the last file.")
        return 0
    newest = last_prism_day(today) if (a.as_of is None or a.as_of >= today - dt.timedelta(days=10)) else None
    if a.as_of and newest and a.as_of > newest:
        raise SystemExit(f"--as-of {a.as_of} is after PRISM's newest day ({newest}); not inventing weather.")
    as_of = a.as_of or min(newest, dt.date(season, 9, 30))
    if a.auto:   # PRISM can lag a few days on 2 March; weather before the model's first day is ignored anyway
        as_of = max(as_of, dt.date(season, 1, 1) + dt.timedelta(days=START_DOY - 2))
    if as_of < dt.date(season, 1, 1) + dt.timedelta(days=START_DOY - 2) or as_of > dt.date(season, 9, 30):
        raise SystemExit(f"--as-of {as_of} is outside {season}'s season (28 Feb .. 30 Sep)")
    use_forecast = not a.no_forecast and as_of >= today - dt.timedelta(days=4)
    prev = None
    if a.prev and a.prev.exists():
        try:
            prev = json.loads(a.prev.read_text())
        except ValueError:
            prev = None
    out = build_all(season, as_of, use_forecast, today, prev, a.species)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    tmp.replace(a.out)
    print(f"wrote {a.out} ({a.out.stat().st_size / 1024:.0f} KB): {json.dumps(out['checks'])}")
    for k, e in out["species"].items():
        print(f"  {k}: {json.dumps(e['checks'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
