"""The 10 Nov go/no-go, exactly as FROZEN_ATLAS.md says. Tune on 2024, refit on 2015-2024, score 2025 and WI/MN.
Writes pipeline/atlas/results/ (gate.json, per_species.csv, tuning.json) and notebooks/data/atlas/model/ (weights).
  python3 pipeline/atlas/run_gate.py            # ~2-3 hours on 4 cores
  python3 pipeline/atlas/run_gate.py --quick    # smoke test on a 5% sample, a few minutes
  python3 pipeline/atlas/run_gate.py --run2     # amendment 1: train 2015-2025, score 2026 (needs the 2026 pulls)
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

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas import model as M  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR, TEST_YEAR  # noqa: E402
from pipeline.atlas.score import AtlasModel, Calendar, score  # noqa: E402

OUT = ROOT / "pipeline/atlas/results"
MAX_EPOCHS = 12
SCORED_TRAIN, SCORED_TEST = 400, 20
CAL_GRID = [(a, b) for a in (1, 3, 10, 30, 100, 300) for b in (False, True)]
LUNA = "Actias luna"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def prepare(df, clim_years):
    w = D.Warmth.load(clim_years)
    return D.attach_clock(df, w, w.days_ahead())


def arrays(df):
    return M.place_features(df.lat, df.lng, df.norm_dd), df.doy.to_numpy(), df.delta.to_numpy()


def train_atlas(train, y, n_out, epochs, clocks=D.LAMBDAS, on_epoch=None, stop_after=None, seed=0,
                decay_clock=False):
    torch.manual_seed(seed)
    net = M.Atlas(n_out, clocks=clocks)
    p, d, dl = arrays(train)
    M.fit(net, p, d, dl, y, epochs, log=log, on_epoch=on_epoch, stop_after=stop_after, seed=seed,
          decay_clock=decay_clock)
    return net


def tune(df, quick, decay_clock=False):
    log("tuning: train 2015-2023, score 2024 (training states)")
    df = prepare(df, np.arange(FIRST_YEAR, TEST_YEAR - 1))
    tr, va, _ = D.splits(df, tuning=True)
    sp = D.species_list(tr)
    n_out = len(sp) + 1
    ytr, yva = D.labels(tr, sp), D.labels(va, sp)
    log(f"  {len(sp)} species, {len(tr):,} train, {len(va):,} val records")
    cal = {}
    for a, b in CAL_GRID:
        cal[f"{a}|{b}"] = score(Calendar(tr, ytr, n_out, a, b), va, yva, n_out)[1] / len(va)
    best_cal = max(cal, key=cal.get)
    log(f"  calendar best {best_cal}: {cal[best_cal]:.4f} per record")
    curve = {}

    def on_epoch(ep):
        curve[ep] = score(AtlasModel(net_ref[0]), va, yva, n_out)[1] / len(va)
        log(f"    val {curve[ep]:.4f} per record")

    net_ref = [None]
    torch.manual_seed(0)
    net_ref[0] = M.Atlas(n_out)
    p, d, dl = arrays(tr)
    M.fit(net_ref[0], p, d, dl, ytr, 3 if quick else MAX_EPOCHS, log=log, on_epoch=on_epoch,
          decay_clock=decay_clock)
    best_ep = max(curve, key=curve.get)
    a, b = best_cal.split("|")
    return {"calendar_grid": cal, "calendar": {"alpha": float(a), "blend_weeks": b == "True"},
            "atlas_val_curve": curve, "epochs": best_ep, "max_epochs": 3 if quick else MAX_EPOCHS,
            "n_species": len(sp)}


def per_species_table(sp, ntrain, name, test, y, atlas, cal, nocal):
    n_out = len(sp) + 1
    pa, ta = score(atlas, test, y, n_out)
    pc, tc = score(cal, test, y, n_out)
    pn, tn = score(nocal, test, y, n_out)
    ntest = np.bincount(y, minlength=n_out)
    t = pd.DataFrame({"species": sp + ["(other)"], "n_train": ntrain, f"n_{name}": ntest,
                      f"atlas_{name}": pa, f"cal_{name}": pc, f"nowarmth_{name}": pn})
    t[f"gain_{name}"] = t[f"atlas_{name}"] - t[f"cal_{name}"]
    scored = t[(t.n_train >= SCORED_TRAIN) & (t[f"n_{name}"] >= SCORED_TEST) & (t.species != "(other)")]
    wins = int((scored[f"gain_{name}"] > 0).sum())
    k = len(scored)
    lo, hi = wilson(wins, k)
    summary = {"records": int(len(test)), "scored_species": k, "atlas_wins": wins, "win_share": wins / k if k else None,
               "win_share_95": [lo, hi], "median_gain_nats": float(scored[f"gain_{name}"].median()) if k else None,
               "loglik_per_record": {"atlas": ta / len(test), "calendar": tc / len(test), "atlas_no_warmth": tn / len(test)},
               "nowarmth_wins_vs_cal": int((scored[f"nowarmth_{name}"] > scored[f"cal_{name}"]).sum()),
               "atlas_wins_vs_nowarmth": int((scored[f"atlas_{name}"] > scored[f"nowarmth_{name}"]).sum())}
    summary["pass"] = bool(k and wins / k > 0.5 and ta > tc)
    return t, summary


def wilson(k, n, z=1.96):
    if not n:
        return None, None
    p = k / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return c - h, c + h


def luna_rows_2025():
    """P3's 2025 band-years (pipeline/fit/results/loyo_rows.csv)."""
    r = pd.read_csv(ROOT / "pipeline/fit/results/loyo_rows.csv")
    r = r[r.year == TEST_YEAR]
    return pd.DataFrame({"band": r.band, "n": r.n, "onset": r.onset, "peak": r.peak, "cut": r.cut,
                         "p3_onset": r.p3_photo_onset, "p3_peak": r.p3_photo_peak, "cal_onset": r.cal_onset,
                         "cal_peak": r.cal_peak})


def luna_rows_2026():
    """P3's 2026 strips from the scorecard table (SCORECARD_2026.md), cut-offs from P3's 2025 fold."""
    import datetime as dt
    import re
    doy = lambda t: (dt.datetime.strptime(f"{t} 2026", "%d %b %Y").date() - dt.date(2025, 12, 31)).days  # noqa
    cuts = luna_rows_2025().set_index("band").cut
    rows = []
    for line in (ROOT / "pipeline/live/SCORECARD_2026.md").read_text().splitlines():
        m = re.match(r"\| (\d\d)-(\d\d) N \| [^|]+ \| (\d+) \| ([^|]+) \| ([^|]+) \|", line)
        if not m:
            continue
        o = [doy(x.strip()) for x in m.group(4).split("/")]
        p = [doy(x.strip()) for x in m.group(5).split("/")]
        band = f"{m.group(1)}-{m.group(2)}"
        rows.append({"band": band, "n": int(m.group(3)), "onset": o[0], "peak": p[0], "cut": cuts[band],
                     "p3_onset": o[1], "p3_peak": p[1], "cal_onset": o[2], "cal_peak": p[2]})
    assert len(rows) == 5, "scorecard table changed"
    return pd.DataFrame(rows)


def weighted_quantile(days, weights, q):
    """Linear interpolation between day midpoints, as pandas' quantile does for a list of record days."""
    c = (np.cumsum(weights) - weights / 2) / weights.sum()
    return float(np.interp(q, c, days))


def luna_check(df_test, sp, atlas, rows, beat_calendar=False):
    """Atlas onset/peak from its luna share x that band's insect records per day, up to the band's cut-off.
    All states count, WI/MN included: P3's band targets include them (amendment 2)."""
    li = sp.index(LUNA)
    home = df_test
    share = np.concatenate([lp[:, li].exp().numpy() for _, lp in atlas.log_probs(home)])
    out = []
    for r in rows.itertuples():
        lo, hi = (float(x) for x in r.band.split("-"))
        m = (home.lat.to_numpy() >= lo) & (home.lat.to_numpy() < hi) & (home.doy.to_numpy() >= 60) & \
            (home.doy.to_numpy() <= r.cut)
        e = np.bincount(home.doy.to_numpy()[m], weights=share[m], minlength=366)
        days = np.arange(366)
        out.append({**r._asdict(), "atlas_onset": round(weighted_quantile(days, e, 0.10), 1),
                    "atlas_peak": round(weighted_quantile(days, e, 0.50), 1)})
    t = pd.DataFrame(out).drop(columns="Index")
    mae = lambda a, b: float((t[a] - t[b]).abs().mean())  # noqa: E731
    res = {"band_years": len(t), "atlas": (mae("atlas_onset", "onset") + mae("atlas_peak", "peak")) / 2,
           "p3": (mae("p3_onset", "onset") + mae("p3_peak", "peak")) / 2,
           "calendar": (mae("cal_onset", "onset") + mae("cal_peak", "peak")) / 2,
           "rows": json.loads(t.to_json(orient="records"))}
    res["pass"] = bool(res["atlas"] <= res["p3"] + 1.0 and (not beat_calendar or res["atlas"] < res["calendar"]))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--run2", action="store_true", help="amendment 1: train 2015-2025, score 2026 (tests C, D)")
    args = ap.parse_args()
    t0 = time.time()
    torch.set_num_threads(4)
    log("loading records")
    df = D.load_records(last_year=TEST_YEAR + 1 if args.run2 else TEST_YEAR)
    if args.quick:
        df = df.sample(frac=0.05, random_state=0).reset_index(drop=True)
    log(f"  {len(df):,} records after the burst filter")
    tuning = tune(df[df.year <= TEST_YEAR], args.quick, decay_clock=not args.run2)  # run 1 decayed the clock
    log(f"tuning chose {tuning['epochs']} epochs, calendar {tuning['calendar']}")

    if args.run2:
        log("final (amendment 1): train 2015-2025, score 2026 and WI/MN 2026")
        df = prepare(df, np.arange(FIRST_YEAR, TEST_YEAR + 1))
        last = int(np.load(DATA / "warmth.npz")["last_day_2026"])
        df = df[(df.year <= TEST_YEAR) | (df.doy <= last)]  # 2026 up to the newest PRISM day
        tr, ta, tb = D.splits(df, run2=True)
        names = ("c", "d")
    else:
        log("final: train 2015-2024, score 2025 and WI/MN")
        df = prepare(df, np.arange(FIRST_YEAR, TEST_YEAR))
        tr, ta, tb = D.splits(df)
        names = ("a", "b")
    sp = D.species_list(tr)
    n_out = len(sp) + 1
    ytr = D.labels(tr, sp)
    ntrain = np.bincount(ytr, minlength=n_out)
    cal = Calendar(tr, ytr, n_out, tuning["calendar"]["alpha"], tuning["calendar"]["blend_weeks"])
    net = train_atlas(tr, ytr, n_out, tuning["max_epochs"], stop_after=tuning["epochs"],
                      decay_clock=not args.run2)
    log("ablation: same network, calendar clock only")
    net0 = train_atlas(tr, ytr, n_out, tuning["max_epochs"], clocks=(0.0,), stop_after=tuning["epochs"],
                       decay_clock=not args.run2)
    atlas, nowarm = AtlasModel(net), AtlasModel(net0)
    tabs, gate = [], {}
    for name, test in zip(names, (ta, tb)):
        t, s = per_species_table(sp, ntrain, name, test, D.labels(test, sp), atlas, cal, nowarm)
        tabs.append(t.set_index(["species", "n_train"]))
        gate[f"test_{name}"] = s
        log(f"test {name}: {s}")
    rows = luna_rows_2026() if args.run2 else luna_rows_2025()
    year = TEST_YEAR + 1 if args.run2 else TEST_YEAR
    luna_test = pd.concat([ta, tb[tb.year == year]])
    gate["luna"] = luna_check(luna_test, sp, atlas, rows, beat_calendar=args.run2)
    log(f"luna: atlas {gate['luna']['atlas']:.2f}, p3 {gate['luna']['p3']:.2f}, calendar {gate['luna']['calendar']:.2f}")
    gate["go"] = bool(all(gate[f"test_{n}"]["pass"] for n in names) and gate["luna"]["pass"])
    gate["clock_weights_median"] = np.median(net.clock_weights()[:-1], 0).tolist()
    gate["n_species"], gate["train_records"] = len(sp), int(len(tr))
    gate["seconds"] = round(time.time() - t0)
    gate["quick"] = args.quick
    out = OUT / ("quick" if args.quick else "") / ("run2" if args.run2 else "")
    out.mkdir(parents=True, exist_ok=True)
    pd.concat(tabs, axis=1).reset_index().to_csv(out / "per_species.csv", index=False, float_format="%.3f")
    cw = pd.DataFrame(net.clock_weights(), columns=["calendar", "half", "warmth"])
    cw.insert(0, "species", sp + ["(other)"])
    cw.to_csv(out / "clock_weights.csv", index=False, float_format="%.3f")
    (out / "gate.json").write_text(json.dumps(gate, indent=1))
    (out / "tuning.json").write_text(json.dumps(tuning, indent=1))
    md = DATA / ("model_quick" if args.quick else "model") / ("run2" if args.run2 else "")
    md.mkdir(parents=True, exist_ok=True)
    torch.save({"state": net.state_dict(), "species": sp}, md / "atlas.pt")
    torch.save({"state": net0.state_dict(), "species": sp}, md / "atlas_nowarmth.pt")
    log(f"GO = {gate['go']} ({gate['seconds']} s)")


if __name__ == "__main__":
    main()
