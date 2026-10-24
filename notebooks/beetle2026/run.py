"""Why the Japanese beetle forecast lost to the calendar in 2026, and whether the loss means much (exploratory).

Reads the committed rehearsal (pipeline/live/archive/japanese-beetle/2026, public/live/scorecard.json), the beetle
replay (public/species/japanese-beetle/replay.json) and the 2026 live forecast (public/live/latest.json), plus the
2026 research-grade records (fetched once into notebooks/data/, which git ignores). Nothing is refit; the frozen
model (japanese-beetle-v0) is only read. Writes results/summary.json; RESULT.md is the write-up.

    python3 notebooks/beetle2026/run.py            # fetches the records the first time
"""
import datetime as dt
import json
import sys
from pathlib import Path

import h3
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(ROOT / "notebooks"))
from live import registry  # noqa: E402
from live import scorecard as S  # noqa: E402

KEY = "japanese-beetle"
SEASON = 2026
SCORED_ON = dt.date(2026, 9, 14)   # the Monday every beetle strip was scored (and frozen)
B = 4000
rng = np.random.default_rng(2026)

sp = registry.BY_KEY[KEY]
replay = json.loads(sp.replay.read_text())
entries = S.load_archive(sp.archive(ROOT / "pipeline" / "live" / "archive"), SEASON)
model = S.frozen_model(entries)
card = json.loads((ROOT / "public" / "live" / "scorecard.json").read_text())["layers"][KEY]
cal = S.calendar(replay)
cuts = {b["label"]: min(int(b["cutoff"] or S.FALLBACK_CUT), S.FALLBACK_CUT) for b in replay["bands"]}

data = ROOT / "notebooks" / "data" / f"{KEY}_{SEASON}_rg.parquet"
if not data.exists():
    data.parent.mkdir(parents=True, exist_ok=True)
    S.fetch_records(SEASON, dt.date(2026, 10, 24), sp.taxon).to_parquet(data)
raw = pd.read_parquet(data)
rec = S.first_wave(raw, SEASON, cuts, SCORED_ON)
out = {}

# ---- 1. Reproduce the published scorecard from today's records
rows = {b: S.score_band(b, rec[rec.band == b], SEASON, cuts[b], SCORED_ON, entries, model, cal) for b in cuts}
repro = {b: (r["miss"], r["calendar_miss"]) for b, r in rows.items()}
pub = {b["band"]: (b["miss"], b["calendar_miss"]) for b in card["bands"]}
out["reproduced"] = {"records": int(len(rec)), "bands": repro, "published": pub,
                     "miss": round(np.mean([v[0] for v in repro.values()]), 2),
                     "calendar_miss": round(np.mean([v[1] for v in repro.values()]), 2)}

# ---- 2. Is the 1.1-day gap more than noise?
# (a) records: resample each strip's records, re-find its real onset and peak (and the forecast graded for them).
by = {b: rec[rec.band == b] for b in cuts}
gaps = np.empty(B)
for i in range(B):
    m, c = [], []
    for b, d in by.items():
        r = S.score_band(b, d.sample(len(d), replace=True, random_state=int(rng.integers(1 << 31))), SEASON, cuts[b],
                         SCORED_ON, entries, model, cal)
        m.append(r["miss"]); c.append(r["calendar_miss"])
    gaps[i] = np.mean(m) - np.mean(c)
out["boot_records"] = {"gap": round(float(np.mean([b["miss"] - b["calendar_miss"] for b in card["bands"]])), 2),
                       "ci95": [round(float(x), 2) for x in np.quantile(gaps, [0.025, 0.975])],
                       "share_forecast_worse": round(float((gaps > 0).mean()), 3)}

# (b) strips and dates: the 10 paired date misses (|forecast - real| - |usual - real|) and the 5 strip means.
d10 = np.array([abs(b[k]["error"]) - abs(b[k]["calendar_error"]) for b in card["bands"] for k in ("onset", "peak")])
d5 = d10.reshape(5, 2).mean(1)


def boot(x):
    m = x[rng.integers(0, len(x), (B, len(x)))].mean(1)
    return [round(float(v), 2) for v in np.quantile(m, [0.025, 0.975])]


def signflip(x):
    """Exact two-sided sign-flip test of mean 0 (every +/- pattern)."""
    n = len(x)
    pats = ((np.arange(1 << n)[:, None] >> np.arange(n)) & 1) * 2 - 1
    return round(float((np.abs((pats * x).mean(1)) >= abs(x.mean()) - 1e-9).mean()), 3)


out["boot_dates"] = {"diffs": d10.round(1).tolist(), "mean": round(float(d10.mean()), 2), "ci95": boot(d10), "p_signflip": signflip(d10)}
out["boot_strips"] = {"diffs": d5.round(2).tolist(), "mean": round(float(d5.mean()), 2), "ci95": boot(d5), "p_signflip": signflip(d5)}

# (c) past years: the same per-year gap in the leave-one-year-out backtest (data.scores, 2015-2025).
sc = pd.DataFrame(replay["scores"])
sc["heat"] = ((sc.heat_onset - sc.obs_onset).abs() + (sc.heat_peak - sc.obs_peak).abs()) / 2
sc["cal"] = ((sc.cal_onset - sc.obs_onset).abs() + (sc.cal_peak - sc.obs_peak).abs()) / 2
yr = sc.groupby("year")[["heat", "cal"]].mean().assign(gap=lambda t: t.heat - t.cal, strips=sc.groupby("year").size())
out["backtest_years"] = {int(y): {k: round(float(v), 2) for k, v in r.items()} for y, r in yr.iterrows()}
out["backtest_years_calendar_won"] = int((yr.gap > 0).sum())
out["backtest_year_gap_sd"] = round(float(yr.gap.std(ddof=1)), 2)
out["backtest_mean"] = {"heat": round(float(sc.heat.mean()), 2), "cal": round(float(sc.cal.mean()), 2)}

# ---- 3. Why: which way, where, and from what
signed = {b["band"]: {k: b[k]["error"] for k in ("onset", "peak")} | {"cal_" + k: b[k]["calendar_error"] for k in ("onset", "peak")}
          for b in card["bands"]}
out["signed_2026"] = signed
sc["bias_onset"] = sc.heat_onset - sc.obs_onset
sc["bias_peak"] = sc.heat_peak - sc.obs_peak
out["backtest_bias_by_band"] = {b: {"onset": round(float(g.bias_onset.mean()), 1), "peak": round(float(g.bias_peak.mean()), 1),
                                    "n": int(len(g))} for b, g in sc.groupby("band")}
# Lead time: the graded forecast (issued >= 7 days ahead) against the last one, on all of 2026's real weather.
last = {b["band"]: b for b in entries[-1]["bands"]}
out["final_weather"] = {"as_of": entries[-1]["as_of"],
                        "bands": {b["band"]: {"onset": last[b["band"]]["onset"] - b["onset"]["real"],
                                              "peak": last[b["band"]]["peak"] - b["peak"]["real"]} for b in card["bands"]}}
# The 37-39 strip's peak forecast through the spring (did it start early, or drift there?).
out["south_peak_by_issue"] = {e["issued"]: next(b["peak"] for b in e["bands"] if b["band"] == "37-39") for e in entries}
# Season length: real onset-to-peak days against forecast (the model stretches a beetle's season; see the app's caveat).
out["onset_to_peak"] = {b["band"]: {"real": round(b["peak"]["real"] - b["onset"]["real"], 1),
                                    "forecast": last[b["band"]]["peak"] - last[b["band"]]["onset"]} for b in card["bands"]}

# Range: are 2026's records in the same hexes the strip forecast is weighted by (the replay's 2015-2025 sightings)?
live = json.loads((ROOT / "public" / "live" / "latest.json").read_text())
cells = live["cells"]
q50 = np.array([m[2] if m[2] is not None else np.nan for m in live["species"][KEY]["median"]], float)
at = {c: i for i, c in enumerate(cells)}
clat = np.array([h3.cell_to_latlng(c)[0] for c in cells])
w_past = np.zeros(len(cells))
for s in replay["sightings"]:
    if not s[5] & 3 and (i := at.get(h3.latlng_to_cell(s[3], s[4], 4))) is not None:
        w_past[i] += 1
w_2026 = np.zeros(len(cells))
# first_wave() keeps band/doy/date only; redo its filters keeping the hex.
from hatch_p1.prep import clean  # noqa: E402
posted = pd.to_datetime(raw["created_at"].astype(str).str[:10], errors="coerce")
full = clean(raw[posted.isna() | (posted <= pd.Timestamp(SCORED_ON))], years=(SEASON, SEASON))
full = full[(full.date <= pd.Timestamp(SCORED_ON)) & (full.doy >= S.FIRST_DOY)]
full = full[full.doy <= full.band.astype(str).map(cuts).astype(int)]
assert len(full) == len(rec)
for h in full.hex:
    if (i := at.get(h)) is not None:
        w_2026[i] += 1
rng_out = {}
for b, (lo, hi) in zip(cuts, [(37, 39), (39, 41), (41, 43), (43, 45), (45, 49)]):
    m = (clat >= lo) & (clat < hi) & np.isfinite(q50)
    wp, wn = w_past * m, w_2026 * m
    new = wn[(wp == 0)].sum() / max(1, wn.sum())   # 2026 records in hexes with no past sighting
    rng_out[b] = {"past_weighted_q50": round(float((wp * np.nan_to_num(q50)).sum() / wp.sum()), 1),
                  "2026_weighted_q50": round(float((wn * np.nan_to_num(q50)).sum() / max(1, wn.sum())), 1),
                  "share_2026_in_new_hexes": round(float(new), 3), "mean_lat_past": round(float((wp * clat).sum() / wp.sum()), 2),
                  "mean_lat_2026": round(float((wn * clat).sum() / max(1, wn.sum())), 2)}
out["range"] = rng_out

(HERE / "results").mkdir(exist_ok=True)
(HERE / "results" / "summary.json").write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps(out, indent=1))
