"""Offline tests for the live scorecard: settle / pending rules, which forecast gets graded, strip scoring.
python3 -m pytest pipeline/live"""
import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live import build_live as L, scorecard as S  # noqa: E402

SEASON = 2027
MODEL = {"id": "p3-v1", "hash": "abc"}
CAL = {"37-39": (100.0, 120.0)}


def entry(issued, onset, peak, model=MODEL, band="37-39"):
    return {"season": SEASON, "issued": issued, "as_of": issued, "model": model,
            "bands": [{"band": band, "onset": onset, "onset_lo": onset - 5, "onset_hi": onset + 5,
                       "peak": peak, "peak_lo": peak - 5, "peak_hi": peak + 5}]}


def recs(days, posted=None):
    """Cleaned-record frame as first_wave returns it, for strip 37-39."""
    return pd.DataFrame({"band": "37-39", "doy": days, "date": [pd.Timestamp(S.doy_date(SEASON, d)) for d in days]})


def raw(n, doy, **kw):
    """Raw iNat rows (as fetch_records returns) at 38 N, one observer each."""
    base = {"observed_on": S.doy_date(SEASON, doy).isoformat(), "created_at": S.doy_date(SEASON, doy).isoformat() + "T20:00:00-05:00",
            "lat": 38.0, "lng": -89.0, "accuracy_m": 10.0, "obscured": False, "geoprivacy": None,
            "quality_grade": "research", "captive": False, "life_stage": "adult"}
    base.update(kw)
    return pd.DataFrame([{**base, "id": i, "user_id": i} for i in range(n)])


def test_week_start_is_monday():
    assert S.week_start(dt.date(2027, 7, 14)) == dt.date(2027, 7, 12)   # a Wednesday -> that Monday
    assert S.week_start(dt.date(2027, 7, 12)) == dt.date(2027, 7, 12)


def test_band_is_pending_until_window_closed_and_settled():
    cut = 177                                     # 26 June 2027
    r = recs(list(range(110, 140)))
    settle = S.settles_on(SEASON, cut)
    assert settle == dt.date(2027, 6, 26) + dt.timedelta(days=14)
    es = [entry("2027-04-01", 105, 125)]
    early = S.score_band("37-39", r, SEASON, cut, settle - dt.timedelta(days=1), es, MODEL, CAL)
    assert early["status"] == "pending" and "miss" not in early   # never scored early, even with plenty of records
    on = S.score_band("37-39", r, SEASON, cut, settle, es, MODEL, CAL)
    assert on["status"] == "scored"


def test_young_records_count_as_pending():
    r = recs([100, 150, 170, 175])
    row = S.score_band("37-39", r, SEASON, 177, S.doy_date(SEASON, 180), [], MODEL, CAL)
    assert row["status"] == "pending" and row["pending_records"] == 2   # 170 and 175 are under 14 days old on day 180


def test_too_few_records_is_not_scored():
    row = S.score_band("37-39", recs(list(range(110, 129))), SEASON, 177, dt.date(2027, 8, 1), [entry("2027-04-01", 1, 2)], MODEL, CAL)
    assert row["status"] == "too_few" and row["n"] == 19


def test_scores_onset_and_peak_against_calendar():
    days = list(range(110, 150))                  # 40 records: onset (10%) 113.9, peak (50%) 129.5
    # onset 23 Apr -> graded on a forecast issued by 16 Apr; peak 9 May -> by 2 May; the last is too late for both
    es = [entry("2027-03-20", 112, 999), entry("2027-04-20", 999, 128), entry("2027-05-05", 200, 200)]
    row = S.score_band("37-39", recs(days), SEASON, 177, dt.date(2027, 8, 2), es, MODEL, CAL)
    assert row["status"] == "scored"
    assert row["onset"]["real"] == round(float(np.quantile(days, 0.1)), 1)
    assert row["onset"]["forecast"] == 112 and row["peak"]["forecast"] == 128
    assert row["onset"]["issued"] == "2027-03-20" and row["peak"]["issued"] == "2027-04-20"
    assert row["onset"]["error"] == round(112 - np.quantile(days, 0.1), 1)
    assert row["miss"] == round((abs(112 - np.quantile(days, 0.1)) + abs(128 - np.quantile(days, 0.5))) / 2, 1)
    assert row["calendar_miss"] == round((abs(100 - np.quantile(days, 0.1)) + abs(120 - np.quantile(days, 0.5))) / 2, 1)
    assert row["peak"]["inside"] and row["note"] == "on time"


def test_only_forecasts_issued_a_week_before_the_outcome_are_graded():
    real_onset = dt.date(2027, 4, 24)
    es = [entry("2027-04-10", 1, 1), entry("2027-04-17", 2, 2), entry("2027-04-18", 3, 3)]
    got = S.pick_forecast(es, MODEL, real_onset - dt.timedelta(days=S.LEAD_DAYS))
    assert got["issued"] == "2027-04-17"
    assert S.pick_forecast(es, MODEL, dt.date(2027, 4, 1)) is None
    # a forecast from another model is never graded, even if it is the newest
    es.insert(2, entry("2027-04-17", 9, 9, model={"id": "p3-v2", "hash": "zzz"}))
    assert S.pick_forecast(es, MODEL, dt.date(2027, 4, 17))["bands"][0]["onset"] == 2


def test_no_forecast_early_enough():
    days = list(range(110, 150))
    row = S.score_band("37-39", recs(days), SEASON, 177, dt.date(2027, 8, 2), [entry("2027-04-30", 112, 128)], MODEL, CAL)
    assert row["status"] == "no_forecast"


def test_frozen_model_is_the_seasons_first():
    es = [entry("2027-03-02", 1, 1), entry("2027-03-03", 1, 1, model={"id": "x", "hash": "y"})]
    assert S.frozen_model(es) == MODEL and S.frozen_model([]) is None


def test_first_wave_filters():
    score = dt.date(2027, 8, 2)
    df = pd.concat([
        raw(3, 120),                                           # kept
        raw(1, 121, quality_grade="needs_id"),                  # not research grade
        raw(1, 122, captive=True),                              # captive
        raw(1, 123, life_stage="other:4"),                      # a caterpillar
        raw(1, 124, created_at="2027-08-10T10:00:00Z"),         # posted after the score date
        raw(1, 200),                                            # second wave (after the 177 cut-off)
        raw(1, 50),                                             # before 1 March
    ], ignore_index=True)
    df["id"] = range(len(df))
    df["user_id"] = range(len(df))
    got = S.first_wave(df, SEASON, {"37-39": 177}, score)
    assert sorted(got.doy.tolist()) == [120, 120, 120]
    # one record per observer + hex + day
    dup = pd.concat([raw(1, 120), raw(1, 120)], ignore_index=True)
    assert len(S.first_wave(dup, SEASON, {"37-39": 177}, score)) == 1


def test_scorecard_summary_counts():
    replay = {"bands": [{"label": "37-39", "cutoff": 177}, {"label": "45-49", "cutoff": None}],
              "scores": [{"band": "37-39", "obs_onset": 100, "obs_peak": 120}, {"band": "45-49", "obs_onset": 160, "obs_peak": 175}]}
    df = raw(30, 125)
    df["observed_on"] = [S.doy_date(SEASON, 110 + i).isoformat() for i in range(30)]
    df["created_at"] = df["observed_on"]
    out = S.scorecard(SEASON, df, [entry("2027-03-20", 112, 125)], dt.date(2027, 8, 4), replay)
    s = out["layers"]["luna"]["summary"]
    assert out["score_date"] == "2027-08-02"
    assert s["scored"] == 1 and s["pending"] == 1                 # 45-49's window (day 240) is still open
    assert s["miss"] is not None and s["calendar_miss"] is not None


def test_scored_strip_is_frozen_against_late_uploads():
    replay = {"bands": [{"label": "37-39", "cutoff": 177}],
              "scores": [{"band": "37-39", "obs_onset": 100, "obs_peak": 120}]}
    df = raw(30, 125)
    df["observed_on"] = [S.doy_date(SEASON, 110 + i).isoformat() for i in range(30)]
    df["created_at"] = df["observed_on"]
    es = [entry("2027-03-20", 112, 125)]
    first = S.scorecard(SEASON, df, es, dt.date(2027, 8, 2), replay)
    row = first["layers"]["luna"]["bands"][0]
    assert row["status"] == "scored" and row["scored_on"] == "2027-08-02"
    # a week later, 30 late uploads of early-June records would move the real peak, but the published row stays
    late = raw(30, 160)
    late["id"] = late["user_id"] = range(100, 130)
    late["created_at"] = "2027-08-05"
    more = pd.concat([df, late], ignore_index=True)
    assert S.scorecard(SEASON, more, es, dt.date(2027, 8, 9), replay)["layers"]["luna"]["bands"][0]["peak"]["real"] > 140
    nxt = S.scorecard(SEASON, more, es, dt.date(2027, 8, 9), replay, prev=first)
    assert nxt["layers"]["luna"]["bands"][0] == row and nxt["score_date"] == "2027-08-09"
    assert nxt["layers"]["luna"]["summary"]["miss"] == first["layers"]["luna"]["summary"]["miss"]
    # nothing is frozen from another season, another model, or a later week's file
    assert S.frozen_rows({**first, "season": SEASON + 1}, SEASON, "luna", MODEL, dt.date(2027, 8, 9)) == {}
    assert S.frozen_rows(first, SEASON, "luna", {"id": "x", "hash": "y"}, dt.date(2027, 8, 9)) == {}
    assert S.frozen_rows(first, SEASON, "luna", MODEL, dt.date(2027, 7, 26)) == {}


def test_archive_entry_keeps_model_and_bands(tmp_path):
    live = {"season": SEASON, "generated": "2027-05-02T13:40:00Z", "as_of": "2027-05-01",
            "model": {"id": "p3-v1", "spec": "p3_photo", "hash": "abc"}, "bands": entry("x", 1, 2)["bands"]}
    p = S.add_to_archive(tmp_path, live)
    assert p.name == "2027-05-02.json"
    got = S.load_archive(tmp_path, SEASON)
    assert got[0]["model"] == MODEL and got[0]["bands"] == live["bands"] and "rehearsal" not in got[0]


def test_band_reach_mixes_cells_by_weight():
    t = np.arange(10)
    share = np.array([np.clip((t - 2) / 4, 0, 1), np.clip((t - 6) / 2, 0, 1), np.zeros(10)])   # 3rd cell: no sightings
    w = np.array([[1.0, 0.0, 5.0], [0.0, 0.0, 1.0]])            # band 2 has only the empty cell
    got = L.band_reach(share, w, [0.5])
    assert got[0] == L.first_reach(share[0], [0.5])             # the empty cell drops out of band 1
    assert got[1] == [np.inf]


def test_model_hash_is_stable():
    assert L.model_hash() == L.model_hash() and len(L.model_hash()) == 12
