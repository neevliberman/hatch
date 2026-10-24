#!/usr/bin/env python3
"""Lead-time backtest: how many weeks ahead is the live map's strip forecast better than the calendar?

For each season 2023-2026 and each issue date (1 Apr, 15 Apr, 1 May, 15 May, 1 Jun) the live forecast is rebuilt as
it would have stood that morning (build_live.build, frozen P3 fits, no refit), three ways:
- analogs:  real weather to the day before, then past years' weather (what a backfill does);
- gfs:      the same plus the 7-day forecast as it was really issued that night (GFS 00Z run of the issue day, NOAA's
            AWS archive), standing in for Open-Meteo's 7-day forecast, which keeps no archive;
- perfect:  the same plus the next 7 days of *real* weather (PRISM): the most a 7-day forecast could ever add.
Each forecast is graded strip by strip against that season's research-grade first-wave records with scorecard.py's
own code (score_band: real onset / peak = 10th percentile / median day, >= 20 records, graded only if issued at
least 7 days before the real date), against the calendar.

No peeking for 2023-2025 (seasons the frozen model was fitted on): only the fold fit that left that year out is used,
that year is dropped from the past-weather endings, and the calendar, the past-miss widening and the strip weights
use the other years only. 2026 runs exactly as the live job would (all 11 fits x 11 endings).

Observed weather is PRISM via RCC-ACIS, as the live job (cached per season in notebooks/data, gitignored). GFS needs
pygrib (`pip install pygrib`); only the 2 m max/min temperature fields are fetched (byte ranges).

Run: python3 pipeline/live/leadtime.py            # downloads once into notebooks/data/leadtime/, then ~minutes
     python3 -m pytest pipeline/live/test_leadtime.py
"""
import argparse
import datetime as dt
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from live import build_live as L, rehearse as R, scorecard as S, sources  # noqa: E402

import h3  # noqa: E402

CACHE = L.ROOT / "notebooks" / "data" / "leadtime"
SEASONS = (2023, 2024, 2025, 2026)
ISSUES = ("04-01", "04-15", "05-01", "05-15", "06-01")
VARIANTS = ("analogs", "gfs", "perfect")
SCORE_TODAY = dt.date(2026, 10, 24)          # records known by the Monday on or before this (as SCORECARD_2026)
GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{d:%Y%m%d}/00/atmos/gfs.t00z.pgrb2.0p50.f{h:03d}"
LEAD_BINS = ((7, 14), (14, 28), (28, 42), (42, 63), (63, 200))   # days from issue to the real date


# ---------------------------------------------------------------- pure helpers (tested)
def bilinear(field, lats, lngs, lat0=90.0, lng0=0.0, step=0.5):
    """Bilinear value of a regular global grid (rows from lat0 going south, columns from lng0 going east, `step`
    degrees, longitudes wrapping) at each point."""
    nlat, nlng = field.shape
    y = (lat0 - np.asarray(lats, float)) / step
    x = (np.asarray(lngs, float) - lng0) % 360.0 / step
    y0 = np.clip(np.floor(y).astype(int), 0, nlat - 2)
    x0 = np.floor(x).astype(int) % nlng
    x1 = (x0 + 1) % nlng
    fy, fx = y - y0, x - np.floor(x)
    return ((1 - fy) * (1 - fx) * field[y0, x0] + (1 - fy) * fx * field[y0, x1]
            + fy * (1 - fx) * field[y0 + 1, x0] + fy * fx * field[y0 + 1, x1])


def daily_extremes(win_max, win_min, n_days):
    """Daily Tmax / Tmin from 6-hour window max / min, [point, window] with window 0 starting 06Z of the first day
    (about 1 am Central): 4 windows per weather day. -> ([point, day] tmin, [point, day] tmax)."""
    wmax = np.asarray(win_max, float)[:, :4 * n_days].reshape(len(win_max), n_days, 4)
    wmin = np.asarray(win_min, float)[:, :4 * n_days].reshape(len(win_min), n_days, 4)
    return wmin.min(2), wmax.max(2)


def without_year(replay, year):
    """The replay file with one year's moths taken out (its scored strip-years and its sightings), so a forecast for
    that year sizes its range, weights its strips and sets its calendar from the other years only."""
    out = dict(replay)
    out["scores"] = [s for s in replay["scores"] if s["year"] != year]
    out["sightings"] = [s for s in replay["sightings"] if s[1] != year]
    return out


def date_errors(row, season, issued):
    """Per-date lead and errors from one scored score_band row: [(kind, lead days, |forecast|, |calendar|)]."""
    if row.get("status") != "scored":
        return []
    out = []
    for k in ("onset", "peak"):
        r = row[k]
        lead = (S.doy_date(season, int(np.floor(r["real"]))) - issued).days
        out.append((k, lead, abs(r["error"]), abs(r["calendar_error"])))
    return out


def by_lead(errs, bins=LEAD_BINS):
    """Mean |error| per lead bin: errs [(lead, |fc| dict by variant, |cal|)] -> [(lo, hi, n, {variant: mae}, cal)]."""
    out = []
    for lo, hi in bins:
        got = [e for e in errs if lo <= e[0] < hi]
        if not got:
            continue
        vs = got[0][1].keys()
        out.append((lo, hi, len(got), {v: float(np.mean([g[1][v] for g in got])) for v in vs},
                    float(np.mean([g[2] for g in got]))))
    return out


# ---------------------------------------------------------------- downloads (cached)
def _get(url, rng=None):
    req = urllib.request.Request(url, headers={**sources.UA, **({"Range": f"bytes={rng[0]}-{rng[1]}"} if rng else {})})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception:  # noqa: BLE001
            if attempt == 4:
                raise
    return None


def gfs_window(day: dt.date, fh: int, lats, lngs):
    """2 m max / min temperature (deg C) over the 6 hours ending fh hours after the 00Z run of `day`, at each point."""
    import pygrib
    url = GFS.format(d=day, h=fh)
    idx = _get(url + ".idx").decode().splitlines()
    offs = [int(line.split(":")[1]) for line in idx]
    want = {}
    for i, line in enumerate(idx):
        f = line.split(":")
        if f[3] in ("TMAX", "TMIN") and f[4] == "2 m above ground":
            want[f[3]] = (offs[i], offs[i + 1] - 1)
    out = []
    for k in ("TMAX", "TMIN"):
        g = pygrib.fromstring(_get(url, want[k]))
        out.append(bilinear(g.values - 273.15, lats, lngs, g.latitudeOfFirstGridPointInDegrees, 0.0, 0.5))
    return out


def gfs_week(issue: dt.date, cells):
    """Daily Tmin / Tmax [cell, 7] for issue .. issue + 6 from the 00Z GFS run of the issue day (cached)."""
    path = CACHE / f"gfs_{issue.isoformat()}.npz"
    if path.exists():
        z = np.load(path)
        return z["tmin"], z["tmax"]
    ll = np.array([h3.cell_to_latlng(c) for c in cells])
    hours = [12 + 6 * j for j in range(4 * L.FORECAST_DAYS)]          # windows 06Z issue day .. 06Z issue + 7
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(lambda h: gfs_window(issue, h, ll[:, 0], ll[:, 1]), hours))
    tmin, tmax = daily_extremes(np.array([g[0] for g in got]).T, np.array([g[1] for g in got]).T, L.FORECAST_DAYS)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, tmin=tmin, tmax=tmax)
    return tmin, tmax


def season_records(season):
    """Research-grade luna records for a season, as the scorecard fetches them (cached)."""
    path = L.ROOT / "notebooks" / "data" / f"luna_{season}_rg.parquet"
    if path.exists():
        return pd.read_parquet(path)
    raw = S.fetch_records(season, min(SCORE_TODAY, dt.date(season, 12, 31)))
    raw.to_parquet(path)
    return raw


# ---------------------------------------------------------------- one forecast
class Patched:
    """Points build_live at one season's cached weather and one replay/fit subset, the way rehearse.py does."""

    def __init__(self, season, cells):
        self.season, self.cells = season, cells
        self.start, self.tmin, self.tmax = R.cached_prism(season, cells)
        self.index = {(round(a, 6), round(b, 6)): i for i, (a, b) in enumerate(h3.cell_to_latlng(c) for c in cells)}
        self.orig = (L.REPLAY, L.FOLD_FITS, L.temperature_cube, sources.prism_point, sources.open_meteo,
                     L.season_sightings)
        self.forecast = None

    def prism_point(self, lat, lng, s, e):
        i, a0 = self.index[(round(lat, 6), round(lng, 6))], (s - self.start).days
        return self.tmin[i, a0:a0 + (e - s).days + 1].copy(), self.tmax[i, a0:a0 + (e - s).days + 1].copy()

    def prism_cube(self, s, e):
        a0 = (s - self.start).days
        return self.tmin[:, a0:a0 + (e - s).days + 1].copy(), self.tmax[:, a0:a0 + (e - s).days + 1].copy()

    def __enter__(self):
        season = self.season
        sources.prism_point = self.prism_point
        sources.open_meteo = lambda lats, lngs, s, e: self.forecast
        L.season_sightings = lambda *_: []
        if season <= L.ANALOG_YEARS[1]:            # a fitted year: no peeking at its moths or its weather
            replay = without_year(json.loads(self.orig[0].read_text()), season)
            ff = json.loads(self.orig[1].read_text())
            ff["folds"] = {str(season): ff["folds"][str(season)]}
            CACHE.mkdir(parents=True, exist_ok=True)
            (CACHE / f"replay_wo_{season}.json").write_text(json.dumps(replay))
            (CACHE / f"fits_wo_{season}.json").write_text(json.dumps(ff))
            L.REPLAY, L.FOLD_FITS = CACHE / f"replay_wo_{season}.json", CACHE / f"fits_wo_{season}.json"
            cube = self.orig[2]

            def drop(cells, y0, y1, cache):
                h, years, a, b = cube(cells, y0, y1, cache)
                k = years != season
                return h, years[k], a[:, k], b[:, k]
            L.temperature_cube = drop
        return self

    def __exit__(self, *exc):
        L.REPLAY, L.FOLD_FITS, L.temperature_cube, sources.prism_point, sources.open_meteo, L.season_sightings = self.orig


def forecast(p: Patched, issue: dt.date, variant):
    """One rebuilt forecast, filed as issued on `issue` with real weather through the day before."""
    as_of = issue - dt.timedelta(days=1)
    if variant == "gfs":
        p.forecast = gfs_week(issue, p.cells)
    elif variant == "perfect":
        p.forecast = p.prism_cube(issue, issue + dt.timedelta(days=L.FORECAST_DAYS - 1))
    live = L.build(p.season, as_of, variant != "analogs", SCORE_TODAY)
    return S.archive_entry(live, issued=issue.isoformat())


# ---------------------------------------------------------------- run
def run(seasons=SEASONS, issues=ISSUES, variants=VARIANTS):
    base = json.loads(L.REPLAY.read_text())
    cells = base["cells"]
    cuts = {b["label"]: min(int(b["cutoff"] or S.FALLBACK_CUT), S.FALLBACK_CUT) for b in base["bands"]}
    score_date = S.week_start(SCORE_TODAY)
    rows = []
    for season in seasons:
        raw = season_records(season)
        rec = S.first_wave(raw, season, cuts, score_date)
        cal = S.calendar(without_year(base, season) if season <= L.ANALOG_YEARS[1] else base)
        with Patched(season, cells) as p:
            for md in issues:
                issue = dt.date.fromisoformat(f"{season}-{md}")
                for v in variants:
                    path = CACHE / "forecasts" / f"{issue.isoformat()}_{v}.json"
                    if path.exists():
                        e = json.loads(path.read_text())
                    else:
                        e = forecast(p, issue, v)
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(json.dumps(e))
                    for b in cuts:
                        r = S.score_band(b, rec[rec.band == b], season, cuts[b], score_date, [e], e["model"], cal)
                        rows.append({"season": season, "issue": md, "variant": v, "band": b, "row": r,
                                     "dates": date_errors(r, season, issue)})
                    print(f"{season} {md} {v}: " + " ".join(
                        f"{x['band']}={x['row'].get('miss', x['row']['status'])}" for x in rows[-len(cuts):]), flush=True)
    return rows


def summarise(rows, variants=VARIANTS):
    """By issue date: strips scored, mean miss per variant and calendar (scorecard metric); and by lead time."""
    by_issue = []
    for md in ISSUES:
        got = {v: [x["row"] for x in rows if x["issue"] == md and x["variant"] == v and x["row"]["status"] == "scored"]
               for v in variants}
        n = len(got[variants[0]])
        if not n:
            continue
        by_issue.append({"issue": md, "strips": n,
                         **{v: round(float(np.mean([r["miss"] for r in got[v]])), 1) for v in variants},
                         "calendar": round(float(np.mean([r["calendar_miss"] for r in got[variants[0]]])), 1),
                         "beat_calendar": sum(r["miss"] < r["calendar_miss"] for r in got[variants[0]])})
    keyed = {}
    for x in rows:
        for k, lead, fc, cal in x["dates"]:
            keyed.setdefault((x["season"], x["issue"], x["band"], k), [lead, {}, cal])[1][x["variant"]] = fc
    lead = [(lo, hi, n, {v: round(m, 1) for v, m in ms.items()}, round(c, 1))
            for lo, hi, n, ms, c in by_lead([tuple(v) for v in keyed.values() if len(v[1]) == len(variants)])]
    return by_issue, lead


def chart(by_issue, path):
    """Average days off by issue date: the forecast with and without the 7-day weather, and the calendar."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ink, muted, surface = "#0b0b0b", "#52514e", "#fcfcfb"
    x = np.arange(len(by_issue))
    fig, ax = plt.subplots(figsize=(6.4, 3.6), dpi=150, facecolor=surface)
    ax.set_facecolor(surface)
    series = (("calendar", "Calendar (usual date)", "#8f8e89", "o", "-"),
              ("analogs", "Forecast, past years' weather only", "#eb6834", "s", "--"),
              ("gfs", "Forecast + 7-day weather forecast", "#2a78d6", "o", "-"))
    for key, label, color, marker, ls in series:
        ax.plot(x, [r[key] for r in by_issue], color=color, lw=2, marker=marker, ms=7, ls=ls, label=label)
    for i, r in enumerate(by_issue):
        below = r["gfs"] <= r["calendar"]
        ax.annotate(f"{r['gfs']:.1f}", (x[i], r["gfs"]), textcoords="offset points", xytext=(0, -15),
                    ha="center", fontsize=8, color=ink)
        ax.annotate(f"{r['calendar']:.1f}", (x[i], r["calendar"]), textcoords="offset points",
                    xytext=(0, 9 if below else -15), ha="center", fontsize=8, color=muted)
    when = {"04-01": "1 Apr", "04-15": "15 Apr", "05-01": "1 May", "05-15": "15 May", "06-01": "1 Jun"}
    ax.set_xticks(x, [f"{when[r['issue']]}\n{r['strips']} strips" for r in by_issue])
    ax.set_xlabel("Forecast issued on (strips whose dates were still at least a week away)", color=ink, fontsize=9)
    ax.set_ylabel("Average days off", color=ink, fontsize=9)
    ax.set_ylim(0, 8.5)
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    ax.tick_params(colors=muted, labelsize=8)
    ax.grid(axis="y", color="#eaeef2", lw=0.8)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=8, loc="lower left")
    ax.set_title("Strip onset and peak, 2023-2026: forecast vs the usual date", fontsize=10, color=ink, loc="left")
    fig.tight_layout()
    fig.savefig(path, facecolor=surface)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seasons", type=int, nargs="+", default=list(SEASONS))
    ap.add_argument("--out", type=Path, default=HERE / "leadtime.json")
    ap.add_argument("--chart", type=Path, default=HERE / "leadtime.png")
    a = ap.parse_args(argv)
    rows = run(a.seasons)
    by_issue, lead = summarise(rows)
    strips = [{"season": x["season"], "issue": x["issue"], "variant": x["variant"], "band": x["band"],
               "status": x["row"]["status"], "miss": x["row"].get("miss"), "calendar_miss": x["row"].get("calendar_miss"),
               "peak_error": x["row"].get("peak", {}).get("error"), "onset_error": x["row"].get("onset", {}).get("error")}
              for x in rows]
    a.out.write_text(json.dumps({"by_issue": by_issue,
                                 "by_lead": [{"lead_days": [lo, hi], "dates": n, **m, "calendar": c}
                                             for lo, hi, n, m, c in lead],
                                 "strips": strips}, indent=1) + "\n")
    chart(by_issue, a.chart)
    print(json.dumps(by_issue, indent=1))
    print(json.dumps(lead))
    return 0


if __name__ == "__main__":
    sys.exit(main())
