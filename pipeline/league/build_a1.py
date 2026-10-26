#!/usr/bin/env python3
"""Build the A1 shadow's envelopes (run once, offline): writes pipeline/league/a1_envelopes.json.

The rule (pipeline/fit/PREREG_2027.md, "Second shadow"): per fold fit, E(t) = on each day index t (day of year - 1)
the largest banked degree-days (Daymet, base 10 C, 30 C cap, from 1 March) at any training place-year, a hexagon and
year with at least one first-brood training record of that fold, all latitudes pooled. Same code as the scored
exploration (notebooks/southbias/run.py: fold_data + sb.envelope); one array of 365 numbers per fold, in the order of
pipeline/replay/fold_fits.json (2015 ... 2025 left out).

Run: python3 pipeline/league/build_a1.py   (~30 s: loads P3's records and the Daymet cube)
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(ROOT / "pipeline"), str(ROOT / "notebooks"), str(ROOT / "notebooks" / "southbias")]

from fit import context, evaluate as EV  # noqa: E402
from live import shadow_rule as R  # noqa: E402
import sb  # noqa: E402

OUT = HERE / "a1_envelopes.json"
FITS = ROOT / "pipeline" / "replay" / "fold_fits.json"


def main():
    ctx = context.load_context()
    rec = ctx.rec
    folds = list(json.loads(FITS.read_text())["folds"])
    assert folds == [str(int(y)) for y in ctx.years], (folds, ctx.years)
    env = {}
    for y in ctx.years:
        tr = rec[rec.year != y]
        train = EV.first_brood(tr, EV.cutoffs(tr))
        env[str(int(y))] = R.check_envelope(sb.envelope(ctx.cum, train.h.to_numpy(), train.y.to_numpy()))
    out = {"version": 1, "rule": "PREREG_2027.md, Second shadow, step 1", "fits": FITS.name,
           "fits_sha256": hashlib.sha256(FITS.read_bytes()).hexdigest(), "folds": folds,
           "envelopes": [[round(float(v), 2) for v in env[f]] for f in folds]}
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    d15 = 104                                                    # 15 April (non-leap day index)
    print(f"wrote {OUT.name}: 11 folds; by 15 April {min(e[d15] for e in env.values()):.0f}"
          f"-{max(e[d15] for e in env.values()):.0f} degree-days")


if __name__ == "__main__":
    main()
