"""P4: the model search (FROZEN_P4.md). Can more data or a richer model beat P3?

Run from the repo root: python3 pipeline/p4/run_p4.py. Tests: python3 -m pytest pipeline/p4
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for _p in (ROOT / "notebooks", ROOT / "pipeline"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

HERE = Path(__file__).resolve().parent
DATA = ROOT / "notebooks" / "data"
WIDE = DATA / "wide"
