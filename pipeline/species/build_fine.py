#!/usr/bin/env python3
"""Finer hexes (res 5, ~17 km, and res 6, ~6 km) for one species in pipeline/species: public/species/<key>/fine/, same format as
public/fine/ (luna) and public/fine-firefly/.

    python3 pipeline/species/build_fine.py japanese-beetle            # after build.py (res 5 and 6)
    python3 pipeline/species/build_fine.py japanese-beetle --res 5    # one level only
    python3 pipeline/species/build_fine.py japanese-beetle --daymet-only   # just fill the Daymet cache (slow, once)

The firefly's pipeline/firefly/build_fine_firefly.py, made per species: nothing is refit. The leave-one-year-out
fits come from pipeline/species/<key>.result.json, every band's window ending on the species' last day. Each finer
hex uses the 1 km Daymet temperatures at its own centre; "seen" and Daymet gaps come from the res-4 parent. Refuses
to write unless those fits reproduce the species' res-4 replay.json exactly. The Daymet cache is shared with luna
and the firefly (~3,900 res-5 cells).
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
from species import get  # noqa: E402
from species.fetch import effort_path, raw_path  # noqa: E402

RESOLUTIONS = (5, 6)


def main():
    import pandas as pd
    from fit import data as fdata, model as M
    argv = sys.argv[1:]
    levels = RESOLUTIONS
    if "--res" in argv:
        i = argv.index("--res")
        levels = tuple(int(a) for a in argv[i + 1:] if a.isdigit())
        argv = argv[:i] + [a for a in argv[i + 1:] if not a.isdigit()]
    args = [a for a in argv if not a.startswith("--")]
    sp = get(args[0] if args else "japanese-beetle")
    cache = fdata.DATA / "daymet"
    if "--daymet-only" in sys.argv:
        for res in levels:
            _, _, cells = BF.order_cells(BR.core_cells(res=res))
            bad = BF.ensure_daymet(cells, cache)
            print(f"daymet for {len(cells)} res-{res} cells, {len(bad)} failed")
        return
    t0 = time.time()
    replay = json.loads(sp.replay.read_text())
    result = json.loads(sp.result.read_text())
    years = np.array(replay["years"])
    spec = M.SPECS[result["model"]["spec"]]
    params = {int(y): {**p, "u": np.array([])} for y, p in result["params"].items()}
    cut = {b: sp.last_doy for b in BR.BAND_LABELS}
    cuts = {int(y): cut for y in years}
    E = fdata.effort_matrix(pd.read_parquet(effort_path(sp)), years)

    r4 = replay["cells"]
    f4 = BR.cell_forecasts(r4, BF.daily_dd(r4, cache), years, params, cuts, E, spec)
    if not BF.reproduces(f4, replay["forecast"]):
        raise SystemExit(f"{sp.result.name}'s fold fits do not reproduce {sp.replay}; rerun build.py")
    print("res 4 reproduced", flush=True)

    rec_hexes = BR.clean(pd.read_parquet(raw_path(sp))).hex.unique()
    seen4 = dict(zip(r4, replay["seen"]))
    fc4 = {c: {m: replay["forecast"][m][i] for m in replay["forecast"]} for i, c in enumerate(r4)}
    for res in levels:
        build_level(sp, res, replay, years, params, cuts, E, spec, rec_hexes, seen4, fc4, cache, t0)


def build_level(sp, res, replay, years, params, cuts, E, spec, rec_hexes, seen4, fc4, cache, t0):
    _, _, cells = BF.order_cells(BR.core_cells(res=res))
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
    out = sp.out_dir / "fine"
    d = out / f"r{res}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "cells.bin").write_bytes(BF.encode_cells(cells, seen))
    for m, rows in fc.items():
        (d / f"{m}.bin").write_bytes(BF.encode_mode(rows))
    old = out / "manifest.json"
    levels = json.loads(old.read_text())["levels"] if old.exists() else {}
    levels[str(res)] = {"cells": len(cells), "seen_cells": int(sum(seen)), "daymet_filled": n_bad}
    manifest = {"version": 1, "generated": replay["generated"], "model": replay["model"]["id"],
                "offset": BF.OFFSET, "never": BF.NEVER, "quantiles": replay["quantiles"],
                "modes": [str(int(y)) for y in years] + ["typical"], "parent_res": BF.PARENT_RES,
                "levels": dict(sorted(levels.items()))}
    (out / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"res {res}: {len(cells)} cells, {n_bad} took the parent's; done in {time.time() - t0:.0f}s")




if __name__ == "__main__":
    main()
