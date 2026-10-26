"""Offline tests for the eastern shadow track (east.py, EAST_2027.md)."""
import datetime as dt
import json
import re
import sys
from pathlib import Path

import h3
import numpy as np
import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from league import east as E  # noqa: E402

CELL = "35-37/-82"
HEXES = sorted({h3.latlng_to_cell(36.0, -79.0, 4), h3.latlng_to_cell(36.3, -78.2, 4)})
DAYS = 240 - 59                                          # 1 Mar .. day 240


def static(tmp_path, per_day=10.0):
    """One place, two hexes, every past year a flat `per_day` degree-days; targets 600 / 900 DD."""
    s = {"version": 1, "model": "east-clock-v1", "years": list(range(2015, 2026)), "first_day_index": 59,
         "base_c": 10.0, "upper_c": 30.0,
         "places": {CELL: {"hexes": HEXES, "weights": [0.75, 0.25], "cutoff": 200, "seasons": [2020],
                           "records": 100, "target_dd": {"onset": 600.0, "peak": 900.0},
                           "calendar": {"onset": 150.0, "peak": 170.0},
                           "climate_dd": [[per_day] * DAYS for _ in range(11)]}},
         "offsets": {"hexes": HEXES, "offsets": [[[0.0, 0.0]] * 12 for _ in HEXES]}}
    p = tmp_path / "east_static.json"
    p.write_text(json.dumps(s))
    return p


def test_forecast_reaches_target_on_the_right_day(tmp_path):
    s = json.loads(static(tmp_path).read_text())
    seen = np.full(30, 20.0)                             # 30 observed days at 20 DD: 600 DD by the end of day 30
    out = E.forecast(s, {CELL: seen})[0]
    assert out["onset"] == pytest.approx(59 + 29 + 1, abs=0.01)     # reached exactly at the end of the 30th day
    assert out["peak"] == pytest.approx(59 + 59 + 1, abs=0.01)      # 300 more DD at 10 a day: 30 more days
    assert out["onset_lo"] == out["onset"] == out["onset_hi"]       # identical endings, no spread


def test_reach_interpolates_within_a_day():
    dd = np.cumsum(np.full(10, 10.0))                    # 10, 20, ..., 100
    assert E.reach(dd, 25.0) == pytest.approx(1.5)
    assert E.reach(dd, 5.0) == 0.0 and E.reach(dd, 1e6) == 9.0


def fake_obs(start, end):
    n = (end - start).days + 1

    def f(lat, lng):
        return np.full(n, 15.0), np.full(n, 25.0)        # mean 20 C: 10 DD a day above base 10
    return f


def fake_fc(la, ln):
    return np.full((len(la), 7), 15.0), np.full((len(la), 7), 25.0)


def test_nightly_writes_a_sealed_entry_and_skips_backfills(tmp_path):
    p = static(tmp_path)
    as_of = dt.date(2027, 5, 1)
    live = {"season": 2027, "as_of": as_of.isoformat()}
    start = dt.date(2027, 3, 1)
    out = E.nightly(tmp_path, live, dt.date(2027, 5, 3), p, fake_obs(start, as_of), fake_fc)
    e = json.loads(out.read_text())
    assert out.parent == tmp_path / "archive_east" / "2027" and e["issued"] == "2027-05-03"
    assert e["model"] == E.model_of(p) and e["forecast_through"] == "2027-05-08"
    assert e["bands"][0]["band"] == CELL and e["bands"][0]["onset"] < e["bands"][0]["peak"]
    assert E.nightly(tmp_path, {**live, "backfill": True}, dt.date(2027, 5, 3), p) is None
    assert E.nightly(tmp_path, {**live, "season": 2028}, dt.date(2028, 5, 3), p) is None


def test_first_nights_before_1_march_use_only_the_forecast(tmp_path):
    """build_live clamps as_of to 28 Feb on the first nights (2-3 March): no observed day, the forecast from 1 March."""
    p = static(tmp_path)
    live = {"season": 2027, "as_of": "2027-02-28"}
    out = E.nightly(tmp_path, live, dt.date(2027, 3, 2), p, lambda la, ln: pytest.fail("no PRISM day to read"), fake_fc)
    e = json.loads(out.read_text())
    assert e["forecast_through"] == "2027-03-07"
    # 7 forecast days at 10 DD, then the flat 10 DD/day endings: 600 DD on the 60th day
    assert e["bands"][0]["onset"] == pytest.approx(59 + 59 + 1, abs=0.01)


def test_place_weather_is_the_weighted_mean_of_its_hexes(tmp_path):
    s = json.loads(static(tmp_path).read_text())
    hot = s["offsets"]["hexes"].index(HEXES[0])                     # weight 0.75
    tmin, tmax = np.full((2, 3), 10.0), np.full((2, 3), 10.0)       # 0 DD everywhere ...
    tmin[hot], tmax[hot] = 20.0, 20.0                               # ... except 10 DD a day at the heavy hex
    assert E.place_inc(s, tmin, tmax)[CELL] == pytest.approx([7.5, 7.5, 7.5])


def test_a_short_forecast_fails_the_night(tmp_path):
    p = static(tmp_path)
    short = lambda la, ln: (np.full((len(la), 7), np.nan), np.full((len(la), 7), np.nan))   # noqa: E731
    start = dt.date(2027, 3, 1)
    with pytest.raises(RuntimeError, match="forecast days"):
        E.nightly(tmp_path, {"season": 2027, "as_of": "2027-05-01"}, dt.date(2027, 5, 3), p,
                  fake_obs(start, dt.date(2027, 5, 1)), short)


def test_the_weekly_table_stops_at_the_verdict_week(tmp_path):
    p = static(tmp_path)
    seal(tmp_path, p, 156.0, 165.0)
    out = E.weekly_run(tmp_path, 2027, dt.date(2027, 10, 6), lambda s, t: records(40, 150), static_path=p)
    t = json.loads(out.read_text())
    assert t["score_date"] == "2027-09-27" and t["verdict"] == "no_verdict"     # one place: under the floor


def records(n, doy0, season=2027):
    """n clean first-brood records at the place, one observer each, days doy0..doy0+n-1."""
    days = [dt.date(season, 1, 1) + dt.timedelta(days=doy0 - 1 + i) for i in range(n)]
    return pd.DataFrame({"id": range(n), "observed_on": [d.isoformat() for d in days],
                         "created_at": [d.isoformat() for d in days], "lat": 36.0, "lng": -79.0,
                         "accuracy_m": 10, "obscured": False, "geoprivacy": None, "quality_grade": "research",
                         "captive": False, "user_id": range(n), "life_stage": "adult"})


def entry(issued, onset, peak, p):
    return {"version": 1, "season": 2027, "issued": issued, "as_of": issued, "model": E.model_of(p),
            "bands": [{"band": CELL, "onset": onset, "peak": peak}]}


def seal(tmp_path, p, onset, peak):
    d = tmp_path / "archive_east" / "2027"
    d.mkdir(parents=True, exist_ok=True)
    for day in ("2027-05-01", "2027-06-01"):
        (d / f"{day}.json").write_text(json.dumps(entry(day, onset, peak, p)))


def test_grade_scores_a_settled_place_and_freezes_it(tmp_path):
    p = static(tmp_path)
    seal(tmp_path, p, onset=156.0, peak=165.0)
    raw = records(40, 150)                               # days 150..189: onset ~153.9, peak ~169.5
    t = E.grade(tmp_path, 2027, dt.date(2027, 8, 2), raw, p)
    r = t["places"][0]
    assert r["status"] == "scored" and r["n"] == 40
    assert r["miss"] == pytest.approx(3.3, abs=0.06) and r["calendar_miss"] == pytest.approx(2.2, abs=0.06)
    assert t["tally"]["places"] == 1 and t["verdict"] == "in_progress"
    late = pd.concat([raw, records(10, 150).assign(id=range(100, 110), user_id=range(100, 110))])
    t2 = E.grade(tmp_path, 2027, dt.date(2027, 8, 9), late, p)
    assert t2["places"][0] == r                         # frozen: late uploads never move a published score


def test_pending_until_settled(tmp_path):
    p = static(tmp_path)
    seal(tmp_path, p, 156.0, 165.0)
    t = E.grade(tmp_path, 2027, dt.date(2027, 7, 19), records(40, 150), p)   # cut-off 200 + 14 days = 2 Aug
    assert t["places"][0]["status"] == "pending"


def tally(places, records, d, wins):
    return {"places": places, "records": records, "D": d, "clock_wins": wins}


def test_decide_follows_the_written_rule():
    assert E.decide(tally(19, 1900, -2.0, 19), False)[0] == "in_progress"
    assert E.decide(tally(9, 1900, -2.0, 9), True)[0] == "no_verdict"
    assert E.decide(tally(19, 999, -2.0, 19), True)[0] == "no_verdict"
    assert E.decide(tally(18, 1900, -1.0, 9), True)[0] == "clock_wins"
    assert E.decide(tally(18, 1900, -1.0, 8), True)[0] == "calendar_stays"
    assert E.decide(tally(18, 1900, -0.99, 18), True)[0] == "calendar_stays"


def test_tally_reports_beside_the_verdict_number():
    rows = [{"status": "scored", "n": 100, "miss": 2.0, "calendar_miss": 5.0},
            {"status": "scored", "n": 10, "miss": 6.0, "calendar_miss": 4.0},
            {"status": "scored", "n": 10, "miss": 3.0, "calendar_miss": 3.0}, {"status": "pending", "n": 5}]
    t = E.tally(rows)
    assert t["places"] == 3 and t["records"] == 120 and t["clock_wins"] == 1 and t["ties"] == 1
    assert t["D"] == pytest.approx((100 * -3 + 10 * 2) / 120)
    assert t["D_unweighted"] == pytest.approx(-1 / 3, abs=0.01)
    lo, hi = t["D_interval_places"]
    assert lo <= t["D"] <= hi


def test_weekly_run_keeps_a_receipt_and_refuses_tampering(tmp_path):
    p = static(tmp_path)
    seal(tmp_path, p, 156.0, 165.0)
    out = E.weekly_run(tmp_path, 2027, dt.date(2027, 8, 3), lambda s, t: records(40, 150), static_path=p)
    assert json.loads(out.read_text())["score_date"] == "2027-08-02"
    assert E.weekly_run(tmp_path, 2027, dt.date(2027, 8, 4), lambda s, t: records(40, 150), static_path=p) is None
    rec = tmp_path / "records" / "2027" / "east" / "2027-08-02.parquet"
    assert rec.with_suffix(".sha256").exists()
    with pytest.raises(RuntimeError, match="under 90%"):
        E.weekly_run(tmp_path, 2027, dt.date(2027, 8, 10), lambda s, t: records(5, 150), static_path=p)
    records(3, 150).to_parquet(rec)
    with pytest.raises(RuntimeError, match="sha256"):
        E.weekly_run(tmp_path, 2027, dt.date(2027, 8, 4), None, force=True, static_path=p)
    assert E.weekly_run(tmp_path, 2028, dt.date(2028, 8, 10), None, static_path=p) is None


def test_rule_numbers_and_frozen_file_match_the_written_rule():
    text = (HERE / "EAST_2027.md").read_text()
    assert "**−1.0** day" in text and E.MARGIN == 1.0
    assert f"**{E.MIN_PLACES}** scored places" in text and f"**{E.MIN_RECORDS:,}** records" in text
    assert "27 September 2027" in text and E.VERDICT == dt.date(2027, 9, 27)
    m = re.search(r"`east_static.json` sha256 prefix: `([0-9a-f]{12})`", text)
    assert m and E.model_of()["hash"] == m.group(1)
    s = E.load_static()
    assert len(s["places"]) >= E.MIN_PLACES and all(len(p["climate_dd"]) == 11 for p in s["places"].values())
