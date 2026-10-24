#!/usr/bin/env python3
"""Score the south-bias candidates (PREREG.md) on leave-one-year-out, the WI/MN holdout and the 2026 season.

    python3 notebooks/southbias/run.py [--workers 4]

Stage 1 refits P4 (gate) and the two-clock mixture in every fold (about 1.5-2 h on 4 cores; cached in
notebooks/data/southbias_cache/, gitignored). P3 itself is never refitted: its stored fold fits are used.
Stage 2 predicts and scores everything and writes results/. Inputs as pipeline/fit/south_bias.py (cached data only).
"""
import argparse
import json
import multiprocessing as mp
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(ROOT / "pipeline"), str(ROOT / "notebooks")]

from fit import context, evaluate as EV, model as M  # noqa: E402
import sb  # noqa: E402

FIT_RESULTS = ROOT / "pipeline" / "fit" / "results"
CACHE = ROOT / "notebooks" / "data" / "southbias_cache"
OUT = HERE / "results"
SOUTH = "37-39"
CANDS = ["p3", "a1_cap", "a2_flag", "b_gate", "c_mix", "half", "cal"]
LABEL = {"p3": "P3 (map today)", "a1_cap": "A1 cap the bank at the fit's range", "a2_flag": "A2 flag + half-blend",
         "b_gate": "B P4 daylength gate", "c_mix": "C two clocks", "half": "always half-blend (reference)",
         "cal": "calendar"}
LOYO_P = json.loads((FIT_RESULTS / "loyo_params.json").read_text())
HOLD_P = json.loads((FIT_RESULTS / "headline.json").read_text())["holdout_params"]["p3_photo"]["params"]
CTX = H = None


def _init():
    global CTX, H
    if CTX is None:
        CTX = context.load_context()
        H = EV.helpers(CTX)


def _cached(name, fn):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{name}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    out = fn()
    f.write_bytes(pickle.dumps(out))
    return out


# ---------------------------------------------------------------- folds
def fold_data(year):
    """year: an int (leave that year out, all states) or 'holdout' (train IL/IN/OH, all years)."""
    rec = CTX.rec
    tr_all = rec[rec.year != year] if year != "holdout" else rec[rec.state.isin(EV.TRAIN_STATES)]
    cuts = EV.cutoffs(tr_all)
    train = EV.first_brood(tr_all, cuts)
    p3 = sb.no_year(LOYO_P[str(year)]["p3_photo"]["params"] if year != "holdout" else HOLD_P)
    return tr_all, cuts, train, p3


def _fit_fold(year):
    _init()
    t0 = time.time()
    _, cuts, train, p3 = fold_data(year)
    P = M.prepare(train, CTX.inc, {b: c - 1 for b, c in cuts.items()}, sb.P3, CTX.E)
    gates = {}
    for g in sb.GATES:
        f = sb.fit_gate(P, {k: v for k, v in p3.items() if k != "u"}, g)
        gates[str(g)] = {"params": {k: (v.tolist() if isinstance(v, np.ndarray) else float(v))
                                    for k, v in f.params.items()}, "nll": f.nll, "converged": f.converged}
    mix = sb.fit_mix(P, p3)
    print(f"[fit] {year} {time.time() - t0:.0f}s gates "
          + " ".join(f"{k}:{v['nll']:.1f}" for k, v in gates.items()) + f" mix:{mix['nll']:.1f} pi={mix['params']['pi']:.2f}",
          flush=True)
    return {"gates": gates, "mix": mix}


def all_fits(workers):
    keys = [int(y) for y in CTX.years] + ["holdout"]
    todo = [k for k in keys if not (CACHE / f"fit_{k}.pkl").exists()]
    if todo:
        with mp.get_context("fork").Pool(workers) as pool:
            for k, r in zip(todo, pool.imap(_fit_fold, todo)):
                CACHE.mkdir(parents=True, exist_ok=True)
                (CACHE / f"fit_{k}.pkl").write_bytes(pickle.dumps(r))
    return {k: pickle.loads((CACHE / f"fit_{k}.pkl").read_bytes()) for k in keys}


def candidates(p3, fits, env):
    """The candidate models of one fold. P4's gate is the one with the best training penalised likelihood."""
    g = min(fits["gates"], key=lambda k: fits["gates"][k]["nll"])
    gate = None if g == "None" else float(g)
    return {"p3": sb.Cand("p3", p3), "a1_cap": sb.Cand("cap", p3, env=env),
            "b_gate": sb.Cand("gate", sb.no_year(fits["gates"][g]["params"]), gate=gate),
            "c_mix": sb.Cand("mix", sb.no_year(fits["mix"]["params"]))}, gate


def predict(cands, inc, lat, w, cut, ep, cal_on, cal_pk, env):
    """Onset/peak (day index) of every candidate for one band-year; plus A2's blend weight."""
    out = {}
    for name, c in cands.items():
        out[name] = sb.predict_band(c.flight(inc, lat), w, cut, ep)
    o, p = out["p3"]
    wt = sb.blend_weight(sb.flagged(inc, env, p), w)
    out["a2_flag"] = (sb.blend(o, cal_on, wt), sb.blend(p, cal_pk, wt))
    out["half"] = (sb.blend(o, cal_on, 0.5), sb.blend(p, cal_pk, 0.5))
    out["cal"] = (cal_on, cal_pk)
    return out, wt


def loyo_rows(fits):
    rows, recs, gates, envs = [], {}, {}, {}
    for y in CTX.years:
        y = int(y)
        _, cuts, train, p3 = fold_data(y)
        env = envs[y] = sb.envelope(CTX.cum, train.h.to_numpy(), train.y.to_numpy())
        cands, gates[y] = candidates(p3, fits[y], env)
        test = EV.first_brood(CTX.rec[CTX.rec.year == y], cuts)
        eprof = EV.effort_profile(CTX.E, sorted(train.y.unique()))
        cal = EV._band_calendar(train)
        for x in EV.targets(test).itertuples():
            hx, w = EV.hex_weights(train[train.band == x.band])
            yi = y - int(CTX.years[0])
            co, cp = cal(x.band, hx, w)
            pr, wt = predict(cands, CTX.inc[hx, yi, :].astype(float), H.hex_lat[hx], w, cuts[x.band] - 1,
                             eprof[H.hex_state[hx]], co, cp, env)
            row = {"band": x.band, "year": y, "n": int(x.n), "onset": float(x.onset), "peak": float(x.peak), "a2_w": wt}
            for k, (o, p) in pr.items():
                row[f"{k}_onset"], row[f"{k}_peak"] = float(o), float(p)
            rows.append(row)
        recs.update({(b, int(yy)): g[["t", "user_id"]].to_numpy() for (b, yy), g in test.groupby(["band", "year"])})
    return rows, recs, gates, envs


def holdout_rows(fits):
    rec = CTX.rec
    _, cuts_tr, train, p3 = fold_data("holdout")
    env = sb.envelope(CTX.cum, train.h.to_numpy(), train.y.to_numpy())
    cands, gate = candidates(p3, fits["holdout"], env)
    tr_tg = EV.targets(train)
    lat_by = train.assign(lat=H.hex_lat[train.h]).groupby(["band", "year"])["lat"].mean()
    tr_tg = tr_tg.merge(lat_by.rename("lat").reset_index(), on=["band", "year"])
    ca = {k: np.polyfit(tr_tg.lat, tr_tg[k], 1) for k in ("onset", "peak")}
    te_all = rec[rec.state.isin(EV.HOLDOUT_STATES)]
    rows, recs = [], {}
    for year in sorted(te_all.year.unique()):
        other = te_all[te_all.year != year]
        cuts = EV.cutoffs(other)
        test = EV.first_brood(te_all[te_all.year == year], cuts)
        tg = EV.targets(test)
        if tg.empty:
            continue
        ref = EV.first_brood(other, cuts)
        eprof = EV.effort_profile(CTX.E, [y for y in range(len(CTX.years)) if y != year - CTX.years[0]])
        for x in tg.itertuples():
            hx, w = EV.hex_weights(ref[ref.band == x.band])
            lat = float((H.hex_lat[hx] * w).sum())
            co, cp = float(np.polyval(ca["onset"], lat)), float(np.polyval(ca["peak"], lat))
            pr, wt = predict(cands, CTX.inc[hx, int(year - CTX.years[0]), :].astype(float), H.hex_lat[hx], w,
                             cuts[x.band] - 1, eprof[H.hex_state[hx]], co, cp, env)
            row = {"band": x.band, "year": int(year), "n": int(x.n), "onset": float(x.onset), "peak": float(x.peak),
                   "a2_w": wt}
            for k, (o, p) in pr.items():
                row[f"{k}_onset"], row[f"{k}_peak"] = float(o), float(p)
            rows.append(row)
        recs.update({(b, int(y)): g[["t", "user_id"]].to_numpy() for (b, y), g in test.groupby(["band", "year"])})
    return rows, recs, gate


def season_2026(fits, envs, gates):
    """2026 strip dates (calendar doy) per candidate, as south_bias.py: PRISM, median over the 11 fold fits."""
    from fit import south_bias as SB
    from live import build_live as L
    inc = SB.season_dd(2026)
    allr, fw, _ = SB.first_wave_records()
    real = {(b, int(y)): (float(np.quantile(g.doy, .1)), float(np.median(g.doy)), len(g))
            for (b, y), g in fw.groupby(["band", "year"]) if len(g) >= 20}
    labels = list(SB.BAND_LABELS)
    cal = {b: (np.mean([v[0] for (bb, y), v in real.items() if bb == b and y < 2026]),
               np.mean([v[1] for (bb, y), v in real.items() if bb == b and y < 2026])) for b in labels}
    per = {k: [] for k in CANDS}
    w_a2 = []
    for y in SB.YEARS:
        p3, cut = SB.FOLDS[y]
        cutc = np.array([cut[b] - 1 for b in SB.CBAND])
        cands, _ = candidates(p3, fits[y], envs[y])
        strip = {}
        for k, c in cands.items():
            strip[k] = np.array(L.band_reach(sb.sighting_share(c.flight(inc, SB.clat), cutc, SB.EPROF), SB.BW), float)
        ws = []
        a2, half = np.zeros((5, 2)), np.zeros((5, 2))
        for B, b in enumerate(labels):
            wt = sb.blend_weight(sb.flagged(inc, envs[y], strip["p3"][B, 1] - 1), SB.BW[B])
            ws.append(wt)
            for q in range(2):
                a2[B, q] = sb.blend(strip["p3"][B, q], cal[b][q], wt)
                half[B, q] = sb.blend(strip["p3"][B, q], cal[b][q], 0.5)
        strip["a2_flag"], strip["half"] = a2, half
        strip["cal"] = np.array([cal[b] for b in labels])
        w_a2.append(ws)
        for k in CANDS:
            per[k].append(strip[k])
    med = {k: np.median(np.array(v), 0) for k, v in per.items()}
    rows = []
    for B, b in enumerate(labels):
        o, p, n = real[(b, 2026)]
        row = {"band": b, "n": n, "onset": o, "peak": p, "a2_w": float(np.median([w[B] for w in w_a2]))}
        for k in CANDS:
            row[f"{k}_onset"], row[f"{k}_peak"] = float(med[k][B, 0]), float(med[k][B, 1])
        rows.append(row)
    return rows, {"p3_check_south": [float(v) for v in SB.strip_dates(inc, SB.YEARS)[0]],
                  "south_dd_15apr_2026": SB.strip_dd(np.cumsum(inc, 1), SOUTH, SB.D15APR)}


# ---------------------------------------------------------------- scoring
def mae(d, k, mask=None):
    d = d if mask is None else d[mask]
    return float(((d[f"{k}_onset"] - d.onset).abs().mean() + (d[f"{k}_peak"] - d.peak).abs().mean()) / 2)


def signed(d, k, mask):
    d = d[mask]
    return {"onset": round(float((d[f"{k}_onset"] - d.onset).mean()), 1),
            "peak": round(float((d[f"{k}_peak"] - d.peak).mean()), 1)}


def coverage(d, k, widen=False, cal="cal"):
    """'Likely' range = forecast + the 10th..90th percentile of the other years' misses (real - forecast), per
    onset and peak, as the map's honest window (CALIBRATION.md). widen: flagged rows reach out to the calendar."""
    hit, width = [], []
    for q in ("onset", "peak"):
        res = d[q] - d[f"{k}_{q}"]
        for i, x in d.iterrows():
            other = res[d.year != x.year]
            lo, hi = x[f"{k}_{q}"] + np.percentile(other, 10), x[f"{k}_{q}"] + np.percentile(other, 90)
            if widen and x.a2_w > 0:
                lo, hi = min(lo, x[f"{cal}_{q}"]), max(hi, x[f"{cal}_{q}"])
            hit.append(lo <= x[q] <= hi)
            width.append(hi - lo)
    return round(float(np.mean(hit)), 3), round(float(np.mean(width)), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    t0 = time.time()
    _init()
    fits = all_fits(a.workers)
    print(f"[fits] {time.time() - t0:.0f}s", flush=True)
    lr, lrec, gates, envs = loyo_rows(fits)
    hr, hrec, hgate = holdout_rows(fits)
    r26, chk = season_2026(fits, envs, gates)
    d, hd, d26 = pd.DataFrame(lr), pd.DataFrame(hr), pd.DataFrame(r26)

    # P3's stored LOYO predictions must be reproduced exactly (same fits, same code path)
    ref = pd.read_csv(FIT_RESULTS / "loyo_rows.csv")
    m = d.merge(ref, on=["band", "year"])
    repro = float(np.abs(np.r_[m.p3_onset - m.p3_photo_onset, m.p3_peak - m.p3_photo_peak]).max())

    models = [k for k in CANDS]
    de = EV.errors(lr, models)
    ci = EV.bootstrap(de, lrec, models, ref="p3")
    south = d.band == SOUTH
    s26 = d26.band == SOUTH
    tab = {}
    for k in models:
        tab[k] = {"label": LABEL[k],
                  "loyo_mae": round(mae(d, k), 2), "loyo_minus_p3_ci": [round(v, 2) for v in ci[k].get("minus_ref_ci", [0, 0])],
                  "loyo_south_mae": round(mae(d, k, south), 2), "loyo_south_bias": signed(d, k, south),
                  "holdout_mae": round(mae(hd, k if k != "cal" else "cal"), 2),
                  "y2026_mae": round(mae(d26, k), 2), "y2026_south_mae": round(mae(d26, k, s26), 2),
                  "y2026_south": {"onset": round(float(d26[s26][f"{k}_onset"].iloc[0]), 1),
                                  "peak": round(float(d26[s26][f"{k}_peak"].iloc[0]), 1)},
                  "y2026_by_strip_mae": {r.band: round(mae(d26, k, d26.band == r.band), 1) for r in d26.itertuples()}}
    changed = {k: {"loyo": int(((d[f"{k}_onset"] - d.p3_onset).abs().gt(0.01) | (d[f"{k}_peak"] - d.p3_peak).abs().gt(0.01)).sum()),
                   "holdout": int(((hd[f"{k}_onset"] - hd.p3_onset).abs().gt(0.01) | (hd[f"{k}_peak"] - hd.p3_peak).abs().gt(0.01)).sum())}
               for k in ("a1_cap", "a2_flag", "b_gate", "c_mix")}
    cov = {"p3": coverage(d, "p3"), "a2_widened": coverage(d, "p3", widen=True)}
    # 2026 likely range: forecast + all LOYO misses' 10th..90th percentiles
    q = {k: np.percentile(d[k] - d[f"p3_{k}"], [10, 90]) for k in ("onset", "peak")}
    win = {}
    for r in d26.itertuples():
        for k in ("onset", "peak"):
            lo, hi = getattr(r, f"p3_{k}") + q[k][0], getattr(r, f"p3_{k}") + q[k][1]
            wl, wh = (min(lo, getattr(r, f"cal_{k}")), max(hi, getattr(r, f"cal_{k}"))) if r.a2_w > 0 else (lo, hi)
            win[f"{r.band} {k}"] = {"real": getattr(r, k), "p3_range": [round(lo, 1), round(hi, 1)],
                                    "widened": [round(wl, 1), round(wh, 1)]}
    params = {"gate_chosen": {str(k): v for k, v in gates.items()}, "gate_holdout": hgate,
              "gate_nll": {str(k): {g: round(v["nll"], 1) for g, v in f["gates"].items()} for k, f in fits.items()},
              "mix": {str(k): {n: round(f["mix"]["params"][n], 3) for n in ("pi", "m0", "b", "log_s", "mu0", "gamma")}
                      | {"nll": round(f["mix"]["nll"], 1), "converged": f["mix"]["converged"]} for k, f in fits.items()},
              "p3_nll": {str(k): round(f["gates"]["None"]["nll"], 1) for k, f in fits.items()}}
    out = {"table": tab, "changed_band_years": changed, "loyo_band_years": len(d), "loyo_south_band_years": int(south.sum()),
           "holdout_band_years": len(hd), "coverage_loyo": cov, "windows_2026": win, "params": params,
           "p3_repro_max_abs_diff": repro, "checks_2026": chk, "a2_weights_loyo_nonzero": d[d.a2_w > 0][["band", "year", "a2_w"]].to_dict("records"),
           "a2_weights_holdout_nonzero": hd[hd.a2_w > 0][["band", "year", "a2_w"]].to_dict("records"),
           "a2_weights_2026": dict(zip(d26.band, d26.a2_w.round(3))), "seconds": round(time.time() - t0)}
    OUT.mkdir(exist_ok=True)
    (OUT / "summary.json").write_text(json.dumps(out, indent=1, default=float) + "\n")
    d.to_csv(OUT / "loyo_rows.csv", index=False, float_format="%.2f")
    hd.to_csv(OUT / "holdout_rows.csv", index=False, float_format="%.2f")
    d26.to_csv(OUT / "rows_2026.csv", index=False, float_format="%.2f")
    print(pd.DataFrame(tab).T.drop(columns=["label"]).to_string())
    print(json.dumps({k: out[k] for k in ("changed_band_years", "coverage_loyo", "p3_repro_max_abs_diff", "checks_2026",
                                          "a2_weights_2026")}, default=float))
    print(f"done {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
