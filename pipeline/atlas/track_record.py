"""Each species' track record from run 2 (results/run2/per_species.csv), for its "How sure?" panel: species.json's "rec".

rec = [c, n_c, d, n_d]: test C (2026, the training states, a season no step had touched) and test D (Wisconsin and
Minnesota 2026, states it never saw), each against the species' own calendar (score.py's Calendar: its share by 2°
latitude strip and week, 2015-2025). c and d: 1 the network beat the calendar, 0 tied, -1 lost, None not tested.
n_c and n_d: that test's photos of the species (0 when not tested). A species with neither test has no "rec".

Tested as the frozen gate scores a species (run_gate.py): 400+ training records and 20+ test photos. Tied: the two
scores within TIE log-likelihood (a likelihood ratio under 20 to 1), too close to call either way. The scores are
per-species log-likelihoods over every test record (score.py), not days, so there is no days-off number per species.
  python3 pipeline/atlas/track_record.py    # rewrites public/atlas/species.json's "rec" in place; no network, no torch
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "pipeline/atlas/results/run2/per_species.csv"
SCORED_TRAIN, SCORED_TEST = 400, 20  # run_gate.py's
TIE = 3.0  # nats


def outcome(gain, n, n_train):
    if n_train < SCORED_TRAIN or n < SCORED_TEST or not math.isfinite(gain):
        return None
    return 0 if abs(gain) < TIE else 1 if gain > 0 else -1


def track_record(res: pd.DataFrame | None = None) -> dict:
    """Scientific name -> [c, n_c, d, n_d], for the species with at least one test."""
    res = pd.read_csv(RESULTS) if res is None else res
    out = {}
    for r in res.itertuples():
        if r.species == "(other)":
            continue
        c, d = outcome(r.gain_c, r.n_c, r.n_train), outcome(r.gain_d, r.n_d, r.n_train)
        if c is not None or d is not None:
            out[r.species] = [c, int(r.n_c) if c is not None else 0, d, int(r.n_d) if d is not None else 0]
    return out


def main():
    sys.path.insert(0, str(ROOT))
    from pipeline.atlas.config import OUT
    path = OUT / "species.json"
    rows = json.loads(path.read_text())
    rec = track_record()
    for row in rows[:-1]:
        row.pop("test", None)  # the old one-bit 2026 result; rec holds it and more
        row.pop("rec", None)
        if row["name"] in rec:
            row["rec"] = rec[row["name"]]
    path.write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False))
    k = [r.get("rec", [None] * 4) for r in rows[:-1]]
    for name, i in (("2026", 0), ("WI/MN", 2)):
        print(name, {v: sum(x[i] == v for x in k) for v in (1, 0, -1, None)})


if __name__ == "__main__":
    main()
