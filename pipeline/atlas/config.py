"""Shared constants for the Living Atlas. Frozen choices live in FROZEN_ATLAS.md; these mirror them."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "notebooks/data/atlas"  # git-ignored; the Parquet files go to a GitHub Release, not git history

BOX = {"s": 36.5, "n": 49.5, "w": -97.5, "e": -80.5}  # the Midwest box
FIRST_YEAR, LAST_YEAR = 2015, 2025
TEST_YEAR = 2025
HELD_OUT_STATES = ("Wisconsin", "Minnesota")  # the states luna's model lost; never seen in training
WARMTH_RES = 4  # H3 resolution of the warmth grid (~1,770 km² cells, ~45 km across)
