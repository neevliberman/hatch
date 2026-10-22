"""P3 "the fit": luna moth first-brood emergence from degree-days (see README.md).

Run from the repo root:  python3 -m fit.run_p3  (with pipeline/ on PYTHONPATH), or
python3 pipeline/fit/run_p3.py.  Tests: python3 -m pytest pipeline/fit
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for _p in (ROOT / "notebooks", ROOT / "pipeline"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

HERE = Path(__file__).resolve().parent
DATA = ROOT / "notebooks" / "data"
