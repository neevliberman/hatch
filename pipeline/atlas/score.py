"""The interfaces, the calendar baseline and the one scorer every species gets (FROZEN_ATLAS.md).

Three small interfaces, no class trees:
- Source: where records and warmth come from (fetch_gbif.py, build_warmth.py write the Parquet / npz files).
- Model: anything that gives, for a table of records, each species' log-share. The Atlas and the calendar both do.
- Scorer: `score()` below. One fixed test for every species and every model.
"""
from typing import Iterator, Protocol

import numpy as np
import pandas as pd
import torch

from pipeline.atlas import model as M
from pipeline.atlas.config import BOX


class Model(Protocol):
    def log_probs(self, df: pd.DataFrame) -> Iterator[tuple[slice, torch.Tensor]]:
        """Yields (rows, log-shares [rows, n_out]) in order; last column is "other"."""


STRIP = 2.0
WEEKS = 52


def strip_week(df):
    b = np.clip(((df.lat.to_numpy() - BOX["s"]) // STRIP).astype(int), 0, int((BOX["n"] - BOX["s"]) // STRIP))
    w = np.minimum((df.doy.to_numpy() - 1) // 7, WEEKS - 1)
    return b, w


class Calendar:
    """Each species' share by 2° latitude strip and week, smoothed toward its share in that strip all year."""

    def __init__(self, train, y, n_out, alpha=10.0, blend_weeks=False):
        b, w = strip_week(train)
        nb = int(b.max()) + 1 if len(b) else 1
        self.nb = max(nb, int((BOX["n"] - BOX["s"]) // STRIP) + 1)
        n = np.zeros((self.nb, WEEKS, n_out))
        np.add.at(n, (b, w, y), 1.0)
        if blend_weeks:
            n = 0.5 * n + 0.25 * np.roll(n, 1, 1) + 0.25 * np.roll(n, -1, 1)
        glob = (n.sum((0, 1)) + 0.5) / (n.sum() + 0.5 * n_out)
        strip = (n.sum(1) + glob[None] * 1.0) / (n.sum((1, 2))[:, None] + 1.0)  # [nb, S]
        self.p = (n + alpha * strip[:, None, :]) / (n.sum(2, keepdims=True) + alpha)
        self.logp = torch.as_tensor(np.log(self.p), dtype=torch.float32)

    def log_probs(self, df, batch=8192):
        b, w = strip_week(df)
        for i in range(0, len(df), batch):
            sl = slice(i, i + batch)
            yield sl, self.logp[b[sl], w[sl]]


class AtlasModel:
    def __init__(self, net):
        self.net = net

    def log_probs(self, df, batch=8192):
        place = M.place_features(df.lat, df.lng, df.norm_dd)
        return M.predict_log_probs(self.net, place, df.doy.to_numpy(), df.delta.to_numpy(), batch)


def score(model: Model, df, y, n_out):
    """Per species: log-likelihood of "is this record that species, yes or no?" over every record.
    Also the full multi-class log-likelihood. Returns (per_species [n_out], total)."""
    per = torch.zeros(n_out, dtype=torch.float64)
    total = 0.0
    yt = torch.as_tensor(y)
    for sl, lp in model.log_probs(df):
        lp = lp.double().clamp(max=-1e-12)
        l1m = torch.log(-torch.expm1(lp))  # log(1 - p)
        onehot = torch.nn.functional.one_hot(yt[sl], n_out).bool()
        per += torch.where(onehot, lp, l1m).sum(0)
        total += lp.gather(1, yt[sl][:, None]).sum().item()
    return per.numpy(), total
