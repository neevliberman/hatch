#!/usr/bin/env python3
"""Tryout: ground warmth instead of air warmth (plan and rule: SOIL_PLAN.md, written before any score).

Analogy: P3 reads a thermometer hung 2 m up; the pupae lie in the leaf litter. Here the clock is read from the ground:
ERA5-Land top soil layer (0-7 cm), hourly, via the Open-Meteo archive, each day's low and high fed to P3's own
degree-day code in place of Daymet's tmin and tmax. Everything else is P3's leave-one-year-out (evaluate.loyo_fold).

Run: python3 pipeline/league/tryouts/soil.py [--workers 8]   (fetch is cached in notebooks/data/soil/)
"""
import argparse
import datetime as dt
import json
import multiprocessing as mp
import sys
import time
import urllib.request
from pathlib import Path

import h3
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path[:0] = [str(ROOT / "notebooks"), str(ROOT / "pipeline")]

from fit import context, evaluate as EV, model as M  # noqa: E402
from hatch_p1.degree_days import accumulate  # noqa: E402

CACHE = ROOT / "notebooks" / "data" / "soil"
OUT = HERE / "results" / "soil"
URL = "https://archive-api.open-meteo.com/v1/archive"
VAR = "soil_temperature_0_to_7cm"
BASES = (4.0, 6.0, 8.0, 10.0)
SPEC = "p3_photo"
BATCH = 50


def fetch_year(lls, year):
    """Hourly top-soil temperature for each (lat, lng), 1 Mar - 31 Aug of `year` -> [loc, day index 0..364, 24]."""
    f = CACHE / f"{year}.npy"
    if f.exists():
        return np.load(f)
    out = np.full((len(lls), 365, 24), np.nan, dtype=np.float32)
    end = min(dt.date(year, 8, 31), dt.date.today() - dt.timedelta(days=6))
    for i in range(0, len(lls), BATCH):
        part = lls[i:i + BATCH]
        q = (f"{URL}?latitude={','.join(f'{a:.4f}' for a, _ in part)}&longitude={','.join(f'{b:.4f}' for _, b in part)}"
             f"&start_date={year}-03-01&end_date={end}&hourly={VAR}&models=era5_land&timezone=America%2FChicago")
        for attempt in range(5):
            try:
                with urllib.request.urlopen(q, timeout=180) as r:
                    got = json.loads(r.read())
                break
            except Exception as err:  # noqa: BLE001
                print(f"  retry {year} batch {i}: {err!r}", flush=True)
                time.sleep(10 * (attempt + 1))
        else:
            raise RuntimeError(f"Open-Meteo failed for {year} batch {i}")
        got = got if isinstance(got, list) else [got]
        for j, g in enumerate(got):
            t = pd.to_datetime(g["hourly"]["time"])
            v = np.array([np.nan if x is None else x for x in g["hourly"][VAR]], dtype=np.float32)
            di = t.dayofyear.to_numpy() - 1            # Daymet day index: Feb 29 counts, 31 Dec of a leap year drops
            keep = di < 365
            out[i + j, di[keep], t.hour.to_numpy()[keep]] = v[keep]
        print(f"  {year}: {min(i + BATCH, len(lls))}/{len(lls)}", flush=True)
        time.sleep(1)
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(f, out)
    return out


def soil_cube(hexes, years):
    """(tmin, tmax) [hex, year, 365] from the ground. Before 1 March nothing counts (accumulate starts there), so those
    days are set to 0. A hexagon with no land cell nearby takes its nearest hexagon's values."""
    lls = [h3.cell_to_latlng(h) for h in hexes]
    hourly = np.stack([fetch_year(lls, int(y)) for y in years], axis=1)      # [hex, year, 365, 24]
    with np.errstate(all="ignore"):
        tmin, tmax = np.nanmin(hourly, -1), np.nanmax(hourly, -1)
    season = np.zeros(365, bool)
    season[59:243] = True                                                    # day index 59 = 1 March (non-leap)
    empty = np.isnan(tmin[:, :, season]).all(axis=(1, 2))
    ll = np.radians(np.array(lls))
    for i in np.where(empty)[0]:
        d = np.where(empty, np.inf, np.hypot(ll[:, 0] - ll[i, 0], (ll[:, 1] - ll[i, 1]) * np.cos(ll[i, 0])))
        tmin[i], tmax[i] = tmin[d.argmin()], tmax[d.argmin()]
    gaps = np.isnan(tmin[:, :, 59:243]).sum()
    if gaps:
        print(f"filling {gaps} missing soil days by carrying the last value forward")
        for arr in (tmin, tmax):
            s = pd.DataFrame(arr.reshape(-1, 365)).ffill(axis=1).bfill(axis=1).to_numpy()
            arr[:] = s.reshape(arr.shape)
    tmin[..., ~season], tmax[..., ~season] = 0.0, 0.0
    return tmin, tmax, int(empty.sum())


CTX = {}
H = None


def _fold(args):
    key, year = args
    r = EV.loyo_fold(CTX[key], H, year, [M.SPECS[SPEC]])
    f = r["fits"][SPEC]
    return key, year, r["rows"], float(f.nll), bool(f.converged)


def main(argv=None):
    global H
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)
    air = context.load_context()
    H = EV.helpers(air)
    tmin, tmax, moved = soil_cube(air.hexes, air.years)
    CTX["air"] = air
    for b in BASES:
        cum = accumulate(tmin, tmax, b).astype(np.float32)
        CTX[f"soil{b:g}"] = context.Context(air.rec, air.hexes, air.years, cum, context.daily_from_cum(cum), air.E)
    jobs = [(k, int(y)) for k in CTX for y in air.years]
    with mp.get_context("fork").Pool(a.workers) as pool:
        res = pool.map(_fold, jobs)
    rows = {k: [] for k in CTX}
    nll = {k: {} for k in CTX}
    for k, y, rr, n, conv in res:
        rows[k] += [dict(r, year=y) for r in rr]
        nll[k][y] = (n, conv)
    # S2: per fold, the soil base with the best training fit
    picks = {y: min((k for k in CTX if k.startswith("soil")), key=lambda k: nll[k][y][0]) for y in map(int, air.years)}
    rows["S2"] = [r for y, k in picks.items() for r in rows[k] if r["year"] == y]
    rows["S1"] = rows["soil10"]

    def score(rr):
        d = pd.DataFrame(rr)
        m = lambda c: float(((d[f"{c}_onset"] - d.onset).abs().mean() + (d[f"{c}_peak"] - d.peak).abs().mean()) / 2)  # noqa: E731
        return {"model": round(m(SPEC), 3), "calendar": round(m("cal"), 3), "band_years": len(d)}
    table = {k: score(rows[k]) for k in ("air", "S1", "S2", *[k for k in CTX if k.startswith("soil")])}
    ctrl = table["air"]["model"]
    for k, v in table.items():
        v["vs_control"] = round(v["model"] - ctrl, 3)
    # paired bootstrap over band-years for S1 and S2 vs control
    rng = np.random.default_rng(0)
    da = pd.DataFrame(rows["air"]).set_index(["band", "year"])
    ci = {}
    for k in ("S1", "S2"):
        ds = pd.DataFrame(rows[k]).set_index(["band", "year"]).loc[da.index]
        e = lambda d: ((d[f"{SPEC}_onset"] - d.onset).abs() + (d[f"{SPEC}_peak"] - d.peak).abs()).to_numpy() / 2  # noqa: E731
        diff = e(ds) - e(da)
        boots = [diff[rng.integers(0, len(diff), len(diff))].mean() for _ in range(4000)]
        ci[k] = [round(float(np.percentile(boots, 2.5)), 2), round(float(np.percentile(boots, 97.5)), 2)]
    out = {"plan": "SOIL_PLAN.md", "spec": SPEC, "hexes_moved_to_nearest": moved, "table": table, "ci95_vs_control": ci,
           "s2_base_by_fold": {y: k for y, k in picks.items()},
           "nll": {k: {y: v[0] for y, v in d.items()} for k, d in nll.items()},
           "unconverged": {k: [y for y, v in d.items() if not v[1]] for k, d in nll.items()}}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "loyo.json").write_text(json.dumps(out, indent=1))
    pd.concat([pd.DataFrame(rows[k]).assign(arm=k) for k in rows]).to_csv(OUT / "loyo_rows.csv", index=False)
    print(json.dumps({"table": table, "ci95_vs_control": ci, "s2_base_by_fold": out["s2_base_by_fold"]}, indent=1))


if __name__ == "__main__":
    main()
