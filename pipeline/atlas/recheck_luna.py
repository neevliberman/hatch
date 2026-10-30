"""Amendment 2: re-run the luna check with the two code bugs fixed, on the saved run 1 and run 2 models.
(1) Count every state's insect records, WI/MN included, as P3's band targets do. (2) Interpolate the quantile day.
Writes pipeline/atlas/results/luna_amended.json. No retraining (~5 min):
  python3 pipeline/atlas/recheck_luna.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas import model as M  # noqa: E402
from pipeline.atlas import run_gate as G  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR, TEST_YEAR  # noqa: E402
from pipeline.atlas.score import AtlasModel  # noqa: E402


def main():
    df = D.load_records(last_year=TEST_YEAR + 1)
    out = {}
    for run2 in (False, True):
        year = TEST_YEAR + 1 if run2 else TEST_YEAR
        d = G.prepare(df, np.arange(FIRST_YEAR, year))
        if run2:
            d = d[(d.year < year) | (d.doy <= int(np.load(DATA / "warmth.npz")["last_day_2026"]))]
        ck = torch.load(DATA / "model" / ("run2" if run2 else "") / "atlas.pt")
        sp = ck["species"]
        net = M.Atlas(len(sp) + 1)
        net.load_state_dict(ck["state"])
        rows = G.luna_rows_2026() if run2 else G.luna_rows_2025()
        res = G.luna_check(d[d.year == year], sp, AtlasModel(net), rows, beat_calendar=run2)
        out["run2" if run2 else "run1"] = res
        print("run2" if run2 else "run1", f"atlas {res['atlas']:.2f} p3 {res['p3']:.2f} cal {res['calendar']:.2f}",
              "pass" if res["pass"] else "FAIL")
    (ROOT / "pipeline/atlas/results/luna_amended.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
