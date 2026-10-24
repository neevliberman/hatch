#!/usr/bin/env python3
"""How often does the real peak (or onset) land inside the map's "likely" window? (see CALIBRATION.md)

(a) Leave-one-year-out, luna and firefly. The shipped window is forecast + the 10th..90th percentile of every
    scored strip-year's miss (real minus forecast), so the year being scored helped size its own window. The
    honest check sizes each year's window from the *other* years' misses only and scores that year with it.
(b) The 2026 dry run. Live windows (lo/hi in a live/latest.json: 121 members + past misses) against 2026
    first-brood sightings, per latitude strip, the way DRYRUN_2026.md compares medians.
Plus a per-hexagon look (secondary: a hexagon's median of a few sightings is itself noisy).

Coverage comes with a 90% Clopper-Pearson interval. "Clearly off" = 80% falls outside that interval.

Run from the repo root (no refits; the 2026 sightings are downloaded once into notebooks/data/, gitignored):
    python3 pipeline/fit/calibration.py [--live public/live/latest.json other_asof.json ...]
Writes pipeline/fit/results/calibration.json.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import beta

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

import h3  # noqa: E402
from hatch_p1 import inat  # noqa: E402
from hatch_p1.prep import BAND_LABELS, BANDS, clean  # noqa: E402

LEVEL = 0.8
CI = 0.90
REPLAYS = {"luna": ROOT / "src" / "data" / "luna-replay.json", "firefly": ROOT / "public" / "firefly-replay.json"}
RAW_2026 = ROOT / "notebooks" / "data" / "luna_2026_inat.parquet"
OUT = Path(__file__).resolve().parent / "results" / "calibration.json"
MIN_N = 20           # records per strip-year, as P3
SEASON_AS_OF = "2026-05-15"   # the 2026 rerun quoted in the app: a mid-May forecast, before most strips peaked
MIN_HEX = 10         # first-wave sightings per hexagon-year for the secondary per-hexagon look


def cp(k, n, a=1 - CI):
    """Clopper-Pearson interval for k successes out of n."""
    lo = beta.ppf(a / 2, k, n - k + 1) if k > 0 else 0.0
    hi = beta.ppf(1 - a / 2, k + 1, n - k) if k < n else 1.0
    return [round(float(lo), 3), round(float(hi), 3)]


def summary(hits):
    hits = np.asarray(hits, bool)
    k, n = int(hits.sum()), int(hits.size)
    ci = cp(k, n)
    return {"k": k, "n": n, "coverage": round(k / n, 3) if n else None, "ci90": ci,
            "clearly_off": bool(n and not (ci[0] <= LEVEL <= ci[1]))}


def boot_sd_median(days, draws=500, seed=0):
    """Bootstrap SD of a median day: how much the target itself wanders with this few sightings."""
    days = np.asarray(days, float)
    b = np.random.default_rng(seed).choice(days, (draws, len(days)))
    return float(np.median(b, axis=1).std())


def qwin(r):
    lo, hi = np.percentile(r, [100 * (1 - LEVEL) / 2, 100 * (1 + LEVEL) / 2])
    return float(lo), float(hi)


# ---------------------------------------------------------------- (a) leave-one-year-out
def honest_hits(s, kind):
    """Each strip-year scored against a window sized from the *other* years' misses only (real minus forecast)."""
    r = (s[f"obs_{kind}"] - s[f"heat_{kind}"]).to_numpy()
    yrs = s.year.to_numpy()
    hits, widths = [], []
    for i in range(len(r)):
        lo, hi = qwin(r[yrs != yrs[i]])
        hits.append(bool(lo <= r[i] <= hi))
        widths.append(hi - lo)
    return hits, widths


def checked(scores, season=None):
    """The compact record the app reads (interval.checked in the replay JSON): [inside, total, ci90 low %, ci90 high %]
    per target on past years, and optionally a fresh season's strip peaks."""
    s = pd.DataFrame(scores)
    out = {}
    for kind in ("onset", "peak"):
        x = summary(honest_hits(s, kind)[0])
        out[kind] = [x["k"], x["n"], round(100 * x["ci90"][0]), round(100 * x["ci90"][1])]
    if season:
        out["season"] = season
    return out


def season_record(path=None):
    """The fresh-season line for the luna file, from results/calibration.json (None if it was never run)."""
    path = path or OUT
    if not Path(path).exists():
        return None
    runs = json.loads(Path(path).read_text()).get("dryrun_2026", {}).get("runs", [])
    pick = [r for r in runs if r["as_of"] == SEASON_AS_OF]
    if not pick:
        return None
    r = pick[0]
    return {"year": int(r["as_of"][:4]), "as_of": r["as_of"], "peak": [r["peak"]["k"], r["peak"]["n"]]}


def loyo(name):
    d = json.loads(REPLAYS[name].read_text())
    s = pd.DataFrame(d["scores"])
    out = {"strip_years": len(s), "years": int(s.year.nunique()), "shipped_window": d["interval"]}
    for kind in ("onset", "peak"):
        r = (s[f"obs_{kind}"] - s[f"heat_{kind}"]).to_numpy()   # real minus forecast
        lo_s, hi_s = d["interval"][kind]
        shipped = (r >= lo_s) & (r <= hi_s)                       # the shipped window: sized with this year too
        hon, widths = honest_hits(s, kind)
        # as the card shows it: whole days, forecast day + margin rounded
        f = s[f"heat_{kind}"].to_numpy()
        shown = (s[f"obs_{kind}"].to_numpy() >= np.round(f + lo_s)) & (s[f"obs_{kind}"].to_numpy() <= np.round(f + hi_s))
        out[kind] = {"in_sample_shipped": summary(shipped), "honest_other_years": summary(hon),
                     "shipped_as_displayed": summary(shown),
                     "honest_width_days": [round(min(widths), 1), round(float(np.mean(widths)), 1), round(max(widths), 1)],
                     "misses_early": int((r < lo_s).sum()), "misses_late": int((r > hi_s).sum())}
    out["hexagons"] = hex_look(d, s)
    return out


def hex_look(d, s):
    """Per hexagon-year with >= MIN_HEX first-wave exact sightings (the shipped, openly licensed ones): is the
    hexagon's median sighting day inside its own card window (hex 50% day + the honest other-years margin)?"""
    cells = {c: i for i, c in enumerate(d["cells"])}
    sg = pd.DataFrame(d["sightings"], columns=["id", "year", "doy", "lat", "lng", "fl"])
    sg = sg[sg.fl == 0]
    sg["cell"] = [h3.latlng_to_cell(a, b, 4) for a, b in zip(sg.lat, sg.lng)]
    r = (s.obs_peak - s.heat_peak).to_numpy()
    hits, sds = [], []
    for (y, c), g in sg.groupby(["year", "cell"]):
        if len(g) < MIN_HEX or c not in cells or str(y) not in d["forecast"]:
            continue
        q50 = d["forecast"][str(y)][cells[c]][2]
        if q50 is None:
            continue
        lo, hi = qwin(r[s.year.to_numpy() != y])
        hits.append(q50 + lo <= float(np.median(g.doy)) <= q50 + hi)
        sds.append(boot_sd_median(g.doy))
    return {"peak": summary(hits), "min_sightings": MIN_HEX,
            "median_sd_of_hex_target_days": round(float(np.median(sds)), 1) if sds else None}


# ---------------------------------------------------------------- (b) 2026
def fetch_2026():
    if RAW_2026.exists():
        return pd.read_parquet(RAW_2026)
    rows, last = [], 0
    while True:
        js = inat._get("observations", {
            "taxon_id": 47916, "place_id": ",".join(map(str, inat.MIDWEST_PLACES)),
            "d1": "2026-01-01", "d2": "2026-12-31", "per_page": 200, "order_by": "id", "order": "asc",
            "id_above": last})
        res = js["results"]
        if not res:
            break
        rows += [inat._row(o) for o in res]
        last = res[-1]["id"]
        time.sleep(1)
    df = pd.DataFrame(rows)
    df["pulled"] = pd.Timestamp.now(tz="UTC").date().isoformat()
    RAW_2026.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RAW_2026)
    return df


def season_2026():
    rec = clean(fetch_2026(), years=(2026, 2026)).copy()   # P3's record filters (research grade, exact, adult)
    replay = json.loads(REPLAYS["luna"].read_text())
    cut = {b["label"]: (b["cutoff"] or 240) for b in replay["bands"]}
    rec = rec[rec.doy <= rec.band.astype(str).map(cut)]         # first wave, the replay's strip cut-offs
    return rec, replay


def live_check(path, rec, replay):
    L = json.loads(Path(path).read_text())
    ci = {c: i for i, c in enumerate(L["cells"])}
    rec = rec[rec.hex.isin(ci)].copy()
    idx = rec.hex.map(ci).to_numpy()
    med = np.array([L["median"][i][2] if L["median"][i][2] is not None else np.nan for i in idx], float)
    lo = np.array([L["lo"][i][2] if L["lo"][i][2] is not None else np.nan for i in idx], float)
    hi = np.array([L["hi"][i][2] if L["hi"][i][2] is not None else np.nan for i in idx], float)
    rec["med"], rec["lo"], rec["hi"] = med, lo, hi
    strips, hits = [], []
    for b, g in rec.groupby("band", observed=True):
        if len(g) < MIN_N:
            continue
        real = float(np.median(g.doy))
        f, l_, h_ = float(np.median(g.med)), float(np.median(g.lo)), float(np.median(g.hi))
        hit = l_ <= real <= h_
        hits.append(hit)
        strips.append({"strip": str(b), "sightings": int(len(g)), "real_peak": real, "forecast": f,
                       "likely": [l_, h_], "inside": bool(hit)})
    # secondary: hexagons with >= MIN_HEX 2026 first-wave sightings, against their own window
    hg = [g for _, g in rec.groupby("hex") if len(g) >= MIN_HEX]
    hx = [bool(g.lo.iloc[0] <= np.median(g.doy) <= g.hi.iloc[0]) for g in hg]
    hsd = [boot_sd_median(g.doy) for g in hg]
    return {"file": str(Path(path).relative_to(ROOT)) if Path(path).is_relative_to(ROOT) else Path(path).name,
            "as_of": L["as_of"], "strips": strips, "peak": summary(hits), "hexagons": dict(summary(hx), median_sd_of_hex_target_days=round(float(np.median(hsd)), 1) if hsd else None),
            "mean_width_days": round(float(np.mean([s["likely"][1] - s["likely"][0] for s in strips])), 1)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", nargs="*", default=[str(ROOT / "public" / "live" / "latest.json")])
    ap.add_argument("--write-replay", action="store_true",
                    help="also write interval.checked into the two replay JSONs (what build_replay/build_firefly write)")
    a = ap.parse_args(argv)
    res = {"level": LEVEL, "ci": f"{int(CI * 100)}% Clopper-Pearson", "loyo": {n: loyo(n) for n in REPLAYS}}
    rec, replay = season_2026()
    res["dryrun_2026"] = {"records": int(len(rec)), "pulled": str(fetch_2026()["pulled"].iloc[0]),
                          "runs": [live_check(p, rec, replay) for p in a.live]}
    OUT.write_text(json.dumps(res, indent=1) + "\n")
    print(json.dumps(res, indent=1))
    if a.write_replay:
        for name, path in REPLAYS.items():
            d = json.loads(path.read_text())
            d["interval"]["checked"] = checked(d["scores"], season_record() if name == "luna" else None)
            path.write_text(json.dumps(d, separators=(",", ":")))
            print(f"{path.relative_to(ROOT)}: interval.checked = {d['interval']['checked']}")


if __name__ == "__main__":
    main()
