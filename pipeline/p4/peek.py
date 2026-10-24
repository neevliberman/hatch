"""Score whatever folds are cached so far: python3 pipeline/p4/peek.py"""
import pickle, sys
from collections import defaultdict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from p4 import run_p4 as R
by = defaultdict(list)
for f in sorted(R.CACHE.glob("*.pkl")):
    d = pickle.loads(f.read_bytes()); by[d["cand"]].append(d)
for c, ds in sorted(by.items()):
    if not any(d["rows"] for d in ds):
        print(c, len(ds), "folds, no rows yet"); continue
    keys = sorted({str(d["dd_key"]) for d in ds})
    print(f"{c:7s} folds={len(ds):2d} {R.score([r for d in ds for r in d['rows']])} dd={keys}")
