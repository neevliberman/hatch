"""Leave-region-out test of place features (PREREG_PLACE.md). Research only: nothing here touches the site.

Analogy: three times over, hide two states from the network, teach it the rest, then ask it about the hidden pair.
The three versions differ only in how a place is described to it: by address (lat/lng, today's), by what the place is
like (environment), or by what it's like plus how long its summer days are (a gentle hint of latitude).

  python3 pipeline/atlas/place_gate.py --smoke   # 2% sample, checks the code end to end (numbers not used)
  python3 pipeline/atlas/place_gate.py           # 3 folds x 3 variants, resumable; then the gate
  python3 pipeline/atlas/place_gate.py --summary # the gate from the saved per-run results only
Needs notebooks/data/atlas/records (fetch_gbif.py) and place_env.py's warmth.npz + place/env.npz.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas import model as M  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR, TEST_YEAR  # noqa: E402
from pipeline.atlas.run_gate import wilson, weighted_quantile  # noqa: E402
from pipeline.atlas.score import Calendar, score  # noqa: E402

PLACE = DATA / "place"
OUT = ROOT / "pipeline/atlas/results/place"
FOLDS = {"N": ("Wisconsin", "Minnesota"), "E": ("Michigan", "Ohio"), "S": ("Missouri", "Kentucky")}
VARIANTS = ("L", "E", "EP")
CANDIDATE = "EP"
EPOCHS, FALLBACK_EPOCHS = 10, 6
CAL_ALPHA, CAL_BLEND = 300.0, True
SCORED_TRAIN, SCORED_TEST = 400, 20
DAYS = np.arange(366)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def solstice_daylength(lat):
    """Hours of daylight at the June solstice (declination 23.44°)."""
    phi, dec = np.radians(lat), np.radians(23.44)
    return 24 / math.pi * np.arccos(np.clip(-np.tan(phi) * np.tan(dec), -1, 1))


def records():
    """Records after the burst filter, with the warmth clock (PRISM, climatology 2015-2024); cached."""
    f = PLACE / "records.parquet"
    if f.exists():
        return pd.read_parquet(f)
    df = D.load_records(last_year=TEST_YEAR)
    w = D.Warmth.load(np.arange(FIRST_YEAR, TEST_YEAR))
    df = D.attach_clock(df, w, w.days_ahead())
    keep = ["lat", "lng", "year", "doy", "state", "cell", "taxon", "delta", "norm_dd"]
    df[keep].to_parquet(f, index=False)
    return df[keep]


class Places:
    """Place inputs for each variant. Environmental features are per warmth cell, standardised over all cells."""

    def __init__(self):
        z = np.load(PLACE / "env.npz")
        self.names = list(z["names"])
        f = z["feats"].astype(np.float64)
        dl = solstice_daylength(np.array([h3_lat(c) for c in z["cells"]]))
        f = np.column_stack([f, dl])
        self.z = ((f - f.mean(0)) / f.std(0)).astype(np.float32)
        self.index = {c: i for i, c in enumerate(z["cells"])}

    def __call__(self, df, variant):
        if variant == "L":
            return M.place_features(df.lat, df.lng, df.norm_dd)
        e = self.z[np.array([self.index[c] for c in df.cell])]
        return e if variant == "EP" else e[:, :-1]


def h3_lat(c):
    import h3
    return h3.cell_to_latlng(c)[0]


def make_net(n_out, n_place, seed=0):
    torch.manual_seed(seed)
    net = M.Atlas(n_out)
    torch.manual_seed(seed)
    net.inp = nn.Sequential(nn.Linear(n_place + 2 * M.TIME_HARMONICS, 256), nn.SiLU())
    return net


class Net:
    def __init__(self, net, place):
        self.net, self.place = net, place

    def log_probs(self, df, batch=8192):
        return M.predict_log_probs(self.net, self.place, df.doy.to_numpy(), df.delta.to_numpy(), batch)


class CalOn:
    """The calendar on a subset (score.Calendar.log_probs takes the frame)."""

    def __init__(self, cal):
        self.cal = cal

    def log_probs(self, df, batch=8192):
        return self.cal.log_probs(df, batch)


def curves(model, df, n_out):
    """Expected daily count per output: sum of shares over each day's records -> [n_out, 366]."""
    e = torch.zeros(366, n_out, dtype=torch.float64)
    d = torch.as_tensor(df.doy.to_numpy())
    for sl, lp in model.log_probs(df):
        e.index_add_(0, d[sl], lp.double().exp())
    return e.T.numpy()


def days_error(exp, obs):
    """Mean of |onset - observed| and |peak - observed| (10th and 50th percentile days, interpolated)."""
    if exp.sum() <= 0 or obs.sum() <= 0:
        return np.nan
    return (abs(weighted_quantile(DAYS, exp, 0.1) - weighted_quantile(DAYS, obs, 0.1))
            + abs(weighted_quantile(DAYS, exp, 0.5) - weighted_quantile(DAYS, obs, 0.5))) / 2


def run_fold(df, fold, places, epochs, tag):
    """Train and score every variant on one fold; each variant's result is saved as it finishes."""
    held = df.state.isin(FOLDS[fold]).to_numpy()
    tr = df[~held & (df.year < TEST_YEAR)]
    tests = {"region": df[held], "inyear": df[~held & (df.year == TEST_YEAR)]}
    sp = D.species_list(tr)
    n_out = len(sp) + 1
    ytr = D.labels(tr, sp)
    ntrain = np.bincount(ytr, minlength=n_out)
    ys = {k: D.labels(t, sp) for k, t in tests.items()}
    log(f"fold {fold}: {len(sp)} species, {len(tr):,} train, "
        + ", ".join(f"{k} {len(t):,}" for k, t in tests.items()))
    out = OUT / tag / fold
    out.mkdir(parents=True, exist_ok=True)
    cal_f = out / "calendar.json"
    if not cal_f.exists():
        cal = CalOn(Calendar(tr, ytr, n_out, CAL_ALPHA, CAL_BLEND))
        res = {k: evaluate(cal, t, ys[k], n_out) for k, t in tests.items()}
        cal_f.write_text(json.dumps(res))
    cal_res = json.loads(cal_f.read_text())
    for v in VARIANTS:
        f = out / f"{v}.json"
        if f.exists():
            continue
        mf = PLACE / "models" / tag / f"{fold}_{v}.pt"
        mf.parent.mkdir(parents=True, exist_ok=True)
        p = places(tr, v)
        net = make_net(n_out, p.shape[1])
        if mf.exists():
            net.load_state_dict(torch.load(mf)["state"])
        else:
            log(f"  training {fold}/{v} ({p.shape[1]} place inputs, {epochs} passes)")
            M.fit(net, p, tr.doy.to_numpy(), tr.delta.to_numpy(), ytr, epochs, log=log)
            torch.save({"state": net.state_dict(), "species": sp}, mf)
        res = {}
        for k, t in tests.items():
            res[k] = evaluate(Net(net, places(t, v)), t, ys[k], n_out)
        # per-species table: variant and calendar side by side
        rows = []
        for k in tests:
            r, c = res[k], cal_res[k]
            for i, s in enumerate(sp):
                rows.append({"test": k, "species": s, "n_train": int(ntrain[i]), "n_test": int(r["n"][i]),
                             "model": r["per"][i], "calendar": c["per"][i], "days": r["days"][i],
                             "cal_days": c["days"][i]})
        res["table"] = rows
        res["epochs"] = epochs
        f.write_text(json.dumps(res))
        log(f"  {fold}/{v} saved")


def evaluate(model, t, y, n_out):
    per, total = score(model, t, y, n_out)
    e = curves(model, t, n_out)
    obs = np.zeros((n_out, 366))
    np.add.at(obs, (y, t.doy.to_numpy()), 1.0)
    n = np.bincount(y, minlength=n_out)
    days = [days_error(e[i], obs[i]) if n[i] >= SCORED_TEST else None for i in range(n_out - 1)]
    return {"per": per[:-1].tolist(), "total": total, "records": int(len(t)), "n": n[:-1].tolist(), "days": days}


def summarise(tag):
    """The gate, from the saved per-fold results (PREREG_PLACE.md)."""
    base = OUT / tag
    folds = [f for f in FOLDS if all((base / f / f"{v}.json").exists() for v in VARIANTS)]
    s = {"folds": folds, "variants": {}}
    for v in VARIANTS:
        rows, tot = [], {"region": [0.0, 0], "inyear": [0.0, 0]}
        cal_tot = {"region": [0.0, 0], "inyear": [0.0, 0]}
        for f in folds:
            r = json.loads((base / f / f"{v}.json").read_text())
            c = json.loads((base / f / "calendar.json").read_text())
            t = pd.DataFrame(r["table"])
            t["fold"] = f
            rows.append(t)
            for k in tot:
                tot[k][0] += r[k]["total"]
                tot[k][1] += r[k]["records"]
                cal_tot[k][0] += c[k]["total"]
                cal_tot[k][1] += c[k]["records"]
        t = pd.concat(rows)
        t = t[(t.n_train >= SCORED_TRAIN) & (t.n_test >= SCORED_TEST)]
        t["win"] = t.model > t.calendar
        d = {}
        for k in ("region", "inyear"):
            u = t[t.test == k]
            wins, n = int(u.win.sum()), len(u)
            d[k] = {"wins": wins, "scored": n, "win_share": wins / n if n else None,
                    "win_share_95": list(wilson(wins, n)),
                    "loglik_per_record": tot[k][0] / tot[k][1], "cal_loglik_per_record": cal_tot[k][0] / cal_tot[k][1],
                    "median_days": float(u.days.median()), "cal_median_days": float(u.cal_days.median()),
                    "by_fold": {f: {"wins": int(g.win.sum()), "scored": len(g), "win_share": float(g.win.mean()),
                                    "median_days": float(g.days.median()),
                                    "cal_median_days": float(g.cal_days.median())}
                                for f, g in u.groupby("fold")}}
        s["variants"][v] = d
    if len(folds) == len(FOLDS):
        L, C = s["variants"]["L"], s["variants"][CANDIDATE]
        checks = {
            "1_region_win_share_plus_5": C["region"]["win_share"] >= L["region"]["win_share"] + 0.05,
            "2_beats_L_in_2_of_3_folds": sum(C["region"]["by_fold"][f]["win_share"] >= L["region"]["by_fold"][f]["win_share"]
                                             for f in FOLDS) >= 2,
            "3_region_loglik_better": C["region"]["loglik_per_record"] > L["region"]["loglik_per_record"],
            "4_region_days_within_1": C["region"]["median_days"] <= L["region"]["median_days"] + 1.0,
            "5_inyear_within_3pts_and_0.02": (C["inyear"]["win_share"] >= L["inyear"]["win_share"] - 0.03
                                               and C["inyear"]["loglik_per_record"]
                                               >= L["inyear"]["loglik_per_record"] - 0.02),
        }
        s["checks"] = checks
        s["pass"] = all(checks.values())
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    ap.add_argument("--folds", default="".join(FOLDS))
    args = ap.parse_args()
    tag = "smoke" if args.smoke else "full"
    if not args.summary:
        torch.set_num_threads(4)
        log("loading records")
        df = records()
        if args.smoke:
            df = df.sample(frac=0.02, random_state=0).reset_index(drop=True)
        log(f"  {len(df):,} records")
        places = Places()
        for f in args.folds:
            run_fold(df, f, places, 2 if args.smoke else args.epochs, tag)
    s = summarise(tag)
    (OUT / tag).mkdir(parents=True, exist_ok=True)
    (OUT / tag / "gate.json").write_text(json.dumps(s, indent=1))
    if not args.smoke:
        log(json.dumps({v: {k: {kk: d[k][kk] for kk in ("win_share", "loglik_per_record", "median_days")}
                            for k in ("region", "inyear")} for v, d in s["variants"].items()}, indent=1))
        log(f"checks: {s.get('checks')}  PASS = {s.get('pass')}")
    else:
        log("smoke run finished (numbers not used)")


if __name__ == "__main__":
    main()
