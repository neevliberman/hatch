"""Shared constants for the Living Atlas. Frozen choices live in FROZEN_ATLAS.md; these mirror them."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "notebooks/data/atlas"  # git-ignored; the Parquet files go to a GitHub Release, not git history

BOX = {"s": 36.5, "n": 49.5, "w": -97.5, "e": -80.5}  # the Midwest box
FIRST_YEAR, LAST_YEAR = 2015, 2025
TEST_YEAR = 2025
HELD_OUT_STATES = ("Wisconsin", "Minnesota")  # the states luna's model lost; never seen in training
WARMTH_RES = 4  # H3 resolution of the warmth grid (~1,770 km² cells, ~45 km across)

# The app's files (export.py and the scripts after it). Here, not in export.py, so the torch-free weekly rebuild
# (weekly.py) and seen.py's tests can read them without importing torch.
OUT = ROOT / "public/atlas"
YEAR = 2026         # the year main's own files are for (ahead-, seen-YEAR); weekly.py builds later years
SEASON = (60, 304)  # 1 Mar to 31 Oct (365-day calendar): the ribbon's days
STEP = 4


def records_name(row):
    """The name a species.json row's records go by (GBIF's), which joins it to the records, per_species.csv and the
    Ohio tables: "gbif" when reconcile.py shows iNaturalist's name instead, else its name."""
    return row.get("gbif", row["name"])
