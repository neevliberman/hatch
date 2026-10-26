"""Leave-one-year-out: does weather beat the season curve alone? Writes results/headline.json.

Run: python3 -m pipeline.activity.evaluate   (needs the cache from `python3 -m pipeline.activity.fetch`)
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

from .features import build
from .model import GROUPS, Fit, add_terms

OUT = Path(__file__).parent / "results"
RNG = np.random.default_rng(7)
GATE_YEARS, GATE_LIFT = 8, 1.25
# Only count days when the group is actually out and people look: keeps off-season zeros from carrying the score.
WINDOWS = {"moth": (121, 288), "firefly": (152, 213), "butterfly": (121, 288)}   # day-of-year, May-mid Oct / Jun-Jul / ...


def folds(df, group):
    lo, hi = WINDOWS[group]
    df = df[(df.doy >= lo) & (df.doy <= hi)].reset_index(drop=True)
    rows = []
    for y in sorted(df.year.unique()):
        tr, te = df[df.year != y], df[df.year == y].copy()
        base, full = Fit(tr, group, False), Fit(tr, group, True)
        te["mu_base"], te["mu_full"] = base.mean(te), full.mean(te)
        te["ll_base"], te["ll_full"] = base.loglik(te), full.loglik(te)
        te["fold"] = y
        rows.append(te)
        print(group, y, round(float((te.ll_full - te.ll_base).mean()), 4), flush=True)
    import pandas as pd
    return pd.concat(rows, ignore_index=True), full


def lift(te, group, boot=1000):
    """Top-third vs bottom-third of the weather's predicted lift: actual / baseline-expected, by box-year blocks."""
    y = te[GROUPS[group][0]].values.astype(float)
    te = te.assign(pred_lift=te.mu_full / te.mu_base, y=y)
    # terciles within each box and week, so the split is about weather, not about season or place
    te["wk"] = te.doy // 7
    te["tercile"] = te.groupby(["region", "wk"]).pred_lift.transform(
        lambda s: np.digitize(s.rank(pct=True), [1 / 3, 2 / 3]) if len(s) >= 3 else 1)
    te["block"] = te.region + te.year.astype(str)
    g = te.groupby(["block", "tercile"]).agg(y=("y", "sum"), mu=("mu_base", "sum")).unstack(fill_value=0)

    def ratio(blocks):
        s = g.loc[blocks]
        r = lambda t: s[("y", t)].sum() / max(s[("mu", t)].sum(), 1e-9)
        return r(2) / max(r(0), 1e-9), [r(0), r(1), r(2)]

    est, parts = ratio(list(g.index))
    bs = [ratio(list(RNG.choice(g.index, len(g.index))))[0] for _ in range(boot)]
    return dict(top_over_bottom=est, ci90=[float(np.percentile(bs, 5)), float(np.percentile(bs, 95))],
                actual_over_expected_by_third=[float(p) for p in parts])


def run(groups):
    df = add_terms(build())
    out = {}
    for group in groups:
        te, full = folds(df, group)
        gain = te.groupby("fold").apply(lambda d: float((d.ll_full - d.ll_base).sum()), include_groups=False)
        n = te.groupby("fold").size()
        res = dict(
            rows=int(len(te)), folds_won=int((gain > 0).sum()), folds=int(len(gain)),
            loglik_gain_per_day_by_year={int(k): float(v / n[k]) for k, v in gain.items()},
            lift=lift(te, group), alpha_full=full.alpha,
            coef={k: float(v) for k, v in full.res.params.items() if not k.startswith(("C(", "bs("))},
        )
        res["ships"] = res["folds_won"] >= GATE_YEARS and res["lift"]["top_over_bottom"] >= GATE_LIFT and res["lift"]["ci90"][0] > 1.0
        out[group] = res
        print(json.dumps({k: v for k, v in res.items() if k != "coef"}, indent=1))
    OUT.mkdir(exist_ok=True)
    (OUT / "headline.json").write_text(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    run(sys.argv[1:] or list(GROUPS))
