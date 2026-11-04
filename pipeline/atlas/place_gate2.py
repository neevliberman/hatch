"""Round 2 of the leave-region-out place test (PREREG_PLACE2.md). Research only: nothing here touches the site.

Analogy: the same exam as round 1 (hide two states, teach the rest, quiz on the hidden pair), but now each student
sits it three times with a different shuffle of the deck (seeds), the quiz skips the towns right on the border of
the states it studied (buffer), the "description" student gets a 7 km map instead of a 45 km one (EP6), and one
student is given only blurred street addresses (D) to test why round 1's description student lost a little at home.

  python3 pipeline/atlas/place_gate2.py --smoke --workers 2   # 2% sample, 2 passes (numbers not used)
  python3 pipeline/atlas/place_gate2.py --workers 2            # 33 networks, resumable; then the gate
  python3 pipeline/atlas/place_gate2.py --summary              # the gate from the saved results only
Needs notebooks/data/atlas/records (fetch_gbif.py), warmth.npz + place/env.npz (place_env.py, round 1) and
place2/prism_grid.npz (place_env6.py).
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import h3
import numpy as np
import pandas as pd
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas import model as M  # noqa: E402
from pipeline.atlas import place_env6 as E6  # noqa: E402
from pipeline.atlas.config import BOX, DATA, FIRST_YEAR, TEST_YEAR  # noqa: E402
from pipeline.atlas.place_gate import (CAL_ALPHA, CAL_BLEND, FOLDS, SCORED_TEST, SCORED_TRAIN, CalOn, Net,  # noqa: E402
                                       Places as Places4, evaluate, make_net, solstice_daylength)
from pipeline.atlas.run_gate import wilson  # noqa: E402
from pipeline.atlas.score import Calendar  # noqa: E402

P2 = DATA / "place2"
OUT = ROOT / "pipeline/atlas/results/place2"
EPOCHS = 6
SEEDS = (0, 1, 2)
CANDIDATE, BASE, DIAG = "EP6", "L", "D"
TESTS = ("region_buf", "region_all", "inyear")


def jobs(seeds=SEEDS):
    """Pre-registered order: per seed, every fold's L, EP6, D; then H and EP4 (seed 0). The smoke run uses seeds 0-1."""
    out = [(f, v, s) for s in seeds for v in ("L", "EP6", "D") for f in FOLDS]
    return out + [(f, v, 0) for v in ("H", "EP4") for f in FOLDS]


def log(*a):
    print(time.strftime("%H:%M:%S"), f"[{os.getpid()}]", *a, flush=True)


def records():
    """Records after the burst filter, with the warmth clock and the res-6 cell of each record; cached."""
    f = P2 / "records.parquet"
    if f.exists():
        return pd.read_parquet(f)
    df = D.load_records(last_year=TEST_YEAR)
    w = D.Warmth.load(np.arange(FIRST_YEAR, TEST_YEAR))
    df = D.attach_clock(df, w, w.days_ahead())
    df["cell6"] = [h3.latlng_to_cell(a, b, E6.RES) for a, b in zip(df.lat.to_numpy(), df.lng.to_numpy())]
    keep = ["lat", "lng", "year", "doy", "state", "cell", "cell6", "taxon", "delta", "norm_dd"]
    df = df[keep].reset_index(drop=True)
    df.to_parquet(f, index=False)
    return df


class Places:
    """Place inputs for every variant (PREREG_PLACE2.md, "Variants")."""

    def __init__(self, df):
        self.p4 = Places4()
        f = P2 / "env6.npz"
        need = sorted(set(df.cell6.unique()))
        if f.exists():
            z = np.load(f)
            cells, raw = list(z["cells"]), z["raw"]
            mean, sd = z["mean"], z["sd"]
        else:
            kids = E6.grid_children()
            cells = sorted(set(kids) | set(need))
            raw = E6.features(cells)
            dl = solstice_daylength(np.array([h3.cell_to_latlng(c)[0] for c in cells]))
            raw = np.column_stack([raw, dl])
            idx = {c: i for i, c in enumerate(cells)}
            ref = raw[[idx[c] for c in kids]]
            mean, sd = ref.mean(0), ref.std(0)
            np.savez_compressed(f, cells=np.array(cells), raw=raw, mean=mean, sd=sd)
        self.z6 = ((raw - mean) / sd).astype(np.float32)
        self.i6 = {c: i for i, c in enumerate(cells)}
        missing = set(need) - set(self.i6)
        assert not missing, f"{len(missing)} record cells without res-6 features"

    def __call__(self, df, v):
        if v == "L":
            return M.place_features(df.lat, df.lng, df.norm_dd)
        if v == "D":
            ll = np.array([h3.cell_to_latlng(c) for c in df.cell])
            return M.place_features(ll[:, 0], ll[:, 1], df.norm_dd)
        if v == "EP4":
            return self.p4(df, "EP")
        e = self.z6[np.array([self.i6[c] for c in df.cell6])]
        if v == "EP6":
            return e
        if v == "H":
            y = (df.lat.to_numpy() - (BOX["s"] + BOX["n"]) / 2) / ((BOX["n"] - BOX["s"]) / 2)
            x = (df.lng.to_numpy() - (BOX["w"] + BOX["e"]) / 2) / ((BOX["e"] - BOX["w"]) / 2)
            waves = [fn(math.pi * k * u / 2) for k in (1, 2) for u in (y, x) for fn in (np.sin, np.cos)]
            return np.column_stack([e] + waves).astype(np.float32)
        raise ValueError(v)


def fit(model, place, doy, delta, y, epochs, seed, ckpt, lr=2e-3, batch=4096, weight_decay=1e-4):
    """model.fit (no clock decay), with a checkpoint after every pass so a restart loses at most one."""
    g = torch.Generator().manual_seed(seed)
    tensors = [torch.as_tensor(a) for a in (place, doy.astype(np.float32), delta.astype(np.float32), y)]
    n = len(y)
    clock = [p for k, p in model.named_parameters() if k == "clock_logits"]
    rest = [p for k, p in model.named_parameters() if k != "clock_logits"]
    opt = torch.optim.AdamW([{"params": rest}, {"params": clock, "weight_decay": 0.0}], lr=lr,
                            weight_decay=weight_decay)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=epochs * math.ceil(n / batch),
                                                pct_start=0.05)
    start = 0
    if ckpt.exists():
        ck = torch.load(ckpt, weights_only=False)
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        sched.load_state_dict(ck["sched"])
        g.set_state(ck["gen"])
        torch.set_rng_state(ck["rng"])
        start = ck["epoch"]
        log(f"    resumed after pass {start}")
    for ep in range(start, epochs):
        model.train()
        perm = torch.randperm(n, generator=g)
        tot = 0.0
        for i in range(0, n, batch):
            j = perm[i:i + batch]
            p, d, dl, t = (a[j] for a in tensors)
            loss = nn.functional.cross_entropy(model(p, d, dl), t)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item() * len(j)
        tmp = ckpt.with_suffix(".tmp")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(),
                    "gen": g.get_state(), "rng": torch.get_rng_state(), "epoch": ep + 1}, tmp)
        os.replace(tmp, ckpt)
        log(f"    pass {ep + 1}/{epochs}: loss {tot / n:.4f}")


class Fold:
    """One fold's splits, species list, labels and calendar results (computed once, shared by its networks)."""

    def __init__(self, df, fold, out):
        held = df.state.isin(FOLDS[fold]).to_numpy()
        self.tr = df[~held & (df.year < TEST_YEAR)]
        # a training cell: more than half of its records (all years) are outside the held-out pair (amendment 1)
        share = pd.Series(~held).groupby(df.cell.to_numpy()).mean()
        trained = set(share[share > 0.5].index)
        border = {k for c in trained for k in h3.grid_disk(c, 1)}
        reg = df[held]
        self.tests = {"region_buf": reg[~reg.cell.isin(border).to_numpy()], "region_all": reg,
                      "inyear": df[~held & (df.year == TEST_YEAR)]}
        self.sp = D.species_list(self.tr)
        self.n_out = len(self.sp) + 1
        self.ytr = D.labels(self.tr, self.sp)
        self.ys = {k: D.labels(t, self.sp) for k, t in self.tests.items()}
        log(f"fold {fold}: {len(self.sp)} species, {len(self.tr):,} train, "
            + ", ".join(f"{k} {len(t):,}" for k, t in self.tests.items())
            + f"; buffer drops {reg.cell.isin(border).mean():.1%} of region records")
        cf = out / "calendar.json"
        if not cf.exists():
            cal = CalOn(Calendar(self.tr, self.ytr, self.n_out, CAL_ALPHA, CAL_BLEND))
            res = {k: evaluate(cal, t, self.ys[k], self.n_out) for k, t in self.tests.items()}
            res["species"] = self.sp
            res["n_train"] = np.bincount(self.ytr, minlength=self.n_out)[:-1].tolist()
            tmp = out / f"calendar.{os.getpid()}.tmp"
            tmp.write_text(json.dumps(res))
            os.replace(tmp, cf)


def claim(path):
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        return True
    except FileExistsError:
        return False


def worker(df, places, tag, epochs, threads):
    torch.set_num_threads(threads)
    raw = P2 / "raw" / tag
    folds = {}
    for f, v, s in jobs(SEEDS[:2] if tag == "smoke" else SEEDS):
        out = raw / f
        out.mkdir(parents=True, exist_ok=True)
        res_f = out / f"{v}_s{s}.json"
        if res_f.exists() or not claim(out / f"{v}_s{s}.claim"):
            continue
        if f not in folds:
            folds[f] = Fold(df, f, out)
        F = folds[f]
        p = places(F.tr, v)
        net = make_net(F.n_out, p.shape[1], seed=s)
        ck = P2 / "ckpt" / tag / f"{f}_{v}_s{s}.pt"
        ck.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        log(f"  training {f}/{v}/seed {s} ({p.shape[1]} place inputs, {epochs} passes)")
        fit(net, p, F.tr.doy.to_numpy(), F.tr.delta.to_numpy(), F.ytr, epochs, s, ck)
        del p
        t1 = time.time()
        res = {k: evaluate(Net(net, places(t, v)), t, F.ys[k], F.n_out) for k, t in F.tests.items()}
        res.update(epochs=epochs, seed=s, train_min=(t1 - t0) / 60, eval_min=(time.time() - t1) / 60)
        tmp = out / f"{v}_s{s}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(res))
        os.replace(tmp, res_f)
        log(f"  {f}/{v}/seed {s} saved (train {res['train_min']:.1f} min, eval {res['eval_min']:.1f} min)")


# ---------- summary ----------

def load_runs(tag):
    """{(fold, variant, seed): result} and {fold: calendar result} for whatever has finished."""
    raw = P2 / "raw" / tag
    runs, cals = {}, {}
    for f in FOLDS:
        if (raw / f / "calendar.json").exists():
            cals[f] = json.loads((raw / f / "calendar.json").read_text())
        for p in sorted((raw / f).glob("*_s*.json")) if (raw / f).exists() else []:
            v, s = p.stem.rsplit("_s", 1)
            runs[(f, v, int(s))] = json.loads(p.read_text())
    return runs, cals


def pooled(runs, cals, v, s, test):
    """Round 1's pooled metrics for one variant and seed over the three folds."""
    wins = n = 0
    tot = recs = 0.0
    days, by_fold = [], {}
    for f in FOLDS:
        r, c = runs[(f, v, s)][test], cals[f][test]
        ntr = np.array(cals[f]["n_train"])
        nte = np.array(r["n"])
        ok = (ntr >= SCORED_TRAIN) & (nte >= SCORED_TEST)
        w = (np.array(r["per"]) > np.array(c["per"]))[ok]
        d = np.array([x for x, k in zip(r["days"], ok) if k], float)
        by_fold[f] = {"wins": int(w.sum()), "scored": int(ok.sum()), "win_share": float(w.mean()),
                      "median_days": float(np.nanmedian(d))}
        wins += int(w.sum())
        n += int(ok.sum())
        tot += r["total"]
        recs += r["records"]
        days.append(d)
    return {"wins": wins, "scored": n, "win_share": wins / n, "loglik_per_record": tot / recs,
            "median_days": float(np.nanmedian(np.concatenate(days))), "by_fold": by_fold}


def calendar_pooled(cals, test):
    tot = sum(cals[f][test]["total"] for f in FOLDS)
    recs = sum(cals[f][test]["records"] for f in FOLDS)
    d = []
    for f in FOLDS:
        c = cals[f][test]
        ok = (np.array(cals[f]["n_train"]) >= SCORED_TRAIN) & (np.array(c["n"]) >= SCORED_TEST)
        d += [x for x, k in zip(c["days"], ok) if k]
    return {"loglik_per_record": tot / recs, "median_days": float(np.nanmedian(np.array(d, float)))}


def stats(xs):
    xs = np.array(xs, float)
    return {"mean": float(xs.mean()), "sd": float(xs.std(ddof=1)) if len(xs) > 1 else None,
            "min": float(xs.min()), "max": float(xs.max()), "values": xs.tolist()}


def summarise(tag):
    runs, cals = load_runs(tag)
    variants = sorted({v for _, v, _ in runs})
    s = {"variants": {}, "calendar": {t: calendar_pooled(cals, t) for t in TESTS} if len(cals) == 3 else None}
    per = {}  # (v, seed) -> test -> pooled
    for v in variants:
        seeds = [x for x in SEEDS if all((f, v, x) in runs for f in FOLDS)]
        if not seeds:
            continue
        d = {"seeds": seeds}
        for t in TESTS:
            ps = [pooled(runs, cals, v, x, t) for x in seeds]
            for x, p in zip(seeds, ps):
                per.setdefault((v, x), {})[t] = p
            d[t] = {m: stats([p[m] for p in ps]) for m in ("win_share", "loglik_per_record", "median_days")}
            d[t]["scored"] = ps[0]["scored"]
            d[t]["by_fold"] = {f: {"win_share": stats([p["by_fold"][f]["win_share"] for p in ps]),
                                   "median_days": stats([p["by_fold"][f]["median_days"] for p in ps]),
                                   "scored": ps[0]["by_fold"][f]["scored"]} for f in FOLDS}
            if len(ps) == 1:
                d[t]["win_share_95"] = list(wilson(ps[0]["wins"], ps[0]["scored"]))
        s["variants"][v] = d
    # paired per-seed differences against L
    s["paired_vs_L"] = {}
    for v in s["variants"]:
        if v == BASE:
            continue
        common = [x for x in s["variants"][v]["seeds"] if (BASE, x) in per]
        s["paired_vs_L"][v] = {t: {m: stats([per[(v, x)][t][m] - per[(BASE, x)][t][m] for x in common])
                                   for m in ("win_share", "loglik_per_record", "median_days")}
                               for t in TESTS} if common else None
    V = s["variants"]
    if BASE in V and CANDIDATE in V and len(V[BASE]["seeds"]) == len(V[CANDIDATE]["seeds"]) == len(SEEDS):
        L, C = V[BASE], V[CANDIDATE]
        m = lambda d, t, k: d[t][k]["mean"]  # noqa: E731
        s["checks"] = {
            "1_region_win_share_plus_5": m(C, "region_buf", "win_share") >= m(L, "region_buf", "win_share") + 0.05,
            "2_beats_L_in_2_of_3_folds": sum(C["region_buf"]["by_fold"][f]["win_share"]["mean"]
                                             >= L["region_buf"]["by_fold"][f]["win_share"]["mean"] for f in FOLDS) >= 2,
            "3_region_loglik_better": m(C, "region_buf", "loglik_per_record") > m(L, "region_buf", "loglik_per_record"),
            "4_region_days_within_1": m(C, "region_buf", "median_days") <= m(L, "region_buf", "median_days") + 1.0,
            "5a_inyear_win_share_within_3": m(C, "inyear", "win_share") >= m(L, "inyear", "win_share") - 0.03,
            "5b_inyear_loglik_within_0.02": m(C, "inyear", "loglik_per_record")
            >= m(L, "inyear", "loglik_per_record") - 0.02,
        }
        s["pass"] = all(s["checks"].values())
        # the same five checks on the unbuffered region test (reported, not used)
        s["checks_unbuffered"] = {
            "1": m(C, "region_all", "win_share") >= m(L, "region_all", "win_share") + 0.05,
            "2": sum(C["region_all"]["by_fold"][f]["win_share"]["mean"]
                     >= L["region_all"]["by_fold"][f]["win_share"]["mean"] for f in FOLDS) >= 2,
            "3": m(C, "region_all", "loglik_per_record") > m(L, "region_all", "loglik_per_record"),
            "4": m(C, "region_all", "median_days") <= m(L, "region_all", "median_days") + 1.0,
        }
    if BASE in V and DIAG in V:
        dd = m_diag = V[DIAG]["inyear"]["loglik_per_record"]["mean"] - V[BASE]["inyear"]["loglik_per_record"]["mean"]
        s["diagnostic"] = {"delta_D": m_diag, "seeds": V[DIAG]["seeds"],
                           "reading": "most" if dd <= -0.025 else ("part" if dd <= -0.010 else "not")}
    return s


def per_species_csv(tag):
    """One row per (fold, test, scored species): calendar and every run's log-likelihood and days, full precision."""
    runs, cals = load_runs(tag)
    rows = []
    for f in FOLDS:
        if f not in cals:
            continue
        c = cals[f]
        for t in TESTS:
            n_test = np.array(c[t]["n"])
            ok = (np.array(c["n_train"]) >= SCORED_TRAIN) & (n_test >= SCORED_TEST)
            d = pd.DataFrame({"fold": f, "test": t, "species": c["species"], "n_train": c["n_train"],
                              "n_test": n_test, "ll_calendar": c[t]["per"], "days_calendar": c[t]["days"]})
            for (ff, v, x), r in sorted(runs.items()):
                if ff == f:
                    d[f"ll_{v}_s{x}"] = r[t]["per"]
                    d[f"days_{v}_s{x}"] = r[t]["days"]
            rows.append(d[ok])
    if rows:
        pd.concat(rows).to_csv(OUT / tag / "per_species.csv", index=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--workers", type=int, default=1)
    args = ap.parse_args()
    tag = "smoke" if args.smoke else "full"
    if not args.summary:
        log("loading records")
        df = records()
        if args.smoke:
            df = df.sample(frac=0.02, random_state=0).reset_index(drop=True)
        log(f"  {len(df):,} records")
        places = Places(records() if args.smoke else df)
        for c in (P2 / "raw" / tag).glob("*/*.claim"):
            c.unlink()  # claims from a run that died with the container
        epochs = 2 if args.smoke else EPOCHS
        threads = max(1, 4 // args.workers)
        pids = []
        for _ in range(args.workers):
            pid = os.fork()
            if pid == 0:
                worker(df, places, tag, epochs, threads)
                os._exit(0)
            pids.append(pid)
        for pid in pids:
            os.waitpid(pid, 0)
    s = summarise(tag)
    (OUT / tag).mkdir(parents=True, exist_ok=True)
    (OUT / tag / "gate.json").write_text(json.dumps(s, indent=1))
    per_species_csv(tag)
    log(f"checks: {s.get('checks')}  PASS = {s.get('pass')}  diagnostic: {s.get('diagnostic')}")
    log("GATE2_DONE")


if __name__ == "__main__":
    main()
