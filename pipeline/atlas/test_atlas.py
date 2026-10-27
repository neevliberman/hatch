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
