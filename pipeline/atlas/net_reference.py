"""Reference outputs for the browser port (src/atlas/net.ts): a few (place, day, ahead) inputs and torch's
log-shares for each case's top 50 species, using the same float16 weights the browser loads.
  python3 pipeline/atlas/net_reference.py > scripts/atlas-net.fixture.json   # scripts/atlas-net-check.ts reads it
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import model as M  # noqa: E402

CASES = [(41.88, -87.63, 700.0, 160, 0.0), (44.5, -89.5, 520.0, 172, 6.5), (37.2, -93.3, 820.0, 135, -12.0),
         (48.9, -95.1, 430.0, 210, 30.0), (40.0, -83.0, 650.0, 250.5, 3.25)]


def main():
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
