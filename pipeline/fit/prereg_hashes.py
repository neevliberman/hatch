#!/usr/bin/env python3
"""Print the sha256 of every file PREREG_2027.md pins; `--check` compares them with that file.

    python3 pipeline/fit/prereg_hashes.py            # print "hash  path" lines
    python3 pipeline/fit/prereg_hashes.py --check    # exit 1 if a pinned file differs from PREREG_2027.md

The table in PREREG_2027.md (above its "## Amendments" heading) holds the hashes at registration. A later change is
allowed only as an amendment line:
    - 2027-03-02 | <path> | <new sha256> | reason=<code> | scored=<strips already scored, or none> | <why>
A change dated on or after 2027-03-01 may use only the reason codes in LATE_REASONS (see the prereg).
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREREG = ROOT / "pipeline" / "fit" / "PREREG_2027.md"
FILES = [
    "pipeline/live/scorecard.py",                  # the scorer (merged in 49bfe36)
    "pipeline/live/build_live.py",                 # nightly forecast: PRISM_LAG_DAYS, band weights, model hash
    "notebooks/hatch_p1/prep.py",                  # the record filters (`clean`)
    "pipeline/replay/build_replay.py",             # how the fold fits are written
    "pipeline/replay/fold_fits.json",              # P3 (p3_photo) live fits, id p3-v1
    "pipeline/replay/fold_fits_p31.json",          # P3.1 (p31_flat) live fits, id p3.1-v1
    "pipeline/fit/results/loyo_params.json",       # P3 fold fits, run 2
    "pipeline/fit/results/p3_1/loyo_params.json",  # P3.1 fold fits
    "pipeline/fit/model.py",                       # model definition
    "pipeline/live/effort_profile.json",           # shared nightly inputs
    "pipeline/live/prism_offsets.json",
    "pipeline/live/records/luna_2026_rg.parquet",  # the 2026 records for the Daymet re-check
    "pipeline/league/rules.py",                    # the decision rule as code (pipeline/league)
    "pipeline/league/weekly.py",                   # the weekly head-to-head
    "pipeline/league/gates.json",                  # the 2026 gate's number
]
REPLAY = "replay:luna-replay.json#scores+cutoffs+sightings"   # pseudo-file, see replay_sha
LATE_REASONS = {"bug-both-models", "feed-outage"}
EARLY_REASONS = {"pre-season"}
CUTOFF_DATE = "2027-03-01"


def sha(path: str) -> str:
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def replay_sha() -> str:
    """Hash of what the calendar baseline, the first-wave cut-offs (which set settle dates) and the band weights
    read from src/data/luna-replay.json: scored band-years' real onset/peak, each band's cutoff, and the sightings."""
    r = json.loads((ROOT / "src" / "data" / "luna-replay.json").read_text())
    body = {"scores": sorted((s["band"], s["year"], s["obs_onset"], s["obs_peak"]) for s in r["scores"]),
            "bands": [(b["label"], b["lo"], b["hi"], b["cutoff"]) for b in r["bands"]],
            "sightings": r["sightings"]}
    return hashlib.sha256(json.dumps(body, separators=(",", ":")).encode()).hexdigest()


def current() -> dict:
    out = {}
    for f in FILES:
        try:
            out[f] = sha(f)
        except FileNotFoundError:
            out[f] = "FILE-MISSING"
    out[REPLAY] = replay_sha()
    return out


def _split():
    text = PREREG.read_text()
    head, _, tail = text.partition("\n## Amendments")
    return head, tail


def table_pins() -> dict:
    """`name` | `64-hex` pairs in the registration table (everything above the Amendments heading)."""
    return {m.group(1): m.group(2) for m in re.finditer(r"`([^`\s|]+)`[^|\n]*\|[^|\n]*`([0-9a-f]{64})`", _split()[0])}


def amendments() -> list:
    """Parsed amendment lines (dict per line); a malformed line is returned with an 'error'."""
    out = []
    for ln in _split()[1].splitlines():
        if not re.match(r"- 20\d\d-\d\d-\d\d", ln):
            continue
        parts = [p.strip() for p in ln[2:].split("|")]
        a = {"line": ln}
        try:
            a["date"], a["path"], a["hash"] = parts[0], parts[1].strip("`"), parts[2].strip("`")
            a["reason"] = re.fullmatch(r"reason=([\w-]+)", parts[3]).group(1)
            a["scored"] = re.fullmatch(r"scored=(.+)", parts[4]).group(1)
            a["why"] = parts[5]
            assert re.fullmatch(r"[0-9a-f]{64}", a["hash"]) and len(a["why"]) >= 10
        except (IndexError, AttributeError, AssertionError):
            a["error"] = "malformed amendment (need: date | path | sha256 | reason= | scored= | why)"
        out.append(a)
    return out


def pinned() -> dict:
    """Effective pins: the table, then amendments in order."""
    p = dict(table_pins())
    for a in amendments():
        if "error" not in a:
            p[a["path"]] = a["hash"]
    return p


def amendment_problems() -> list:
    bad = []
    for a in amendments():
        if "error" in a:
            bad.append(f"{a['error']}: {a['line'][:80]}")
            continue
        late = a["date"] >= CUTOFF_DATE
        if a["path"] not in current():
            bad.append(f"amendment for an unpinned file: {a['path']}")
        if a["reason"] not in (LATE_REASONS if late else EARLY_REASONS | LATE_REASONS):
            bad.append(f"reason '{a['reason']}' not allowed on {a['date']}")
    return bad


def mismatches() -> list:
    cur, pin = current(), pinned()
    bad = [f"table row not in prereg_hashes.FILES: {k}" for k in table_pins() if k not in cur]
    for k, v in cur.items():
        if v == "FILE-MISSING":
            bad.append(f"{k}: file is missing")
        elif k not in pin:
            bad.append(f"{k}: not in PREREG_2027.md")
        elif pin[k] != v:
            bad.append(f"{k}: prereg {pin[k][:12]} vs file {v[:12]} (amend PREREG_2027.md or revert the file)")
    return bad + amendment_problems()


if __name__ == "__main__":
    if "--check" in sys.argv:
        bad = mismatches()
        print("\n".join(bad) or "all pinned files match PREREG_2027.md")
        sys.exit(1 if bad else 0)
    for k, v in current().items():
        print(f"{v}  {k}")
