"""No-network checks for the Atlas pieces: the warmth clock, the shares, the scorer."""
import numpy as np
import pandas as pd
import torch

from pipeline.atlas import data as D
from pipeline.atlas import model as M
from pipeline.atlas.score import AtlasModel, Calendar, score


def _warmth(shift_days):
    """Two years at one cell: a typical year, and the same year `shift_days` earlier."""
    days = np.arange(1, 366, dtype=np.float32)
    typical = np.clip(days - 60, 0, None) ** 1.5 / 10
    early = np.clip(days + shift_days - 60, 0, None) ** 1.5 / 10
    dd = np.stack([typical, early])[None]
    return D.Warmth(np.array(["c"]), np.array([2020, 2021]), dd, typical[None], {"c": 0})


def test_days_ahead_reads_a_shifted_spring():
    a = _warmth(10).days_ahead()
    assert np.allclose(a[0, 0, 80:200], 0, atol=0.5)        # the typical year is never ahead
    assert np.allclose(a[0, 1, 80:200], 10, atol=0.5)       # the early year is 10 days ahead all spring


def test_days_ahead_clips_and_holds():
    a = _warmth(60).days_ahead()
    assert a.max() <= D.CLIP_DAYS and a.min() >= -D.CLIP_DAYS
    assert (a[0, 0, :59] == 0).all()                          # nothing before any warmth


def test_shares_sum_to_one_and_clock_mix_starts_even():
    net = M.Atlas(5)
    p = torch.as_tensor(M.place_features([40.0, 45.0], [-90.0, -85.0], [600.0, 500.0]))
    z = net(p, torch.tensor([150.0, 200.0]), torch.tensor([5.0, -5.0]))
    assert torch.allclose(torch.softmax(z, -1).sum(-1), torch.ones(2))
    assert np.allclose(net.clock_weights(), 1 / 3)


def test_calendar_shares_and_scorer():
    rng = np.random.default_rng(0)
    df = pd.DataFrame({"lat": rng.uniform(37, 49, 2000), "doy": rng.integers(60, 300, 2000)})
    y = (df.doy.to_numpy() > 180).astype(int)  # species 0 early, species 1 late
    cal = Calendar(df, y, 2, alpha=1.0)
    assert np.allclose(cal.p.sum(-1), 1)
    per, total = score(cal, df, y, 2)
    assert total < 0 and (per < 0).all()
    flat = Calendar(df, y, 2, alpha=1e9)  # all smoothing: knows nothing about the season
    per_flat, total_flat = score(flat, df, y, 2)
    assert total > total_flat and (per > per_flat).all()


def test_atlas_learns_a_season():
    rng = np.random.default_rng(1)
    n = 4000
    df = pd.DataFrame({"lat": rng.uniform(37, 49, n), "lng": rng.uniform(-97, -81, n), "norm_dd": 600.0,
                       "doy": rng.integers(60, 300, n).astype(float), "delta": 0.0})
    y = (df.doy.to_numpy() > 180).astype(int)
    net = M.Atlas(2, hidden=32, depth=1)
    M.fit(net, M.place_features(df.lat, df.lng, df.norm_dd), df.doy.to_numpy(), df.delta.to_numpy(), y, 5,
          lr=1e-2, batch=256, log=lambda *a: None)
    _, total = score(AtlasModel(net), df, y, 2)
    assert total / n > -0.35  # a coin flip is -0.69


def test_browser_fixture_matches_the_shipped_weights():
    """scripts/atlas-net.fixture.json (what the page's network is checked against) is torch on public/atlas/model.bin."""
    import json
    import subprocess
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    out = subprocess.run([sys.executable, str(root / "pipeline/atlas/net_reference.py")], capture_output=True, text=True,
                         check=True, cwd=root).stdout
    now = json.loads(out)
    saved = json.loads((root / "scripts/atlas-net.fixture.json").read_text())
    for a, b in zip(now, saved):
        assert [i for i, _ in a["top"][:10]] == [i for i, _ in b["top"][:10]]
        assert np.allclose([v for _, v in a["top"]], [v for _, v in b["top"]], atol=1e-4)


def test_tree_holds_every_species_once_and_names_whole_groups():
    """public/atlas/tree.json (build_tree.py): each species one tip, and a named branch is exactly its group."""
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / "public" / "atlas"
    species = json.loads((root / "species.json").read_text())[:-1]  # the last row is "other"
    tree = json.loads((root / "tree.json").read_text())["t"]

    def tips(n):
        return [n] if isinstance(n, int) else [i for c in n[2:] for i in tips(c)]

    got = tips(tree)
    assert sorted(got) == list(range(len(species)))
    key = {"o": "order", "f": "family", "g": "genus"}

    def check(n):
        if isinstance(n, int):
            return
        label, rank = n[0], n[1]
        if rank:
            below = {species[i].get(key[rank]) for i in tips(n)} - {None}
            assert below == {label}, (label, below)
        for c in n[2:]:
            check(c)

    check(tree)


def test_warm_table_moves_spring_the_right_way():
    """warm.bin (warm.py): 3 °F cooler runs every cell behind its typical spring, 3 °F warmer ahead, by days not weeks."""
    import json
    from pathlib import Path
    out = Path(__file__).resolve().parents[2] / "public/atlas"
    n = len(json.loads((out / "cells.json").read_text()))
    w = np.fromfile(out / "warm.bin", np.int8).reshape(2, n, -1) / 4
    june = (152 - 60) // 4  # 1 June, every 4 days from 1 March
    assert (w[0, :, june] <= 0).all() and (w[1, :, june] >= 0).all()
    assert 3 < np.median(w[1, :, june]) < 15 and -15 < np.median(w[0, :, june]) < -3


def test_expected_vs_seen_reads_a_slide_and_a_surplus():
    from pipeline.atlas.seen import best_shift, judge
    days = np.arange(1, 366)
    # Two broods, the second bigger; seen this year 6 days early and twice as often.
    e = 40 * np.exp(-((days - 140) / 8) ** 2) + 80 * np.exp(-((days - 220) / 10) ** 2)
    o = np.round(2 * (40 * np.exp(-((days - 134) / 8) ** 2) + 80 * np.exp(-((days - 214) / 10) ** 2)))
    d, gain = best_shift(o, e)
    assert d == 6 and gain > 0
    assert judge(o, e, phi=1, phi_t=1) == (round(o.sum() / e.sum(), 2), 6)
    # The same season as expected, in the same numbers: nothing to say.
    assert judge(np.round(e), e, phi=1, phi_t=1) == (None, None)


def test_surprises_pick_the_biggest_gaps_with_enough_photos():
    from pipeline.atlas.seen import surprises
    rows = [[500, 100, 5.0, None], [50, 5, 10.0, None], [100, 400, 0.25, None], [900, 800, None, -9], [300, 280, None, None]]
    assert surprises(rows) == [0, 2, 3]  # 10x on 50 photos is too few to list
