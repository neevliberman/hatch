#!/usr/bin/env python3
"""Eastern shadow track: the heat clock forecasts every eastern place each night, and is graded weekly against
each place's calendar (EAST_2027.md). Nothing here reaches the map; it earns, or fails to earn, an eastern layer.

Analogy: a new weather station on probation. It writes its forecast in a sealed envelope every night; once a week
the envelopes from a week before each real date are opened and checked against what happened.

Each night (scorecard.py calls nightly(), after the champion's files are written):
1. Weather: real PRISM Tmin/Tmax at each place's 8 hexes from 1 March to the live file's as_of, put on Daymet's
   scale by the frozen offsets, then the 7-day Open-Meteo forecast (skipped for a backfill), then each 2015-2025
   year's degree-days as one of 11 endings (east_static.json).
2. Forecast: per place and ending, the day its warmth reaches the place's frozen onset / peak pile; the median over
   endings is the forecast, the 10th-90th percentile its spread. Saved to live/archive_east/<season>/<issued>.json.
3. Once a week (Mondays): one pull of the season's eastern luna records (receipt: live/records/<season>/east/),
   P1's filters, outside the Midwest states, first brood only; each place scored by the live scorecard's own
   score_band (20+ records, settled 14 days, forecast issued 7+ days before the real date, frozen once scored) and
   the table written to live/league_east.json with the EAST_2027.md verdict.

Run by hand: python3 pipeline/league/east.py --live live --season 2027 [--today 2027-07-12] [--force]
"""
import argparse
import datetime as dt
import hashlib
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

from league import weekly  # noqa: E402
from live import scorecard as S, sources  # noqa: E402

STATIC = HERE / "east_static.json"
LAYER = "east"
MARGIN, MIN_PLACES, MIN_RECORDS = 1.0, 5, 300          # EAST_2027.md
VERDICT = dt.date(2027, 9, 27)
SEASONS = (2027,)                                       # the track runs only in seasons it was frozen for
FORECAST_DAYS, MIN_FORECAST_DAYS = 7, 5


def load_static(path=STATIC):
    return json.loads(path.read_text())


def model_of(path=STATIC):
    return {"id": "east-clock-v1", "hash": hashlib.sha256(path.read_bytes()).hexdigest()[:12]}


# ---------------------------------------------------------------- nightly forecast
def day_index(d: dt.date) -> int:
    return d.timetuple().tm_yday - 1


def place_inc(static, tmin, tmax):
    """Daily degree-days per place from per-hex temperatures [hex, day] (static's hex order)."""
    from hatch_p1.degree_days import double_sine
    inc = double_sine(tmin, tmax, static["base_c"], static["upper_c"])
    ix = {h: i for i, h in enumerate(static["offsets"]["hexes"])}
    return {c: (np.array(p["weights"])[:, None] * inc[[ix[h] for h in p["hexes"]]]).sum(0)
            for c, p in static["places"].items()}


def season_weather(static, season, as_of: dt.date, use_forecast, fetch_obs=None, fetch_fc=None):
    """Observed (+ forecast) degree-days per place from 1 March: {place: array}, and the last day covered."""
    import h3
    hexes = static["offsets"]["hexes"]
    off = np.array(static["offsets"]["offsets"])                # [hex, month, (tmin, tmax)]
    start = dt.date(season, 1, 1) + dt.timedelta(days=static["first_day_index"])
    ll = [h3.cell_to_latlng(h) for h in hexes]
    fetch_obs = fetch_obs or (lambda lat, lng: sources.prism_point(lat, lng, start, as_of))
    with ThreadPoolExecutor(6) as ex:
        got = list(ex.map(lambda p: fetch_obs(*p), ll))
    tmin, tmax = np.array([g[0] for g in got], float), np.array([g[1] for g in got], float)
    months = np.array([d.month - 1 for d in sources.dates(start, as_of)])
    tmin, tmax = tmin + off[:, months, 0], tmax + off[:, months, 1]
    from live.build_live import fill_gaps
    tmin, tmax = fill_gaps(tmin), fill_gaps(tmax)
    if np.isnan(tmin).any() or np.isnan(tmax).any():
        raise RuntimeError("east: observed weather has holes that could not be filled")
    end = as_of
    if use_forecast:
        f0, f1 = as_of + dt.timedelta(days=1), as_of + dt.timedelta(days=FORECAST_DAYS)
        fetch_fc = fetch_fc or (lambda la, ln: sources.open_meteo(la, ln, f0, f1))
        fmin, fmax = fetch_fc(np.array([p[0] for p in ll]), np.array([p[1] for p in ll]))
        fm = np.array([d.month - 1 for d in sources.dates(f0, f1)])
        fmin, fmax = fmin + off[:, fm, 0], fmax + off[:, fm, 1]
        keep = ~(np.isnan(fmin).any(0) | np.isnan(fmax).any(0))
        n_ok = int(np.argmin(keep)) if not keep.all() else len(keep)
        if n_ok < MIN_FORECAST_DAYS:
            raise RuntimeError(f"east: only {n_ok} complete forecast days")
        tmin, tmax = np.hstack([tmin, fmin[:, :n_ok]]), np.hstack([tmax, fmax[:, :n_ok]])
        end = as_of + dt.timedelta(days=n_ok)
    return place_inc(static, tmin, tmax), end


def reach(dd, target):
    """Fractional day (index into dd) at which cumulative dd reaches target, interpolating within the day, as the
    tryout's clock.day_at."""
    i = int(np.searchsorted(dd, target))
    if i == 0:
        return 0.0
    if i >= len(dd):
        return float(len(dd) - 1)
    return i - 1 + (target - dd[i - 1]) / (dd[i] - dd[i - 1])


def forecast(static, inc_so_far):
    """Per place: onset / peak day of year (median over the 11 endings) and the 10-90% spread."""
    out = []
    for c, p in static["places"].items():
        seen = inc_so_far[c]
        members = {"onset": [], "peak": []}
        for clim in p["climate_dd"]:
            clim = np.asarray(clim, float)
            dd = np.cumsum(np.concatenate([seen, clim[len(seen):]]))
            for q in members:
                members[q].append(static["first_day_index"] + reach(dd, p["target_dd"][q]) + 1)   # day of year
        row = {"band": c}
        for q, m in members.items():
            row[q] = round(float(np.median(m)), 1)
            row[f"{q}_lo"], row[f"{q}_hi"] = (round(float(v), 1) for v in np.percentile(m, [10, 90]))
        out.append(row)
    return out


def sealed_entry(static, season, as_of: dt.date, issued: dt.date, model, use_forecast=True, fetch_obs=None,
                 fetch_fc=None):
    inc, end = season_weather(static, season, as_of, use_forecast, fetch_obs, fetch_fc)
    return {"version": 1, "season": season, "issued": issued.isoformat(), "as_of": as_of.isoformat(),
            "forecast_through": end.isoformat(), "model": model, "bands": forecast(static, inc)}


def nightly(live: Path, live_file: dict, today: dt.date, static_path=STATIC, fetch_obs=None, fetch_fc=None):
    """Tonight's sealed envelope. -> the archive path written, or None when the track does not run."""
    season = int(live_file["season"])
    if season not in SEASONS or live_file.get("backfill") or live_file.get("carried_over"):
        return None
    entry = sealed_entry(load_static(static_path), season, dt.date.fromisoformat(live_file["as_of"]), today,
                         model_of(static_path), True, fetch_obs, fetch_fc)
    p = live / "archive_east" / str(season) / f"{entry['issued']}.json"
    weekly.write_atomic(p, (json.dumps(entry, separators=(",", ":")) + "\n").encode())
    return p


# ---------------------------------------------------------------- weekly grading
def fetch_east(season, until: dt.date, taxon=47916):
    """This season's research-grade luna records in P4's box (all licences, as the scorecard), observed up to until."""
    from p4 import wide as W
    rows, last = [], 0
    while True:
        js = W._get("observations", {"taxon_id": taxon, **W.BOX, "quality_grade": "research",
                                     "d1": f"{season}-01-01", "d2": until.isoformat(), "per_page": 200,
                                     "order_by": "id", "order": "asc", "id_above": last})
        res = js["results"]
        if not res:
            break
        from hatch_p1 import inat
        rows += [inat._row(o) for o in res]
        last = res[-1]["id"]
        time.sleep(1)
    return pd.DataFrame(rows)


def first_brood(raw, season, static, score_date: dt.date):
    """P1's filters, posted by score_date, outside the Midwest states, each record's place, its cut-off."""
    from p4 import wide as W
    d = raw
    if "created_at" in d and len(d):
        posted = pd.to_datetime(d["created_at"].astype(str).str[:10], errors="coerce")
        d = d[posted.isna() | (posted <= pd.Timestamp(score_date))]
    if not len(d):
        return pd.DataFrame(columns=["band", "doy", "date"])
    d = W.outside_midwest(W.clean_wide(d, years=(season, season)), [])
    d = d.assign(band=W.region_cell(d.lat.to_numpy(), d.lng.to_numpy()))
    cuts = {c: p["cutoff"] for c, p in static["places"].items()}
    d = d[d.band.isin(cuts) & (d.date <= pd.Timestamp(score_date)) & (d.doy >= S.FIRST_DOY)]
    return d[d.doy <= d.band.map(cuts)][["band", "doy", "date"]]


def tally(rows):
    """n-weighted mean miss of the clock and the calendar over scored places; D = clock - calendar."""
    sc = [r for r in rows if r.get("status") == "scored"]
    n = sum(r["n"] for r in sc)
    if not sc:
        return {"places": 0, "records": 0, "clock": None, "calendar": None, "D": None, "clock_wins": 0}
    hx = sum(r["n"] * r["miss"] for r in sc) / n
    hc = sum(r["n"] * r["calendar_miss"] for r in sc) / n
    return {"places": len(sc), "records": n, "clock": round(hx, 2), "calendar": round(hc, 2),
            "D": round(hx - hc, 6), "clock_wins": sum(r["miss"] < r["calendar_miss"] for r in sc)}


def decide(t, final):
    """EAST_2027.md. -> (verdict, reason)."""
    if not final:
        return "in_progress", "the verdict is given on the week of 27 Sep 2027"
    if t["places"] < MIN_PLACES or t["records"] < MIN_RECORDS:
        return "no_verdict", f"fewer than {MIN_PLACES} scored places or {MIN_RECORDS} records"
    if t["D"] <= -MARGIN and 2 * t["clock_wins"] >= t["places"]:
        return "clock_wins", "the clock missed at least 1 day less and won at least half the places"
    return "calendar_stays", "the clock did not clear the bar"


def grade(live: Path, season, today: dt.date, raw, static_path=STATIC):
    static = load_static(static_path)
    entries = S.load_archive(live / "archive_east", season)
    model = S.frozen_model(entries)
    monday = S.week_start(today)
    card = live / "league" / str(season) / "east.json"
    prev = S.read_card(card)
    frozen = S.frozen_rows(prev, season, LAYER, model, monday)
    recs = first_brood(raw, season, static, monday)
    rows = []
    for c, p in static["places"].items():
        if c in frozen:
            rows.append(frozen[c])
            continue
        r = S.score_band(c, recs[recs.band == c], season, p["cutoff"], monday, entries, model,
                         {c: (p["calendar"]["onset"], p["calendar"]["peak"])})
        if r.get("status") == "scored":
            r["scored_on"] = monday.isoformat()
        rows.append(r)
    layer = {"model": model, "bands": rows}
    weekly.write_atomic(card, json.dumps({"season": season, "score_date": monday.isoformat(), "layers": {LAYER: layer}},
                                         separators=(",", ":"), allow_nan=False).encode())
    t = tally(rows)
    verdict, reason = decide(t, season == VERDICT.year and monday >= VERDICT)
    return {"version": 1, "kind": "league_east", "season": season, "score_date": monday.isoformat(),
            "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "model": model, "nights": len(entries), "places": rows, "tally": t, "verdict": verdict, "reason": reason,
            "verdict_date": VERDICT.isoformat(),
            "rule": {"margin_days": MARGIN, "min_places": MIN_PLACES, "min_records": MIN_RECORDS,
                     "plain": "the clock earns an eastern layer only if its record-weighted miss is at least 1 day "
                              "lower than each place's calendar and it wins at least half the scored places"}}


def weekly_run(live: Path, season, today: dt.date, fetch=fetch_east, force=False, static_path=STATIC):
    """Once per scoring week (capped at the verdict week). -> the path written, or None."""
    if season not in SEASONS:
        return None
    today = min(today, VERDICT)
    out = live / "league_east.json"
    old = S.read_card(out)
    if not force and old and old.get("season") == season and old.get("score_date") == S.week_start(today).isoformat():
        return None
    monday = S.week_start(today)
    p = live / "records" / str(season) / "east" / f"{monday.isoformat()}.parquet"
    sidecar = p.with_suffix(".sha256")
    if p.exists() and sidecar.exists():
        if sidecar.read_text().split()[0] != weekly.sha256(p):
            raise RuntimeError(f"{p} does not match its sha256")
        raw = pd.read_parquet(p)
    else:
        raw = fetch(season, today)
        older = sorted(q for q in p.parent.glob("*.parquet") if q.name < p.name)
        if older and len(raw) < 0.9 * len(pd.read_parquet(older[-1])):
            raise RuntimeError(f"east records pull: {len(raw)} rows, under 90% of last week's; not saving it")
        buf = io.BytesIO()
        raw.to_parquet(buf)
        weekly.write_atomic(p, buf.getvalue())
        weekly.write_atomic(sidecar, f"{weekly.sha256(p)}  {p.name}\n".encode())
    table = grade(live, season, today, raw, static_path)
    weekly.write_atomic(out, (json.dumps(table, separators=(",", ":"), allow_nan=False) + "\n").encode())
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--live", type=Path, required=True)
    ap.add_argument("--season", type=int)
    ap.add_argument("--today", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    p = weekly_run(a.live, a.season or a.today.year, a.today, force=a.force)
    print(f"east: {p or 'nothing to do'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
