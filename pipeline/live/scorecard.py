#!/usr/bin/env python3
"""Live scorecard (plan v2, P5): how this season's forecast did, latitude strip by latitude strip, once the moths are in.

Analogy: marking a weather forecast after the week is over, using only forecasts that were written down beforehand.
1. Every night's forecast is archived (`--add`): just its strip dates, the day 10% (onset) and 50% (peak) of each
   strip's expected first-wave sightings have happened, plus the frozen model's id and hash.
2. Once a week (the Monday on or before `--today`), each strip is checked against real sightings: iNaturalist
   research-grade records, the same filters the fit uses (FROZEN_P3.md), first wave only.
3. A strip is scored only when its first wave is over AND every record in it is at least 14 days old (people post
   late, and records take time to be confirmed): until then it is "pending". Never scored early.
4. The forecast graded for each date is the newest archived one issued at least LEAD_DAYS before that date really
   happened, and only one from the season's frozen model (the model id + hash of the season's first forecast).
5. Each strip's real onset / peak = 10th percentile / median day of its first-wave records (>= 20 records), and the
   comparison is the calendar: the strip's mean onset / peak over 2015-2025 (the P3 calendar baseline).
6. A strip's score is frozen the week it is first given: later weeks copy that row from the last published scorecard
   (`scored_on` says when), so late uploads never move a published score.

Run: python3 pipeline/live/scorecard.py --archive live/archive --season 2027 --add live/latest.json --out live/scorecard.json
     (rehearse.py runs it on 2026 with rebuilt as-of forecasts)
"""
import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "notebooks"))

REPLAY = ROOT / "src" / "data" / "luna-replay.json"
SETTLE_DAYS = 14        # a record counts once it is this old; a strip is scored once its whole window is
LEAD_DAYS = 7           # grade the forecast issued at least a week before the real date
MIN_N = 20              # as P3: a strip needs >= 20 first-wave records to be scored
FALLBACK_CUT = 240      # as P3: records after day 240 are never first wave
FIRST_DOY = 60          # 1 March (non-leap) / 29 Feb: the model's first day
Q_ONSET, Q_PEAK = 0.10, 0.50
TAXON = 47916


def doy_date(season, doy):
    return dt.date(season, 1, 1) + dt.timedelta(days=int(doy) - 1)


def week_start(d: dt.date) -> dt.date:
    """Scores move once a week: the Monday on or before d."""
    return d - dt.timedelta(days=d.weekday())


# ---------------------------------------------------------------- archive
def archive_entry(live, issued=None, rehearsal=False):
    """The part of a nightly live file the scorecard needs, small enough to keep every night."""
    issued = issued or live["generated"][:10]
    e = {"version": 1, "season": live["season"], "issued": issued, "as_of": live["as_of"],
         "model": {"id": live["model"]["id"], "hash": live["model"].get("hash")}, "bands": live["bands"]}
    if rehearsal:
        e["rehearsal"] = True
    return e


def add_to_archive(archive: Path, live, issued=None, rehearsal=False):
    e = archive_entry(live, issued, rehearsal)
    out = archive / str(e["season"]) / f"{e['issued']}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(e, separators=(",", ":")) + "\n")
    return out


def load_archive(archive: Path, season):
    d = archive / str(season)
    return sorted((json.loads(p.read_text()) for p in d.glob("*.json")), key=lambda e: e["issued"]) if d.is_dir() else []


def frozen_model(entries):
    """The season's model is whatever its first archived forecast used; later forecasts from any other model are not
    graded (the model must not grade its own homework, nor a mid-season swap)."""
    return entries[0]["model"] if entries else None


def pick_forecast(entries, model, latest_issue: dt.date):
    """Newest forecast from the season's model issued on or before latest_issue, else None."""
    best = None
    for e in entries:
        if e["model"] == model and dt.date.fromisoformat(e["issued"]) <= latest_issue:
            best = e
    return best


# ---------------------------------------------------------------- sightings
def fetch_records(season, until: dt.date):
    """This season's research-grade luna records in the 7 states (all licences, as the fit), observed up to `until`."""
    from hatch_p1 import inat
    rows, last = [], 0
    while True:
        js = inat._get("observations", {
            "taxon_id": TAXON, "place_id": ",".join(map(str, inat.MIDWEST_PLACES)), "quality_grade": "research",
            "d1": f"{season}-01-01", "d2": until.isoformat(), "per_page": 200, "order_by": "id", "order": "asc",
            "id_above": last})
        res = js["results"]
        if not res:
            break
        rows += [inat._row(o) for o in res]
        last = res[-1]["id"]
        time.sleep(1)
    return pd.DataFrame(rows)


def first_wave(raw, season, cuts, score_date: dt.date):
    """Cleaned first-wave records known by score_date: P1/P3 filters (research grade, wild, exact location, adult or
    unannotated, one per observer + hex + day), posted by score_date, day 60 to the strip's cut-off."""
    from hatch_p1.prep import clean
    d = raw
    if "created_at" in d and len(d):
        posted = pd.to_datetime(d["created_at"].astype(str).str[:10], errors="coerce")
        d = d[posted.isna() | (posted <= pd.Timestamp(score_date))]
    if not len(d):
        return pd.DataFrame(columns=["band", "doy"])
    d = clean(d, years=(season, season))
    d = d[(d.date <= pd.Timestamp(score_date)) & (d.doy >= FIRST_DOY)]
    d = d[d.doy <= d.band.astype(str).map(cuts).astype(int)]
    return d[["band", "doy", "date"]].assign(band=d.band.astype(str))


# ---------------------------------------------------------------- scoring
def calendar(replay):
    """Each strip's mean onset / peak over its scored 2015-2025 band-years (the P3 calendar baseline)."""
    out = {}
    for s in replay["scores"]:
        out.setdefault(s["band"], []).append((s["obs_onset"], s["obs_peak"]))
    return {b: (float(np.mean([v[0] for v in x])), float(np.mean([v[1] for v in x]))) for b, x in out.items()}


def settles_on(season, cut):
    """The day a strip can first be scored: its first-wave window is over and its last day is SETTLE_DAYS old."""
    return doy_date(season, cut) + dt.timedelta(days=SETTLE_DAYS)


def lean(err):
    """Plain words for forecast minus real: positive = the forecast was late, so the moths came earlier."""
    if err is None:
        return None
    if abs(err) < 2:
        return "on time"
    return f"moths {abs(round(err))} days {'earlier' if err > 0 else 'later'} than forecast"


def score_band(band, recs, season, cut, score_date, entries, model, cal):
    """One strip's row. status: scored / pending (window open or not settled) / too_few / no_forecast."""
    settle = settles_on(season, cut)
    row = {"band": band, "cutoff": cut, "settles_on": settle.isoformat(), "n": int(len(recs)),
           "pending_records": int((recs.date > pd.Timestamp(score_date - dt.timedelta(days=SETTLE_DAYS))).sum())
           if len(recs) else 0}
    if score_date < settle:
        return {**row, "status": "pending"}
    if len(recs) < MIN_N:
        return {**row, "status": "too_few"}
    real = {"onset": float(np.quantile(recs.doy, Q_ONSET)), "peak": float(np.quantile(recs.doy, Q_PEAK))}
    out = {**row, "status": "scored"}
    errs, cal_errs = [], []
    for k, c in zip(("onset", "peak"), cal.get(band, (np.nan, np.nan))):
        e = pick_forecast(entries, model, doy_date(season, int(np.floor(real[k]))) - dt.timedelta(days=LEAD_DAYS))
        f = next((b for b in (e or {}).get("bands", []) if b["band"] == band), None)
        if f is None or f.get(k) is None:
            return {**row, "status": "no_forecast"}
        out[k] = {"real": round(real[k], 1), "forecast": f[k], "likely": [f.get(f"{k}_lo"), f.get(f"{k}_hi")],
                  "calendar": round(c, 1), "issued": e["issued"], "as_of": e["as_of"],
                  "error": round(f[k] - real[k], 1), "calendar_error": round(c - real[k], 1)}
        lo, hi = f.get(f"{k}_lo"), f.get(f"{k}_hi")
        out[k]["inside"] = lo is not None and hi is not None and lo <= real[k] <= hi
        errs.append(abs(f[k] - real[k]))
        cal_errs.append(abs(c - real[k]))
    out["miss"] = round(float(np.mean(errs)), 1)              # P3's metric: mean of |onset error| and |peak error|
    out["calendar_miss"] = round(float(np.mean(cal_errs)), 1)
    out["note"] = lean(out["peak"]["error"])
    return out


def frozen_rows(prev, season, layer, model, score_date):
    """Scored rows of the last published scorecard that stay as they are: same season and model, published on or
    before this week. Anything else (another season, another model, a file from a later week) freezes nothing."""
    if not prev or prev.get("season") != season or str(prev.get("score_date")) > score_date.isoformat():
        return {}
    pl = (prev.get("layers") or {}).get(layer) or {}
    if pl.get("model") != model:
        return {}
    return {r["band"]: r for r in pl.get("bands", []) if r.get("status") == "scored"}


def scorecard(season, raw, entries, today: dt.date, replay=None, layer="luna", prev=None):
    """This week's scorecard. prev: the last published one; its scored strips are kept as they were (frozen)."""
    replay = replay or json.loads(REPLAY.read_text())
    score_date = week_start(today)
    cuts = {b["label"]: int(b["cutoff"] or FALLBACK_CUT) for b in replay["bands"]}
    cuts = {b: min(c, FALLBACK_CUT) for b, c in cuts.items()}
    rec = first_wave(raw, season, cuts, score_date)
    model = frozen_model(entries)
    cal = calendar(replay)
    keep = frozen_rows(prev, season, layer, model, score_date)
    rows = []
    for b in cuts:
        if b in keep:
            rows.append(keep[b])
            continue
        r = score_band(b, rec[rec.band == b], season, cuts[b], score_date, entries, model, cal)
        if r["status"] == "scored":
            r["scored_on"] = score_date.isoformat()
        rows.append(r)
    done = [r for r in rows if r["status"] == "scored"]
    summary = {"scored": len(done), "pending": sum(r["status"] == "pending" for r in rows),
               "too_few": sum(r["status"] == "too_few" for r in rows),
               "no_forecast": sum(r["status"] == "no_forecast" for r in rows),
               "miss": round(float(np.mean([r["miss"] for r in done])), 1) if done else None,
               "calendar_miss": round(float(np.mean([r["calendar_miss"] for r in done])), 1) if done else None,
               "inside": sum(r[k]["inside"] for r in done for k in ("onset", "peak")), "dates": 2 * len(done),
               "pending_records": int(sum(r["pending_records"] for r in rows))}
    return {
        "version": 1, "kind": "scorecard", "season": season,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "score_date": score_date.isoformat(),
        "rehearsal": any(e.get("rehearsal") for e in entries),
        "rules": {"settle_days": SETTLE_DAYS, "lead_days": LEAD_DAYS, "min_records": MIN_N,
                  "frozen": "a strip's score is kept as first given (scored_on); later uploads do not change it",
                  "real": "10th percentile (onset) and median (peak) day of the strip's first-wave research-grade records",
                  "calendar": "the strip's mean onset / peak over 2015-2025",
                  "forecast": f"the newest archived forecast from the season's model issued at least {LEAD_DAYS} days before each real date"},
        "layers": {layer: {"model": model, "forecasts": len(entries),
                           "other_model": sum(e["model"] != model for e in entries),
                           "summary": summary, "bands": rows}},
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--archive", type=Path, required=True, help="archive folder (holds <season>/<issued>.json)")
    ap.add_argument("--season", type=int)
    ap.add_argument("--add", type=Path, help="a live latest.json to archive first (skipped for a backfill)")
    ap.add_argument("--records", type=Path, help="season records parquet (default: fetch from iNaturalist)")
    ap.add_argument("--today", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    season = a.season or a.today.year
    if a.add:
        live = json.loads(a.add.read_text())
        if live.get("backfill"):
            print("not archiving a backfill: its weather is older than its issue date")
        elif "bands" in live and live["season"] == season:
            print(f"archived {add_to_archive(a.archive, live)}")
    entries = load_archive(a.archive, season)
    raw = pd.read_parquet(a.records) if a.records else fetch_records(season, a.today)
    prev = None
    if a.out.exists():                       # the last published file: its scored strips stay frozen
        try:
            prev = json.loads(a.out.read_text())
        except ValueError:
            prev = None
    out = scorecard(season, raw, entries, a.today, prev=prev)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    tmp.replace(a.out)
    print(f"wrote {a.out}: {json.dumps(out['layers']['luna']['summary'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
