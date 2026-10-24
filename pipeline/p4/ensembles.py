#!/usr/bin/env python3
"""C8 (FROZEN_P4.md): do averages of the models beat each model? Scored on the cached Midwest LOYO folds.

Members: P3 refit (m0j), P1's empirical-DD dates (p1), and the Midwest-only winter-term model (m6). These were chosen
after seeing scores (P1 from the free look in FROZEN_P4.md, m6 as the best Midwest-only candidate), so the intervals are optimistic. Bootstrap over years gives a 95% interval on each
difference to P3.
"""
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from p4 import run_p4 as R  # noqa: E402


def rows(c):
    return (pd.DataFrame([r for f in R.CACHE.glob(f"{c}_*.pkl") for r in pickle.loads(f.read_bytes())["rows"]])
            .query("set == 'mw'").sort_values(["cell", "year"]).reset_index(drop=True))


def err(d, o, p):
    return ((o - d.onset).abs() + (p - d.peak).abs()) / 2


def main():
    a, b = rows("m0j"), rows("m6")
    members = {"P3": (a.m_onset, a.m_peak), "P1": (a.p1_onset, a.p1_peak), "winter": (b.m_onset, b.m_peak),
               "calendar": (a.cal_onset, a.cal_peak)}
    ens = {"P3": ["P3"], "P3+P1": ["P3", "P1"], "P3+winter": ["P3", "winter"],
           "P3+P1+winter": ["P3", "P1", "winter"], "P3+0.2*calendar": None}
    rng = np.random.default_rng(0)
    yrs = sorted(a.year.unique())
    out = {}
    for name, mem in ens.items():
        if mem is None:
            o = 0.8 * members["P3"][0] + 0.2 * members["calendar"][0]
            p = 0.8 * members["P3"][1] + 0.2 * members["calendar"][1]
        else:
            o = sum(members[m][0] for m in mem) / len(mem)
            p = sum(members[m][1] for m in mem) / len(mem)
        out[name] = err(a, o, p)
    base = out["P3"]
    for name, e in out.items():
        diffs = []
        for _ in range(2000):
            pick = rng.choice(yrs, len(yrs))
            idx = np.concatenate([np.where(a.year == y)[0] for y in pick])
            diffs.append(e.iloc[idx].mean() - base.iloc[idx].mean())
        print(f"{name:18s} MAE {e.mean():.3f}  minus P3 {e.mean() - base.mean():+.3f}  95% CI {np.percentile(diffs, [2.5, 97.5]).round(2)}")


if __name__ == "__main__":
    main()
