"""First neural maps: a species' predicted share of insect photos across the box, on a few days of 2025.
Writes pipeline/atlas/figures/<species>.png. Run after run_gate.py:
  python3 pipeline/atlas/figures.py "Actias luna" "Danaus plexippus" "Popillia japonica"
"""
import sys
from pathlib import Path

import h3
import matplotlib
import numpy as np
import pandas as pd
import torch

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas import model as M  # noqa: E402
from pipeline.atlas.config import BOX, DATA, FIRST_YEAR, TEST_YEAR, WARMTH_RES  # noqa: E402

OUT = ROOT / "pipeline/atlas/figures"
DAYS = {"15 May": 135, "15 Jun": 166, "15 Jul": 196, "15 Aug": 227}


def grid(w, ahead, year, doy):
    cells = [c for c in w.cells if BOX["s"] <= h3.cell_to_latlng(c)[0] <= BOX["n"]
             and BOX["w"] <= h3.cell_to_latlng(c)[1] <= BOX["e"]]
    ll = np.array([h3.cell_to_latlng(c) for c in cells])
    ci = np.array([w.index[c] for c in cells])
    df = pd.DataFrame({"lat": ll[:, 0], "lng": ll[:, 1], "norm_dd": w.typical_july()[ci], "doy": float(doy),
                       "delta": ahead[ci, year - w.years[0], doy - 1]})
    return cells, df


def main(names):
    ck = torch.load(DATA / "model/atlas.pt")
    sp = ck["species"]
    net = M.Atlas(len(sp) + 1)
    net.load_state_dict(ck["state"])
    net.eval()
    w = D.Warmth.load(np.arange(FIRST_YEAR, TEST_YEAR))
    ahead = w.days_ahead()
    OUT.mkdir(exist_ok=True)
    for name in names:
        si = sp.index(name)
        fig, axes = plt.subplots(1, len(DAYS), figsize=(4 * len(DAYS), 3.6), constrained_layout=True)
        shares = []
        for label, doy in DAYS.items():
            cells, df = grid(w, ahead, TEST_YEAR, doy)
            with torch.no_grad():
                z = net(torch.as_tensor(M.place_features(df.lat, df.lng, df.norm_dd)),
                        torch.as_tensor(df.doy.to_numpy(), dtype=torch.float32),
                        torch.as_tensor(df.delta.to_numpy(), dtype=torch.float32))
            shares.append((label, df, torch.softmax(z, -1)[:, si].numpy() * 100))
        vmax = max(s.max() for *_, s in shares)
        for ax, (label, df, s) in zip(axes, shares):
            sc = ax.scatter(df.lng, df.lat, c=s, s=9, marker="h", cmap="YlGn", vmin=0, vmax=vmax)
            ax.set_title(f"{label} {TEST_YEAR}", fontsize=11)
            ax.set_xlim(BOX["w"], BOX["e"])
            ax.set_ylim(BOX["s"], BOX["n"])
            ax.set_xticks([])
            ax.set_yticks([])
            ax.set_aspect(1.3)
        fig.colorbar(sc, ax=axes, shrink=0.8, label="% of insect photos")
        fig.suptitle(f"{name}: the Atlas's expected share (a year it never saw)", fontsize=12)
        fig.savefig(OUT / f"{name.replace(' ', '_')}.png", dpi=110)
        plt.close(fig)
        print("wrote", name)


if __name__ == "__main__":
    main(sys.argv[1:] or ["Actias luna"])
