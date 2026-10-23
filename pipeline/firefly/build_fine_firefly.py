#!/usr/bin/env python3
"""Finer firefly hexes (res 5, ~17 km) for zoomed-in views: public/fine-firefly/, same format as public/fine/.

Same idea as pipeline/replay/build_fine.py: nothing is refit. The leave-one-year-out fits come from
pipeline/firefly/result.json (written by build_firefly.py), with every band's window ending on day 240.
Each finer hex uses the 1 km Daymet temperatures at its own centre. "Seen" and Daymet gaps come from the res-4
parent. Refuses to write unless those fits reproduce public/firefly-replay.json's res-4 forecast exactly.

Res 6 (~27,000 cells, hours of Daymet calls) is not built yet; the app stays at res 5 for fireflies.
Run after build_firefly.py: python3 pipeline/firefly/build_fine_firefly.py
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "replay"))
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(ROOT / "notebooks"))

import build_fine as BF  # noqa: E402
import build_replay as BR  # noqa: E402
from build_replay import h3  # noqa: E402
from firefly import build_firefly as FF  # noqa: E402
from firefly.fetch import EFFORT, RAW  # noqa: E402

OUT = ROOT / "public" / "fine-firefly"
RES = 5


def main():
    import pandas as pd
    from fit import data as fdata, model as M
    t0 = time.time()
    replay = json.loads(FF.OUT.read_text())
    result = json.loads(FF.RESULT.read_text())
    years = np.array(replay["years"])
    spec = M.SPECS[result["model"]["spec"]]
    params = {int(y): {**p, "u": np.array([])} for y, p in result["params"].items()}
    cut = {b: FF.LAST_DOY for b in BR.BAND_LABELS}
    cuts = {int(y): cut for y in years}
    E = fdata.effort_matrix(pd.read_parquet(EFFORT), years)
    cache = fdata.DATA / "daymet"

    r4 = replay["cells"]
    f4 = BR.cell_forecasts(r4, BF.daily_dd(r4, cache), years, params, cuts, E, spec)
    if f4 != replay["forecast"]:
        raise SystemExit("result.json's fold fits do not reproduce public/firefly-replay.json; rerun build_firefly.py")
    print("res 4 reproduced", flush=True)

    rec_hexes = BR.clean(pd.read_parquet(RAW)).hex.unique()
    seen4 = dict(zip(r4, replay["seen"]))
    fc4 = {c: {m: replay["forecast"][m][i] for m in replay["forecast"]} for i, c in enumerate(r4)}
    _, _, cells = BF.order_cells(BR.core_cells(res=RES))
    parents = sorted({h3.cell_to_parent(c, BF.PARENT_RES) for c in cells})
    extra = [p for p in parents if p not in seen4]
    if extra:
        for p, s in zip(extra, BR.seen_flags(extra, rec_hexes)):
            seen4[p] = s
        fx = BR.cell_forecasts(extra, BF.daily_dd_or_fill(extra, cache), years, params, cuts, E, spec)
        for i, p in enumerate(extra):
            fc4[p] = {m: fx[m][i] for m in fx}
    fc, n_bad = BF.level_forecast(cells, years, spec, params, cuts, E, cache,
                                  lambda c: fc4[h3.cell_to_parent(c, BF.PARENT_RES)])
    seen = [seen4[h3.cell_to_parent(c, BF.PARENT_RES)] for c in cells]
    d = OUT / f"r{RES}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "cells.bin").write_bytes(BF.encode_cells(cells, seen))
    for m, rows in fc.items():
        (d / f"{m}.bin").write_bytes(BF.encode_mode(rows))
    manifest = {"version": 1, "generated": replay["generated"], "model": replay["model"]["id"],
                "offset": BF.OFFSET, "never": BF.NEVER, "quantiles": replay["quantiles"],
                "modes": [str(int(y)) for y in years] + ["typical"], "parent_res": BF.PARENT_RES,
                "levels": {str(RES): {"cells": len(cells), "seen_cells": int(sum(seen)), "daymet_filled": n_bad}}}
    (OUT / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"res {RES}: {len(cells)} cells, {n_bad} took the parent's; done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
