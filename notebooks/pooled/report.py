#!/usr/bin/env python3
"""Score results/rows.csv.gz into results/summary.json, per_species.csv and figures/pooled_vs_n.png. Offline."""
import json
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
RES = HERE / "results"
FIG = HERE / "figures"
ARMS = ["cal", "cal_lat", "p1", "p3", "unpooled", "shared", "traits"]
NS = ["10", "25", "50", "all"]
PAIRS = [("shared", "p3"), ("traits", "p3"), ("shared", "unpooled"), ("traits", "unpooled"), ("traits", "shared"),
         ("p3", "cal"), ("shared", "cal"), ("p3", "cal_lat"), ("shared", "cal_lat"), ("cal_lat", "cal")]
TITLE = "52 Midwest moths, leave-one-year-out (exploratory)"


def per_target(rows):
    d = rows.copy()
    d["err"] = ((d.pred_onset - d.onset).abs() + (d.pred_peak - d.peak).abs()) / 2
    d["bias"] = ((d.pred_onset - d.onset) + (d.pred_peak - d.peak)) / 2
    d["n"] = d.n.astype(str)
    # average the random draws first: one number per target (species, year, band), arm and n
    return d.groupby(["sp", "species", "year", "band", "arm", "n"], as_index=False)[["err", "bias"]].mean()


def species_means(t):
    return t.groupby(["sp", "species", "arm", "n"], as_index=False)["err"].mean()


def _ci(v, draws=4000, seed=0):
    bs = np.random.default_rng(seed).choice(v, (draws, len(v))).mean(1)
    return float(v.mean()), float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))


def paired(sm, a, b, n):
    """Per-species err(a) - err(b) at size n (below 0: a is better)."""
    x = sm[(sm.arm == a) & (sm.n == n)].set_index("sp").err
    y = sm[(sm.arm == b) & (sm.n == n)].set_index("sp").err
    k = x.index.intersection(y.index)
    return (x[k] - y[k]).to_numpy()


def boot_diff(sm, a, b, n):
    """Mean over species of err(a) - err(b), 95% interval resampling species."""
    d = paired(sm, a, b, n)
    m, lo, hi = _ci(d)
    return {"mean": m, "ci": [lo, hi], "share_species_a_better": float((d < 0).mean()), "species": int(len(d))}


def main():
    rows = pd.read_csv(RES / "rows.csv.gz")
    t = per_target(rows)
    sm = species_means(t)
    tab = {n: {a: round(float(sm[(sm.arm == a) & (sm.n == n)].err.mean()), 2) for a in ARMS} for n in NS}
    tab["0"] = {a: round(float(sm[(sm.arm == f"prior_{a}") & (sm.n == "0")].err.mean()), 2) for a in ("shared", "traits")}
    by_target = {n: {a: round(float(t[(t.arm == a) & (t.n == n)].err.mean()), 2) for a in ARMS} for n in NS}
    diffs = {n: {f"{a}-{b}": boot_diff(sm, a, b, n) for a, b in PAIRS} for n in NS}
    per_species = (sm[sm.n.isin(["10", "all"])].pivot_table(index="species", columns=["n", "arm"], values="err")
                   .round(2))
    per_species.columns = [f"{a}@{n}" for n, a in per_species.columns]
    per_species.to_csv(RES / "per_species.csv")
    bias = {n: {a: round(float(t[(t.arm == a) & (t.n == n)].bias.mean()), 2) for a in ARMS} for n in NS}
    fits = pd.read_csv(RES / "fits.csv.gz")
    fits["n"] = fits.n.astype(str)
    at_bound = {n: fits[fits.n == n].groupby("arm").alpha.apply(lambda a: round(float((a > 14.9).mean()), 3)).to_dict()
                for n in NS}
    # best calendar at each n (lower mean over species), and heat vs that calendar
    best_cal = {n: min(("cal", "cal_lat"), key=lambda a: tab[n][a]) for n in NS}
    vs_best = {n: {h: boot_diff(sm, h, best_cal[n], n) for h in ("p3", "shared", "traits")} for n in NS}
    wins = {h: int((paired(sm, h, "cal", "all") < 0).sum()) for h in ("p3", "shared", "traits")}
    n_scored = int(len(paired(sm, "p3", "cal", "all")))
    pins = fits[(fits.arm == "unpooled_full")]
    pinned_share = float(pins.pinned.mean()) if "pinned" in pins else None
    est = None
    cfile = RES / "census.json"
    if cfile.exists():
        c = json.loads(cfile.read_text())
        n400 = c["species_with_at_least_clean_est"]["400"]
        pr = c["selection"]["pass_rate"]
        wr = wins["p3"] / n_scored
        est = {"species_400plus_clean": n400, "selection_pass_rate": pr, "heat_beats_calendar_rate": round(wr, 3),
               "upper_bound": round(n400 * pr * wr)}
    out = {"targets": int(t[["sp", "year", "band"]].drop_duplicates().shape[0]),
           "species_scored": int(t.sp.nunique()),
           "mae_species_mean": tab, "mae_target_mean": by_target, "diffs": diffs, "mean_bias": bias,
           "share_fits_skew_at_bound_15": at_bound, "best_calendar": best_cal, "heat_vs_best_calendar": vs_best,
           "heat_beats_calendar_all_records": wins, "species_scored_all": n_scored,
           "share_full_fits_pinned": pinned_share, "species_estimate": est}
    (RES / "summary.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({"mae": tab, "diffs": {n: {k: (round(v["mean"], 2), [round(c, 2) for c in v["ci"]],
                                                  round(v["share_species_a_better"], 2))
                                              for k, v in d.items()} for n, d in diffs.items()}}, indent=1))
    figure(sm)


def figure(sm):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    FIG.mkdir(exist_ok=True)
    x = np.arange(len(NS))
    xl = ["10", "25", "50", "all\n(~150-2,200)"]
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 4.6), dpi=150, gridspec_kw={"width_ratios": [1.35, 1]})
    lines = [("cal", "Calendar: those records' own dates", "#52514e", (0, (4, 3))),
             ("cal_lat", "Calendar slid by latitude", "#52514e", (0, (1, 2))),
             ("p3", "Heat model, species alone (P3 code)", "#eb6834", "-"),
             ("shared", "Heat model, pooled across species", "#2a78d6", "-")]
    for arm, label, col, ls in lines:
        st = [_ci(sm[(sm.arm == arm) & (sm.n == n)].err.to_numpy()) for n in NS]
        y, lo, hi = map(np.array, zip(*st))
        if arm != "cal_lat":
            a1.fill_between(x, lo, hi, color=col, alpha=0.10, linewidth=0)
        a1.plot(x, y, color=col, ls=ls, lw=2, marker="o", ms=6, markeredgecolor="white", markeredgewidth=1.5,
                label=label)
    a1.set_ylim(0, 13)
    a1.set_ylabel("Days off (onset and peak), mean over species")
    a1.set_title("Error vs records per species", loc="left", fontsize=10.5)
    a1.legend(frameon=False, fontsize=8.5, loc="lower left")
    for arm, col, off, label in (("shared", "#2a78d6", -0.08, "pooled"), ("traits", "#1baf7a", 0.08, "pooled + traits")):
        st = [_ci(-paired(sm, arm, "p3", n)) for n in NS]
        y, lo, hi = map(np.array, zip(*st))
        a2.errorbar(x + off, y, yerr=[y - lo, hi - y], fmt="o", color=col, ms=6, capsize=0, lw=2, label=label)
    a2.axhline(0, color="#52514e", lw=1)
    a2.set_ylim(-1.2, 1.2)
    a2.set_ylabel("Days saved by pooling vs species alone, P3 fitter (95% CI)")
    a2.set_title("What pooling adds", loc="left", fontsize=10.5)
    a2.legend(frameon=False, fontsize=8.5, loc="upper right")
    for a in (a1, a2):
        a.set_xticks(x, xl)
        a.set_xlabel("Records of the species used for training")
        for s in ("top", "right"):
            a.spines[s].set_visible(False)
        a.grid(axis="y", color="#e6e5e1", lw=0.8)
        a.set_axisbelow(True)
    fig.suptitle(TITLE, x=0.01, ha="left", fontsize=11.5)
    fig.tight_layout()
    fig.savefig(FIG / "pooled_vs_n.png")


if __name__ == "__main__":
    main()
