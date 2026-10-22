#!/usr/bin/env python3
"""Finer forecast hexes for zoomed-in views: res 5 and res 6 (see README.md, "Finer hexes").

Same forecast as the res-4 map (build_replay.py), just evaluated at more places: each finer hex gets the 1 km
Daymet temperatures at its own centre, so lake-shore cooling, city heat and river valleys show. Nothing is refit:
the leave-one-year-out fold fits come from pipeline/replay/fold_fits.json, which build_replay.py writes. Each
fold's brood cut-offs, each cell's state effort profile and latitude strip work exactly as at res 4.

Scores and accuracy claims stay at the latitude-strip level. A finer hex is not checked on its own.

Output, under public/fine/ (static files the app fetches when the user zooms in):
  manifest.json            levels present, modes, day offset, cell counts
  r{res}/cells.bin         which cells, in which order, and their "seen" flag (format below)
  r{res}/{mode}.bin        per cell, 5 bytes: day of year minus OFFSET for 5/25/50/75/95%, 255 = never

cells.bin (little-endian):
  "HXC1", u8 res, u8 parent res (4), u16 mask bytes per parent (B), u32 parent count (P), u32 cell count (N)
  P x (u32 low, u32 high)   res-4 parent H3 index, ascending
  P x B bytes               bit k set = k-th child (children of that parent at `res`, ascending H3 index) is present
  ceil(N / 8) bytes         seen bitset (cell i -> byte i >> 3, bit i & 7), inherited from the res-4 parent
Cells are listed parent by parent, children ascending: that is the row order of every {mode}.bin.

Run from the repo root after build_replay.py: python3 pipeline/replay/build_fine.py [--res 5 6]
Daymet for every core cell must already be cached (notebooks/data/daymet/<h3>_2015-2025.csv); missing cells are
fetched (slow: ~5 cells/s), and a cell Daymet cannot serve takes its parent's forecast.
"""
import argparse
import json
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_replay as BR  # noqa: E402
from build_replay import ROOT, h3  # noqa: E402
from hatch_p1.daymet import _fetch_one, temperature_cube  # noqa: E402
from hatch_p1.degree_days import accumulate  # noqa: E402
from hatch_p1.prep import YEARS  # noqa: E402

OUT = ROOT / "public" / "fine"
FOLD_FITS = HERE / "fold_fits.json"
PARENT_RES = 4
OFFSET = 60          # byte = doy - OFFSET; forecasts start on 1 March (doy 60) and end by MAX_DOY (300)
NEVER = 255
CHUNK = 1500         # cells per Daymet chunk (keeps the cube to ~50 MB)
MAGIC = b"HXC1"


# ---------------------------------------------------------------- encoding
def order_cells(cells, parent_res=PARENT_RES):
    """Group cells by res-4 parent (ascending), children ascending. Returns (parents, masks, ordered cells)."""
    res = h3.get_resolution(cells[0])
    have = set(cells)
    parents = sorted({h3.cell_to_parent(c, parent_res) for c in cells}, key=h3.str_to_int)
    nb = (7 ** (res - parent_res) + 7) // 8
    masks, ordered = [], []
    for p in parents:
        kids = sorted(h3.cell_to_children(p, res), key=h3.str_to_int)
        m = 0
        for k, c in enumerate(kids):
            if c in have:
                m |= 1 << k
                ordered.append(c)
        masks.append(m.to_bytes(nb, "little"))
    return parents, masks, ordered


def encode_cells(cells, seen, parent_res=PARENT_RES):
    """cells must already be in order_cells order; seen: 0/1 per cell."""
    res = h3.get_resolution(cells[0])
    parents, masks, ordered = order_cells(cells, parent_res)
    assert ordered == list(cells), "cells are not in order_cells order"
    nb = len(masks[0])
    out = bytearray(MAGIC + struct.pack("<BBHII", res, parent_res, nb, len(parents), len(cells)))
    for p in parents:
        v = h3.str_to_int(p)
        out += struct.pack("<II", v & 0xFFFFFFFF, v >> 32)
    for m in masks:
        out += m
    bits = np.packbits(np.asarray(seen, np.uint8), bitorder="little")
    out += bits.tobytes()
    return bytes(out)


def decode_cells(buf):
    """Inverse of encode_cells (the app does the same in src/layers/fineData.ts). Returns (cells, seen)."""
    assert buf[:4] == MAGIC
    res, pres, nb, P, N = struct.unpack_from("<BBHII", buf, 4)
    o = 16
    parents = []
    for _ in range(P):
        lo, hi = struct.unpack_from("<II", buf, o)
        parents.append(h3.int_to_str(lo | (hi << 32)))
        o += 8
    cells = []
    for p in parents:
        m = int.from_bytes(buf[o:o + nb], "little")
        o += nb
        kids = sorted(h3.cell_to_children(p, res), key=h3.str_to_int)
        cells += [c for k, c in enumerate(kids) if m >> k & 1]
    assert len(cells) == N
    seen = np.unpackbits(np.frombuffer(buf[o:o + (N + 7) // 8], np.uint8), bitorder="little")[:N]
    return cells, seen.astype(int).tolist()


def encode_mode(rows):
    """rows: per cell [q05..q95] day of year or None -> bytes (5 per cell)."""
    a = np.array([[NEVER if v is None else v - OFFSET for v in r] for r in rows], dtype=np.int64)
    ok = np.array([[v is not None for v in r] for r in rows], bool)
    if ok.any() and (a[ok].min() < 0 or a[ok].max() >= NEVER):
        raise ValueError(f"day out of range for a byte: {a[ok].min() + OFFSET}..{a[ok].max() + OFFSET}")
    return a.astype(np.uint8).tobytes()


def decode_mode(buf, n, nq=5):
    a = np.frombuffer(buf, np.uint8).reshape(n, nq).astype(int)
    return [[None if v == NEVER else int(v) + OFFSET for v in r] for r in a]


# ---------------------------------------------------------------- fold fits
def load_fold_fits(path=FOLD_FITS):
    """(spec, {year: params with u = 0}, {year: {band: cut-off doy}}) as written by build_replay.py."""
    from fit import model as M
    js = json.loads(path.read_text())
    params = {int(y): {**{k: float(v) for k, v in f["params"].items()}, "u": np.array([])}
              for y, f in js["folds"].items()}
    cuts = {int(y): {b: int(c) for b, c in f["cuts"].items()} for y, f in js["folds"].items()}
    return M.SPECS[js["spec"]], params, cuts


# ---------------------------------------------------------------- daymet
def daily_dd(cells, cache):
    """Daily degree-days [cell, year, 365] for cells (all cached), exactly as fit.context does it."""
    from fit.context import BASE, daily_from_cum
    _, _, tmin, tmax = temperature_cube(cells, YEARS[0], YEARS[1], cache)
    return daily_from_cum(accumulate(tmin, tmax, BASE).astype(np.float32))


def ensure_daymet(cells, cache, workers=4):
    """Fetch any uncached cell; returns the cells Daymet could not serve."""
    todo = [c for c in cells if not (cache / f"{c}_{YEARS[0]}-{YEARS[1]}.csv").exists()]
    if todo:
        print(f"fetching Daymet for {len(todo)} cells", flush=True)
        with ThreadPoolExecutor(workers) as ex:
            got = dict(ex.map(lambda h: _fetch_one(h, YEARS[0], YEARS[1], cache), todo))
        return [c for c in todo if got[c] is None]
    return []


# ---------------------------------------------------------------- one level
def level_forecast(cells, years, spec, params, cuts, E, cache, fallback):
    """Forecast for every cell, in chunks. fallback(cell) -> parent's {mode: [q..]} for cells without Daymet."""
    bad = set(ensure_daymet(cells, cache))
    good = [c for c in cells if c not in bad]
    modes = [str(int(y)) for y in years] + ["typical"]
    fc = {}
    for s in range(0, len(good), CHUNK):
        part = good[s:s + CHUNK]
        f = BR.cell_forecasts(part, daily_dd(part, cache), years, params, cuts, E, spec)
        for k, c in enumerate(part):
            fc[c] = {m: f[m][k] for m in modes}
        print(f"  {min(s + CHUNK, len(good))}/{len(good)}", flush=True)
    for c in bad:
        fc[c] = fallback(c)
    return {m: [fc[c][m] for c in cells] for m in modes}, len(bad)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", type=int, nargs="+", default=[5, 6])
    a = ap.parse_args(argv)
    t0 = time.time()
    from fit import data as fdata
    replay = json.loads(BR.OUT.read_text())
    years = np.array(replay["years"])
    spec, params, cuts = load_fold_fits()
    E = fdata.effort_matrix(fdata.fetch_effort(), years)
    cache = fdata.DATA / "daymet"

    # Guard: the fold fits must reproduce the shipped res-4 forecast exactly, or the levels would disagree.
    r4 = replay["cells"]
    f4 = BR.cell_forecasts(r4, daily_dd(r4, cache), years, params, cuts, E, spec)
    if f4 != replay["forecast"]:
        raise SystemExit("fold_fits.json does not reproduce src/data/luna-replay.json's forecast; rerun build_replay.py")
    print("res 4 reproduced from fold_fits.json", flush=True)

    # "seen" and missing-Daymet fallbacks come from the res-4 parent (the parent may sit just outside the
    # core states, so compute its forecast and seen flag from scratch when it is not a res-4 core cell).
    raw = BR.fetch_luna()
    rec_hexes = BR.clean(raw).hex.unique()
    seen4 = dict(zip(r4, replay["seen"]))
    fc4 = {c: {m: replay["forecast"][m][i] for m in replay["forecast"]} for i, c in enumerate(r4)}

    manifest = {"version": 1, "generated": replay["generated"], "model": replay.get("model", {}).get("id"),
                "offset": OFFSET, "never": NEVER, "quantiles": replay["quantiles"],
                "modes": [str(int(y)) for y in years] + ["typical"], "parent_res": PARENT_RES, "levels": {}}
    old = OUT / "manifest.json"
    if old.exists():   # keep levels built earlier (e.g. res 6 built in a separate run)
        manifest["levels"] = json.loads(old.read_text()).get("levels", {})

    for res in a.res:
        cells = BR.core_cells(res=res)
        _, _, cells = order_cells(cells)
        print(f"res {res}: {len(cells)} core cells", flush=True)
        parents = sorted({h3.cell_to_parent(c, PARENT_RES) for c in cells})
        extra = [p for p in parents if p not in seen4]
        if extra:
            for p, s in zip(extra, BR.seen_flags(extra, rec_hexes)):
                seen4[p] = s
            fx = BR.cell_forecasts(extra, daily_dd_or_fill(extra, cache), years, params, cuts, E, spec)
            for i, p in enumerate(extra):
                fc4[p] = {m: fx[m][i] for m in fx}
        fc, n_bad = level_forecast(cells, years, spec, params, cuts, E, cache,
                                   lambda c: fc4[h3.cell_to_parent(c, PARENT_RES)])
        seen = [seen4[h3.cell_to_parent(c, PARENT_RES)] for c in cells]
        d = OUT / f"r{res}"
        d.mkdir(parents=True, exist_ok=True)
        (d / "cells.bin").write_bytes(encode_cells(cells, seen))
        size = 0
        for m, rows in fc.items():
            b = encode_mode(rows)
            (d / f"{m}.bin").write_bytes(b)
            size += len(b)
        manifest["levels"][str(res)] = {"cells": len(cells), "seen_cells": int(sum(seen)), "daymet_filled": n_bad}
        print(f"res {res}: wrote {d} ({size / 1024:.0f} KB of forecasts, {n_bad} cells took the parent's)", flush=True)

    manifest["levels"] = dict(sorted(manifest["levels"].items()))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"done in {time.time() - t0:.0f}s")


def daily_dd_or_fill(cells, cache):
    """Daily degree-days for border parents; any Daymet gap is filled from the nearest good cell (as build_replay)."""
    years, tmin, tmax, _ = BR.daymet_cube(cells, cache)
    from fit.context import BASE, daily_from_cum
    return daily_from_cum(accumulate(tmin, tmax, BASE).astype(np.float32))


if __name__ == "__main__":
    main()
