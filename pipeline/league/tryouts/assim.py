#!/usr/bin/env python3
"""Tryout: does learning from this year's first sightings sharpen P3's forecast? (exploratory; buys a bench spot only)

Analogy: a GPS that reroutes as you drive. P3 treats a season it has not seen as an average year (year effect 0) until
the season is over. Here, on each forecast's issue date, the year's sightings so far (observed AND posted by then,
every strip) estimate this year's nudge to the warmth target, shrunk toward 0; then the forecast is rerun with it.

Honest replay of past seasons (leave-one-year-out, P3's own fold fits from pipeline/replay/fold_fits.json):
- issue date = the scorecard's: real date (floored) minus 7 days, separately for onset and peak;
- only records observed on or before the issue date AND posted (created_at) by then; first brood by the fold's cut-offs;
- the curve, cut-offs, effort and hex weights are the fold's; only the year nudge u is new.
Weather: the season's real Daymet weather, as P3's leave-one-year-out score used (so both arms see the same weather).

Run: python3 pipeline/league/tryouts/assim.py   (needs notebooks/data from pipeline/replay/build_replay.py)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

from fit import evaluate as E, model as M  # noqa: E402
from fit.context import load_context  # noqa: E402

FOLDS = ROOT / "pipeline" / "replay" / "fold_fits.json"
LEAD = 7
OUT = HERE / "results"


def posted_index(rec, raw):
    """Day index (doy - 1, the record's own year) each record was posted; records not found -> +inf."""
    created = pd.to_datetime(raw.set_index("id")["created_at"].astype(str).str[:10], errors="coerce")
    c = rec["id"].map(created)
    yr = rec["year"].astype(int)
    out = np.where(c.notna() & (c.dt.year == yr), c.dt.dayofyear - 1, np.where(c.notna() & (c.dt.year < yr), -1, np.inf))
    return out.astype(float)


def estimate_u(params, spec, ctx, asof, cuts, issue, tau):
    """MAP year nudge (degree-days) from the records known on day index `issue`; tau = prior SD (inf = no prior)."""
    if len(asof) == 0:
        return 0.0, 0
    cut_idx = {b: min(c - 1, issue) for b, c in cuts.items()}
    P = M.prepare(asof, ctx.inc, cut_idx, spec, ctx.E, year_ids=[asof.y.iloc[0]])
    if len(P.rg) == 0:
        return 0.0, 0
    base = {k: v for k, v in params.items() if k != "u"}

    def f(u):
        p = dict(base, u=np.array([u]))
        v = -(P.rw * M.record_logq(p, spec, P)).sum()
        return v + (0 if not np.isfinite(tau) else u * u / (2 * tau * tau))
    r = optimize.minimize_scalar(f, bounds=(-400, 400), method="bounded", options={"xatol": 0.5})
    return float(r.x), int(len(P.rg))


def main(taus=(15.0, 30.0, 60.0, 120.0, np.inf)):
    ctx = load_context()
    H = E.helpers(ctx)
    raw = pd.read_parquet(ROOT / "notebooks" / "data" / "luna_replay_inat.parquet")
    rec = ctx.rec.copy()
    rec["posted"] = posted_index(rec, raw)
    ff = json.loads(FOLDS.read_text())
    spec = M.SPECS[ff["spec"]]
    rows = []
    for ystr, fold in ff["folds"].items():
        year = int(ystr)
        params, cuts = dict(fold["params"], u=np.array([])), fold["cuts"]
        tr_all = rec[rec.year != year]
        train = E.first_brood(tr_all, cuts)
        test = E.first_brood(rec[rec.year == year], cuts)
        tg = E.targets(test)
        eprof = E.effort_profile(ctx.E, sorted(train.y.unique()))
        yi = year - int(ctx.years[0])
        for x in tg.itertuples():
            hx, w = E.hex_weights(train[train.band == x.band])
            ep = eprof[H.hex_state[hx]]
            inc = ctx.inc[hx, yi, :].astype(float)

            def predict(u):
                return M.predict_band(dict(params, mu0=params["mu0"] + u), spec, inc, H.hex_lat[hx], w, cuts[x.band] - 1, ep)
            o0, p0 = predict(0.0)
            row = {"band": x.band, "year": year, "n": int(x.n), "onset": float(x.onset), "peak": float(x.peak),
                   "p3_onset": o0, "p3_peak": p0}
            for k in ("onset", "peak"):
                issue = int(np.floor(getattr(x, k))) - LEAD
                asof = test[(test.t <= issue) & (test.posted <= issue)]
                row[f"known_{k}"] = int(len(asof))
                row[f"known_band_{k}"] = int((asof.band == x.band).sum())
                for tau in taus:
                    u, n = estimate_u(params, spec, ctx, asof, cuts, issue, tau)
                    tag = "inf" if not np.isfinite(tau) else f"{tau:g}"
                    row[f"u{tag}_{k}"] = u
                    row[f"a{tag}_{k}"] = predict(u)[0 if k == "onset" else 1]
            rows.append(row)
            print(f"{year} {x.band}: known onset/peak {row['known_onset']}/{row['known_peak']}  "
                  f"u30 {row['u30_onset']:+.0f}/{row['u30_peak']:+.0f}", flush=True)
    d = pd.DataFrame(rows)
    OUT.mkdir(exist_ok=True)
    d.to_csv(OUT / "assim_rows.csv", index=False)
    tab = [{"model": "p3", "onset": (d.p3_onset - d.onset).abs().mean(), "peak": (d.p3_peak - d.peak).abs().mean()}]
    for tau in taus:
        tag = "inf" if not np.isfinite(tau) else f"{tau:g}"
        tab.append({"model": f"assim tau={tag}", "onset": (d[f"a{tag}_onset"] - d.onset).abs().mean(),
                    "peak": (d[f"a{tag}_peak"] - d.peak).abs().mean()})
    t = pd.DataFrame(tab)
    t["mae"] = (t.onset + t.peak) / 2
    print(t.round(2).to_string(index=False))
    return d, t


if __name__ == "__main__":
    main()
