"""The Atlas network: place + clock time -> every species' share of insect photos (FROZEN_ATLAS.md).

Analogy: one shared "eye" (the trunk) looks at a place and a moment in the season and writes a short description of
it (256 numbers). Each species then reads that description with its own pair of glasses (one row of the last layer)
to score how likely a photo here, now, is of it. A softmax turns all the scores into shares that sum to 1.

The warmth clock: the trunk is shown the same place at three clock times (calendar day; day + half of "days ahead";
day + all of it). Each species blends the three readings with its own learned weights, so a warmth-driven species
slides with an early spring and a calendar-driven one doesn't. Warmth never enters the trunk directly, so a spring
hotter than any in training only slides time further; it can't produce a shape the network never learned.
"""
import math

import numpy as np
import torch
from torch import nn

from pipeline.atlas.config import BOX
from pipeline.atlas.data import LAMBDAS

PLACE_FREQS = (1, 2, 4, 8)
TIME_HARMONICS = 8


def place_features(lat, lng, norm_dd):
    """[N, 19]: scaled lat/lng, their sines and cosines at four scales, and the place's typical warmth."""
    y = (np.asarray(lat) - (BOX["s"] + BOX["n"]) / 2) / ((BOX["n"] - BOX["s"]) / 2)
    x = (np.asarray(lng) - (BOX["w"] + BOX["e"]) / 2) / ((BOX["e"] - BOX["w"]) / 2)
    cols = [y, x, (np.asarray(norm_dd) - 600.0) / 200.0]
    for f in PLACE_FREQS:
        cols += [np.sin(math.pi * f * y / 2), np.cos(math.pi * f * y / 2),
                 np.sin(math.pi * f * x / 2), np.cos(math.pi * f * x / 2)]
    return np.stack(cols, 1).astype(np.float32)


def time_features(tau):
    """[..., 16]: sines and cosines of the day of year (365-day calendar) at 8 harmonics."""
    a = 2 * math.pi * tau[..., None] / 365.0
    k = torch.arange(1, TIME_HARMONICS + 1, device=tau.device, dtype=tau.dtype)
    return torch.cat([torch.sin(a * k), torch.cos(a * k)], -1)


class Block(nn.Module):
    def __init__(self, h, p):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(h, h), nn.SiLU(), nn.Dropout(p), nn.Linear(h, h))
        self.norm = nn.LayerNorm(h)

    def forward(self, x):
        return self.norm(x + self.net(x))


class Atlas(nn.Module):
    def __init__(self, n_out, hidden=256, depth=3, dropout=0.1, clocks=LAMBDAS):
        super().__init__()
        self.register_buffer("lambdas", torch.tensor(clocks, dtype=torch.float32))
        self.inp = nn.Sequential(nn.Linear(19 + 2 * TIME_HARMONICS, hidden), nn.SiLU())
        self.blocks = nn.Sequential(*[Block(hidden, dropout) for _ in range(depth)])
        self.head = nn.Linear(hidden, n_out)
        # each species' blend of the clocks; starts as an even mix
        self.clock_logits = nn.Parameter(torch.zeros(n_out, len(clocks)))

    def trunk(self, place, tau):
        return self.blocks(self.inp(torch.cat([place, time_features(tau)], -1)))

    def forward(self, place, doy, delta):
        """place [B, 19], doy [B], delta [B] -> logits [B, n_out]."""
        taus = doy[:, None] + self.lambdas[None, :] * delta[:, None]          # [B, M]
        B, M = taus.shape
        h = self.trunk(place.repeat_interleave(M, 0), taus.reshape(-1))        # [B*M, H]
        z = self.head(h).reshape(B, M, -1)                                       # [B, M, S]
        mix = torch.softmax(self.clock_logits, -1).T[None]                       # [1, M, S]
        return (z * mix).sum(1)

    def clock_weights(self):
        return torch.softmax(self.clock_logits, -1).detach().cpu().numpy()


def fit(model, place, doy, delta, y, epochs, lr=2e-3, batch=4096, weight_decay=1e-4, seed=0, log=print,
        on_epoch=None, stop_after=None):
    """Plain cross-entropy with AdamW and a one-cycle learning rate. Returns per-epoch mean loss.
    on_epoch(ep) runs after each pass (the tuning run scores 2024 there). stop_after ends early on the same
    learning-rate path, so the final fit repeats the tuning run's best pass exactly."""
    g = torch.Generator().manual_seed(seed)
    tensors = [torch.as_tensor(a) for a in (place, doy.astype(np.float32), delta.astype(np.float32), y)]
    n = len(y)
    # no weight decay on the clock blend: decay pulls it back to an even mix (FROZEN_ATLAS.md, amendment 1)
    clock = [p for n, p in model.named_parameters() if n == "clock_logits"]
    rest = [p for n, p in model.named_parameters() if n != "clock_logits"]
    opt = torch.optim.AdamW([{"params": rest}, {"params": clock, "weight_decay": 0.0}], lr=lr,
                            weight_decay=weight_decay)
    steps = epochs * math.ceil(n / batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.05)
    losses = []
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(n, generator=g)
        tot = 0.0
        for i in range(0, n, batch):
            j = perm[i:i + batch]
            p, d, dl, t = (a[j] for a in tensors)
            loss = nn.functional.cross_entropy(model(p, d, dl), t)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item() * len(j)
        losses.append(tot / n)
        log(f"  epoch {ep + 1}/{epochs}: loss {losses[-1]:.4f}")
        if on_epoch:
            on_epoch(ep + 1)
        if stop_after and ep + 1 >= stop_after:
            break
    return losses


@torch.no_grad()
def predict_log_probs(model, place, doy, delta, batch=8192):
    """Yields (slice, log_probs [b, n_out]) so callers can stream; the full matrix would be gigabytes."""
    model.eval()
    for i in range(0, len(doy), batch):
        sl = slice(i, i + batch)
        z = model(torch.as_tensor(place[sl]), torch.as_tensor(doy[sl], dtype=torch.float32),
                  torch.as_tensor(delta[sl], dtype=torch.float32))
        yield sl, torch.log_softmax(z, -1)
