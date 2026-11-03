"""The Atlas network in plain numpy, from the files the browser loads (public/atlas/model.bin + model.json), and the
reference outputs for the browser port (src/atlas/net.ts).

NumpyAtlas runs the exported float16 weights on the CPU with no torch: model.py's forward pass, layer for layer
(LayerNorm eps 1e-5, SiLU, the three clocks blended per species). The weekly rebuild (weekly.py) uses it, so the
Actions job installs no torch. test_weekly.py holds it to torch's numbers (scripts/atlas-net.fixture.json).

  python3 pipeline/atlas/net_reference.py > scripts/atlas-net.fixture.json   # torch; scripts/atlas-net-check.ts reads it
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

CASES = [(41.88, -87.63, 700.0, 160, 0.0), (44.5, -89.5, 520.0, 172, 6.5), (37.2, -93.3, 820.0, 135, -12.0),
         (48.9, -95.1, 430.0, 210, 30.0), (40.0, -83.0, 650.0, 250.5, 3.25)]
FIXTURE = ROOT / "scripts/atlas-net.fixture.json"


def silu(x):
    return x / (1.0 + np.exp(-x))


def layer_norm(x, w, b, eps=1e-5):
    m = x.mean(-1, keepdims=True)
    v = ((x - m) ** 2).mean(-1, keepdims=True)
    return (x - m) / np.sqrt(v + eps) * w + b


class NumpyAtlas:
    """The exported network (model.json / model.bin), float32 on the CPU."""

    def __init__(self, folder=ROOT / "public/atlas"):
        folder = Path(folder)
        self.meta = json.loads((folder / "model.json").read_text())
        flat = np.fromfile(folder / "model.bin", dtype="<f2").astype(np.float32)
        self.t = {t["name"]: flat[t["offset"]:t["offset"] + int(np.prod(t["shape"]))].reshape(t["shape"])
                  for t in self.meta["tensors"]}
        self.n_out = self.meta["n_out"]
        self.lambdas = np.asarray(self.meta["lambdas"], np.float32)
        z = self.t["clock_logits"]
        e = np.exp(z - z.max(1, keepdims=True))
        self.mix = (e / e.sum(1, keepdims=True)).T.astype(np.float32)         # [clocks, n_out]
        self.head_w = np.ascontiguousarray(self.t["head.weight"].T)            # [hidden, n_out]

    def place_features(self, lat, lng, norm_dd):
        """[N, 19], as model.place_features."""
        box, nd = self.meta["box"], self.meta["norm_dd"]
        y = (np.asarray(lat, np.float64) - (box["s"] + box["n"]) / 2) / ((box["n"] - box["s"]) / 2)
        x = (np.asarray(lng, np.float64) - (box["w"] + box["e"]) / 2) / ((box["e"] - box["w"]) / 2)
        cols = [y, x, (np.asarray(norm_dd, np.float64) - nd["center"]) / nd["scale"]]
        for f in self.meta["place_freqs"]:
            cols += [np.sin(math.pi * f * y / 2), np.cos(math.pi * f * y / 2),
                     np.sin(math.pi * f * x / 2), np.cos(math.pi * f * x / 2)]
        return np.stack(cols, 1).astype(np.float32)

    def _trunk(self, place, tau):
        k = np.arange(1, self.meta["time_harmonics"] + 1, dtype=np.float32)
        a = (2 * math.pi * tau[:, None] / 365.0).astype(np.float32) * k
        h = np.concatenate([place, np.sin(a), np.cos(a)], 1)
        h = silu(h @ self.t["inp.0.weight"].T + self.t["inp.0.bias"])
        for d in range(self.meta["depth"]):
            p = f"blocks.{d}."
            r = silu(h @ self.t[p + "net.0.weight"].T + self.t[p + "net.0.bias"])
            r = r @ self.t[p + "net.3.weight"].T + self.t[p + "net.3.bias"]
            h = layer_norm(h + r, self.t[p + "norm.weight"], self.t[p + "norm.bias"])
        return h

    def logits(self, place, doy, delta):
        """place [B, 19], doy [B], delta [B] -> [B, n_out] (model.Atlas.forward)."""
        doy = np.asarray(doy, np.float32)
        delta = np.asarray(delta, np.float32)
        out = np.zeros((len(doy), self.n_out), np.float32)
        for m, lam in enumerate(self.lambdas):
            z = self._trunk(place, doy + lam * delta) @ self.head_w + self.t["head.bias"]
            out += z * self.mix[m]
        return out

    def shares(self, place, doy, delta):
        """Softmax of logits: every species' share of insect photos, rows summing to 1."""
        z = self.logits(place, doy, delta)
        z -= z.max(1, keepdims=True)
        np.exp(z, out=z)
        z /= z.sum(1, keepdims=True)
        return z

    def log_shares(self, place, doy, delta):
        z = self.logits(place, doy, delta).astype(np.float64)
        z -= z.max(1, keepdims=True)
        return z - np.log(np.exp(z).sum(1, keepdims=True))


def main():
    import torch

    from pipeline.atlas import model as M
    meta = json.loads((ROOT / "public/atlas/model.json").read_text())
    flat = np.fromfile(ROOT / "public/atlas/model.bin", dtype=np.float16).astype(np.float32)
    net = M.Atlas(meta["n_out"])
    state = {t["name"]: torch.from_numpy(flat[t["offset"]:t["offset"] + int(np.prod(t["shape"]))].reshape(t["shape"]))
             for t in meta["tensors"]}
    net.load_state_dict(state)
    net.eval()
    lat, lng, dd, day, ahead = (np.array(c, dtype=np.float32) for c in zip(*CASES))
    with torch.no_grad():
        lp = torch.log_softmax(net(torch.from_numpy(M.place_features(lat, lng, dd)), torch.from_numpy(day),
                                   torch.from_numpy(ahead)), -1).numpy()
    print(json.dumps([{"lat": float(a), "lng": float(b), "dd": float(c), "day": float(d), "ahead": float(e),
                       "top": [[int(i), round(float(row[i]), 5)] for i in np.argsort(-row)[:50]]} for a, b, c, d, e, row in zip(lat, lng, dd, day, ahead, lp)]))


if __name__ == "__main__":
    main()
