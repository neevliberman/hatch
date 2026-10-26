"""Offline tests for the southern shadow track (south.py, SOUTH_2026.md)."""
import datetime as dt
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import south as S  # noqa: E402

CELL = "-34_150"
DAYS = 330


def static(tmp_path, per_day=10.0):
    """One cell, every past year a flat `per_day` degree-days; targets 600 / 900 DD."""
    s = {"version": 1, "model": "south-clock-v1", "years": list(range(2018, 2026)),
         "cells": {CELL: {"lat": -33.5, "lng": 151.0, "seasons": [2022, 2023, 2024], "records": 300,
                          "target_dd": {"onset": 600.0, "peak": 900.0},
                          "calendar": {"onset": 150.0, "peak": 170.0},
                          "climate_dd": [[per_day] * DAYS for _ in range(8)]}}}
    p = tmp_path / "south_static.json"
    p.write_text(json.dumps(s))
    return p


def test_cell_and_degree_days():
    assert list(S.cell_of([-33.9, -38.4], [151.2, 144.9])) == ["-34_150", "-40_144"]
    assert S.inc([2.0], [10.0]).tolist() == [0.0]                    # mean 6 C: exactly the base
    assert S.inc([10.0], [40.0]).tolist() == [20.0 - 6.0]            # cap at 30 C before averaging


def test_forecast_reaches_target_on_the_right_day(tmp_path):
    s = json.loads(static(tmp_path).read_text())
    out = S.forecast(s, {CELL: np.full(30, 20.0)})[0]                # 600 DD after 30 days; 900 after 30 more at 10
    assert 28 <= out["onset"] <= 30
    assert abs(out["peak"] - 59.0) <= 1.0
    assert out["onset_lo"] <= out["onset"] <= out["onset_hi"]


def test_nightly_seals_one_file_per_night(tmp_path):
    p = static(tmp_path)
    obs = lambda la, ln, a, b: (np.full((b - a).days + 1, 15.0), np.full((b - a).days + 1, 25.0))    # noqa: E731
    fc = lambda la, ln, a, b: (np.full(7, 15.0), np.full(7, 25.0))                                    # noqa: E731
    live = tmp_path / "live"
    path = S.nightly(live, 2026, dt.date(2026, 10, 27), p, obs, fc)
    e = json.loads(path.read_text())
    assert path.name == "2026-10-27.json" and e["as_of"] == "2026-10-24" and e["forecast_through"] == "2026-10-31"
    assert e["model"] == S.model_of(p) and e["bands"][0]["band"] == CELL
    assert S.nightly(live, 2025, dt.date(2026, 10, 27), p, obs, fc) is None          # not a season the file is frozen for
    assert S.nightly(live, 2026, dt.date(2026, 6, 30), p, obs, fc) is None


def entry(issued, model, onset, peak=170.0):
    return {"issued": issued, "model": model, "bands": [{"band": CELL, "onset": onset, "peak": peak}]}


def test_forecast_used_is_the_newest_one_issued_a_week_before():
    m = {"id": "x", "hash": "h"}
    es = [entry("2026-10-01", m, 140.0), entry("2026-11-01", m, 130.0), entry("2026-12-01", m, 120.0),
          entry("2026-12-02", {"id": "other", "hash": "h"}, 1.0)]
    day = (dt.date(2026, 11, 8) - dt.date(2026, 7, 1)).days            # a real date exactly 7 days after the 1 Nov file
    assert S.newest_before(es, m, CELL, "onset", day, 2026) == ("2026-11-01", 130.0)
    assert S.newest_before(es, m, CELL, "onset", day - 1, 2026) == ("2026-10-01", 140.0)
    assert S.newest_before(es, m, CELL, "onset", 50, 2026) is None


def recs(n, onset_day, spread=20):
    doy = np.linspace(onset_day, onset_day + spread, n).astype(int)
    return pd.DataFrame({"cell": CELL, "doy": doy})


def test_score_cell_needs_records_and_a_forecast():
    m = {"id": "x", "hash": "h"}
    p = {"calendar": {"onset": 150.0, "peak": 165.0}}
    es = [entry("2026-09-01", m, 140.0, 160.0)]
    assert S.score_cell(CELL, recs(10, 130), p, 2026, es, m)["status"] == "too_few"
    assert S.score_cell(CELL, recs(40, 130), p, 2026, [], m)["status"] == "no_forecast_in_time"
    r = S.score_cell(CELL, recs(40, 130), p, 2026, es, m)
    assert r["status"] == "scored" and r["n"] == 40
    assert r["miss"] == round((abs(140 - r["onset"]) + abs(160 - r["peak"])) / 2, 1)


def test_rule():
    ok = {"cells": 10, "records": 1500, "D": -1.2, "clock_wins": 6}
    assert S.decide(ok, False)[0] == "in_progress"
    assert S.decide(ok, True)[0] == "clock_wins"
    assert S.decide({**ok, "D": -0.9}, True)[0] == "calendar_stays"
    assert S.decide({**ok, "clock_wins": 4}, True)[0] == "calendar_stays"
    assert S.decide({**ok, "cells": 7}, True)[0] == "no_verdict"
    assert S.decide({**ok, "records": 700}, True)[0] == "no_verdict"


def test_tally_weights_by_records():
    rows = [{"status": "scored", "n": 300, "miss": 4.0, "calendar_miss": 8.0},
            {"status": "scored", "n": 100, "miss": 10.0, "calendar_miss": 8.0},
            {"status": "too_few", "n": 3}]
    t = S.tally(rows)
    assert t["cells"] == 2 and t["records"] == 400 and t["clock"] == 5.5 and t["calendar"] == 8.0
    assert t["clock_wins"] == 1 and t["D"] == -2.5


def test_doc_matches_frozen_file_and_rule():
    doc = (HERE / "SOUTH_2026.md").read_text()
    assert S.sha256(S.STATIC)[:12] in doc
    assert (S.MARGIN, S.MIN_CELLS, S.MIN_RECORDS, S.SETTLE) == (1.0, 8, 800, dt.date(2027, 2, 15))
    assert "−1.0** day" in doc and "**8** scored cells" in doc and "**800**" in doc and "15 February 2027" in doc
    assert re.search(r"base 6", doc)
