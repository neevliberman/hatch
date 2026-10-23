#!/usr/bin/env python3
"""Run the pre-registered P3 evaluation once (FROZEN_P3.md) and write results/ and figures/.

    python3 pipeline/fit/run_p3.py [--boot-refits 60] [--workers 4]

    python3 pipeline/fit/run_p3.py --model p31_flat --compare p3_photo p3_flat --out results/p3_1
        (P3.1, FROZEN_P3.md amendment: a fixed model, no selection step; cached under p3_cache/p31_flat/)

Stages: (1) choose latitude vs daylength on IL/IN/OH leave-one-year-out log-likelihood (skipped with --model);
(2) leave-one-year-out across all states; (3) spatial holdout IL/IN/OH -> WI/MN;
(4) bootstrap refits for parameter intervals; (5) scores, noise floor, bootstrap CIs, figures.
"""
import argparse
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fit import HERE, context, evaluate as EV, model as M  # noqa: E402

RESULTS = HERE / "results"
CACHE = HERE.parents[1] / "notebooks" / "data" / "p3_cache"   # gitignored; lets a killed run resume
FIGS = HERE / "figures"
CTX = None
H = None


def _init():
    global CTX, H
    if CTX is None:
        CTX = context.load_context()
        H = EV.helpers(CTX)


def _select(year):
    return EV.select_fold(CTX, year, [M.SPECS["p3_lat"], M.SPECS["p3_photo"], M.SPECS["p3_flat"]])


def _loyo(args):
    year, names = args
    r = EV.loyo_fold(CTX, H, year, [M.SPECS[n] for n in names])
    r["fits"] = {k: _fit_json(f) for k, f in r["fits"].items()}
    return r


def _holdout(names):
    r = EV.holdout(CTX, H, [M.SPECS[n] for n in names])
    r["fits"] = {k: _fit_json(f) for k, f in r["fits"].items()}
    return r


def _fit_json(f):
    p = {k: (v.tolist() if isinstance(v, np.ndarray) else float(v)) for k, v in f.params.items()}
    return {"spec": f.spec.name, "params": p, "nll": f.nll, "n": f.n, "converged": f.converged}


def _cached(name, fn):
    """Run fn() once and keep its result in CACHE/name.pkl (delete the folder to start over)."""
    import pickle
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{name}.pkl"
    if "/" in name:
        f.parent.mkdir(parents=True, exist_ok=True)
    if f.exists():
        print(f"[cache] {name}", flush=True)
        return pickle.loads(f.read_bytes())
    out = fn()
    f.write_bytes(pickle.dumps(out))
    return out


def _full_fit(name):
    rec = CTX.rec
    cuts = EV.cutoffs(rec)
    return _fit_json(EV.fit_spec(EV.first_brood(rec, cuts), CTX, cuts, M.SPECS[name]))


def _boot(args):
    """One bootstrap refit, warm-started from the all-data fit (already in the right basin)."""
    kind, seed, name, start = args
    rng = np.random.default_rng(seed)
    rec = CTX.rec
    if kind == "years":
        ys = sorted(rec.year.unique())
        parts = [rec[rec.year == y].assign(yid=i) for i, y in enumerate(rng.choice(ys, len(ys)))]
    else:
        us = rec.user_id.unique()
        g = dict(tuple(rec.groupby("user_id")))
        parts = [g[u].assign(user_id=i) for i, u in enumerate(rng.choice(us, len(us)))]
    b = pd.concat(parts, ignore_index=True)
    cuts = EV.cutoffs(b)
    spec = M.SPECS[name]
    f = EV.fit_spec(EV.first_brood(b, cuts), CTX, cuts, spec, start=start)
    out = {"kind": kind, "seed": seed, **{k: float(v) for k, v in f.params.items() if k != "u"}}
    for lt in (38.0, 42.0, 46.0):
        out[f"median_dd_{int(lt)}"] = float(M.median_dd(f.params, spec, lt))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--boot-refits", type=int, default=60)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--model", help="fixed model (skip the lat-vs-photo selection), e.g. p31_flat")
    ap.add_argument("--compare", nargs="*", default=None, help="with --model: other specs refit on the same folds")
    ap.add_argument("--out", help="results folder (default results/), relative to pipeline/fit/")
    a = ap.parse_args()
    global RESULTS, FIGS
    if a.out:
        RESULTS = HERE / a.out
        FIGS = RESULTS / "figures"
    t0 = time.time()
    RESULTS.mkdir(parents=True, exist_ok=True)
    FIGS.mkdir(parents=True, exist_ok=True)
    _init()   # load once in the parent; forked workers share it
    years = [int(y) for y in CTX.years]
    pool = mp.get_context("fork").Pool(a.workers)

    # ---- 1. choose lat vs photo (IL/IN/OH only, held-out log-likelihood); a fixed --model skips it
    pre = ""
    if a.model:
        chosen, ll, nrec = a.model, None, None
        pre = f"{chosen}/"
        names = [chosen] + [n for n in (a.compare or []) if n != chosen]
        print(f"[fixed] {chosen}, comparing {names[1:]}", flush=True)
    else:
        sel = _cached("select", lambda: pool.map(_select, years))
        ll = {n: sum(s["loglik"][n][0] for s in sel) for n in ("p3_lat", "p3_photo", "p3_flat")}
        nrec = sum(s["loglik"]["p3_lat"][1] for s in sel)
        chosen = max(("p3_lat", "p3_photo"), key=ll.get)
        print(f"[select] held-out loglik/record lat {ll['p3_lat']/nrec:.4f} photo {ll["p3_photo"]/nrec:.4f} flat {ll["p3_flat"]/nrec:.4f} -> {chosen}",
              flush=True)
        names = [chosen] + [n for n in M.SPECS if n != chosen and not M.SPECS[n].positive]

    # ---- 2. LOYO, all states; 3. spatial holdout
    def _fits():
        hold_async = pool.apply_async(_holdout, (names,))
        loyo = pool.map(_loyo, [(y, names) for y in years])
        return loyo, hold_async.get()
    loyo, hold = _cached(pre + "folds", _fits)
    print(f"[fits] done {time.time()-t0:.0f}s", flush=True)

    # ---- 4. bootstrap refits (parameter intervals)
    full = _cached(pre + "full_fit", lambda: _full_fit(chosen))
    start = {k: v for k, v in full["params"].items() if k != "u"}
    boots = _cached(f"{pre}boots{a.boot_refits}", lambda: pool.map(
        _boot, [(k, s, chosen, start) for k in ("years", "observers") for s in range(a.boot_refits)]))
    pool.close()

    # ---- 5. scores
    models = names + ["p1", "cal"]
    rows = [r for f in loyo for r in f["rows"]]
    recs = {k: v for f in loyo for k, v in f["test_records"].items()}
    d = EV.errors(rows, models)
    tab = EV.mae_table(d, models)
    nf, floor = EV.noise_floor(d, recs)
    ci = EV.bootstrap(d, recs, models, ref=chosen)
    bias_models = [chosen, "p1"] + ([n for n in names[1:]] if a.model else [])
    bias = EV.bias_by_band(d, bias_models)

    hmodels = names + ["p1", "cal", "cal_lat"]
    hd = EV.errors(hold["rows"], hmodels)
    htab = EV.mae_table(hd, hmodels)
    hnf, hfloor = EV.noise_floor(hd, hold["test_records"])
    hci = EV.bootstrap(hd, hold["test_records"], hmodels, ref=chosen)

    resid = {"onset": np.percentile(-d[f"{chosen}_eo"], [10, 90]).tolist(),
             "peak": np.percentile(-d[f"{chosen}_ep"], [10, 90]).tolist()}   # observed - predicted
    bt = pd.DataFrame(boots)
    pci = {k: {kind: np.percentile(g[k], [2.5, 50, 97.5]).tolist() for kind, g in bt.groupby("kind")}
           for k in bt.columns if k not in ("kind", "seed")}

    def rec_tab(t):
        return {r.model: {"n": r.n, "onset": round(r.onset, 2), "peak": round(r.peak, 2), "mae": round(r.mae, 2)}
                for r in t.itertuples()}

    headline = {
        "chosen": chosen,
        "selection_loglik_per_record": ({k: v / nrec for k, v in ll.items()} if ll else "none: fixed model (P3.1 amendment)"),
        "selection_records": nrec,
        "loyo": {"band_years": int(len(d)), "mae": rec_tab(tab), "ci": ci, "noise_floor": floor},
        "holdout": {"band_years": int(len(hd)), "mae": rec_tab(htab), "ci": hci, "noise_floor": hfloor,
                    "cuts_train": hold["cuts_train"]},
        "bias_by_band": {m: {b: {"onset": round(float(bias[m].loc[b, "onset"]), 2),
                                 "peak": round(float(bias[m].loc[b, "peak"]), 2)} for b in bias.index}
                         for m in bias_models},
        "loyo_residual_q10_q90": resid,
        "param_intervals": pci,
        "boot_refits_at_mu0_lower_bound": int((bt["mu0"] <= M.bounds_for("mu0", M.SPECS[chosen])[0] + 1e-6).sum()),
        "holdout_params": hold["fits"],
        "all_data_fit": full,
        "seconds": round(time.time() - t0),
    }
    (RESULTS / "headline.json").write_text(json.dumps(headline, indent=1, default=float))
    (RESULTS / "loyo_params.json").write_text(json.dumps({str(f["year"]): f["fits"] for f in loyo}, indent=1))
    d.merge(nf, on=["band", "year"]).to_csv(RESULTS / "loyo_rows.csv", index=False, float_format="%.2f")
    hd.merge(hnf, on=["band", "year"]).to_csv(RESULTS / "holdout_rows.csv", index=False, float_format="%.2f")
    bt.to_csv(RESULTS / "bootstrap_refits.csv", index=False, float_format="%.4f")
    print(tab.round(2).to_string(index=False))
    print(htab.round(2).to_string(index=False))
    print(bias.round(1))
    print(json.dumps({"noise_floor": floor, "holdout_floor": hfloor, "resid": resid}, default=float))
    from fit import figures
    figures.make_all(d, hd, chosen, FIGS)
    print(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
