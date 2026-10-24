#!/usr/bin/env python3
"""Print the sha256 of every file PREREG_2027.md pins. `--check` compares them with the hashes written in that file.

    python3 pipeline/fit/prereg_hashes.py            # print "hash  path" lines
    python3 pipeline/fit/prereg_hashes.py --check    # exit 1 if any pinned file differs from PREREG_2027.md
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREREG = ROOT / "pipeline" / "fit" / "PREREG_2027.md"
FILES = [
    "pipeline/replay/fold_fits.json",              # P3 (p3_photo) fold fits: the map's model
    "pipeline/fit/results/loyo_params.json",       # P3 fold fits, run 2 (where the line above came from)
    "pipeline/fit/results/p3_1/loyo_params.json",  # P3.1 (p31_flat) fold fits
    "pipeline/fit/model.py",                       # the model definition both come from
    "pipeline/live/effort_profile.json",           # shared inputs of the nightly run
    "pipeline/live/prism_offsets.json",
]
CALENDAR = "calendar:luna-replay.json#scores"      # pseudo-file: the calendar baseline's numbers


def sha(path: str) -> str:
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def calendar_sha() -> str:
    """Hash of the calendar baseline's inputs only (each scored band-year's real onset and peak), so rebuilding the
    map's other data does not trip the check."""
    scores = json.loads((ROOT / "src" / "data" / "luna-replay.json").read_text())["scores"]
    rows = sorted((s["band"], s["year"], s["obs_onset"], s["obs_peak"]) for s in scores)
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def current() -> dict:
    return {**{f: sha(f) for f in FILES}, CALENDAR: calendar_sha()}


def pinned() -> dict:
    """Every `name` | `64-hex` pair in the prereg's table."""
    text = PREREG.read_text()
    return {m.group(1): m.group(2) for m in re.finditer(r"`([^`\s|]+)`[^|\n]*\|[^|\n]*`([0-9a-f]{64})`", text)}


def mismatches() -> list:
    cur, pin = current(), pinned()
    return [f"{k}: prereg {pin.get(k, 'MISSING')[:12]} vs file {v[:12]}" for k, v in cur.items() if pin.get(k) != v]


if __name__ == "__main__":
    if "--check" in sys.argv:
        bad = mismatches()
        print("\n".join(bad) or "all pinned files match PREREG_2027.md")
        sys.exit(1 if bad else 0)
    for k, v in current().items():
        print(f"{v}  {k}")
