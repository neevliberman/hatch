"""Tests for build_fine (finer hexes). Run: python3 -m pytest pipeline/replay"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_fine as f  # noqa: E402
import build_replay as b  # noqa: E402

h3 = b.h3
MANIFEST = f.OUT / "manifest.json"


def _toy_cells(res):
    parent = h3.latlng_to_cell(41.9, -88.0, 4)
    kids = sorted(h3.cell_to_children(parent, res), key=h3.str_to_int)
    other = h3.latlng_to_cell(44.0, -90.0, 4)
    more = sorted(h3.cell_to_children(other, res), key=h3.str_to_int)
    return kids[::2] + more[1:4]


@pytest.mark.parametrize("res", [5, 6])
def test_cells_round_trip(res):
    cells = _toy_cells(res)
    _, _, ordered = f.order_cells(cells)
    seen = [i % 3 == 0 for i in range(len(ordered))]
    got, got_seen = f.decode_cells(f.encode_cells(ordered, [int(s) for s in seen]))
    assert got == ordered
    assert got_seen == [int(s) for s in seen]


def test_mode_round_trip_and_range():
    rows = [[60, 100, 150, 200, 300], [None, None, 120, 130, None]]
    assert f.decode_mode(f.encode_mode(rows), 2) == rows
    with pytest.raises(ValueError):
        f.encode_mode([[59, 100, 150, 200, 300]])
    with pytest.raises(ValueError):
        f.encode_mode([[60, 100, 150, 200, 315]])


def _level(res):
    m = json.loads(MANIFEST.read_text())
    if str(res) not in m["levels"]:
        pytest.skip(f"res {res} not built")
    d = f.OUT / f"r{res}"
    cells, seen = f.decode_cells((d / "cells.bin").read_bytes())
    fc = {mode: f.decode_mode((d / f"{mode}.bin").read_bytes(), len(cells)) for mode in m["modes"]}
    return m, cells, seen, fc


@pytest.mark.skipif(not MANIFEST.exists(), reason="public/fine not built")
@pytest.mark.parametrize("res", [5, 6])
def test_shipped_level_matches_manifest_and_core(res):
    m, cells, seen, fc = _level(res)
    assert len(cells) == m["levels"][str(res)]["cells"] == len(set(cells))
    assert all(h3.get_resolution(c) == res for c in cells)
    for rows in fc.values():
        assert len(rows) == len(cells)
        for r in rows:
            v = [x for x in r if x is not None]
            assert v == sorted(v)   # quantile days never go backwards
    # seen is inherited from the res-4 parent
    replay = json.loads(b.OUT.read_text())
    seen4 = dict(zip(replay["cells"], replay["seen"]))
    for c, s in zip(cells, seen):
        p = h3.cell_to_parent(c, 4)
        if p in seen4:
            assert s == seen4[p]


@pytest.mark.skipif(not MANIFEST.exists(), reason="public/fine not built")
def test_res5_children_average_close_to_res4_parent():
    """Finer hexes add local detail; they should not shift the forecast. Averaged over a parent's children,
    the median day stays within a couple of days of the parent's in nearly every hex and every season."""
    _, cells, _, fc = _level(5)
    replay = json.loads(b.OUT.read_text())
    idx = {c: i for i, c in enumerate(replay["cells"])}
    diffs = []
    for mode, rows in fc.items():
        kids = defaultdict(list)
        for c, r in zip(cells, rows):
            if r[2] is not None:
                kids[h3.cell_to_parent(c, 4)].append(r[2])
        for p, v in kids.items():
            if p in idx and len(v) >= 5 and replay["forecast"][mode][idx[p]][2] is not None:
                diffs.append(np.mean(v) - replay["forecast"][mode][idx[p]][2])
    diffs = np.abs(np.array(diffs))
    assert len(diffs) > 4000
    assert diffs.mean() < 1.0
    assert np.percentile(diffs, 95) < 2.5
    assert diffs.max() < 8
