"""Offline tests for the model-drift alarm (drift.py)."""
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from league import drift as D  # noqa: E402

MODEL = {"id": "p3-v1", "hash": "abc"}
BANDS = ["37-39", "39-41", "41-43"]
CUT = 180


def replay(bias_by_year):
    """Three strips per year; each strip's forecast misses by the year's bias +-1 (so each year's mean is exact)."""
    scores = []
    for y, b in bias_by_year.items():
        for i, band in enumerate(BANDS):
            e = b + (i - 1)
            scores.append({"band": band, "year": y, "n": 30, "obs_onset": 100.0, "obs_peak": 130.0,
                           "heat_onset": 100.0 + e, "heat_peak": 130.0 + e})
    return {"scores": scores}


PAST = replay({2019: -2, 2020: 0, 2021: 2, 2022: 0, 2023: -1, 2024: 1})     # mean 0, SD sqrt(2)


def row(band, real_onset, real_peak, sealed_onset, sealed_peak):
    return {"band": band, "cutoff": CUT, "n": 40, "status": "scored",
            "onset": {"real": real_onset, "error": sealed_onset}, "peak": {"real": real_peak, "error": sealed_peak}}


def entry(as_of, fc, model=MODEL):
    """fc: {band: (onset, peak)}"""
    return {"issued": (dt.date.fromisoformat(as_of) + dt.timedelta(days=3)).isoformat(), "as_of": as_of,
            "model": model, "bands": [{"band": b, "onset": o, "peak": p} for b, (o, p) in fc.items()]}


def test_reference_uses_years_with_three_strips():
    r = D.reference({"scores": PAST["scores"] + [{"band": "37-39", "year": 2018, "obs_onset": 1, "obs_peak": 1,
                                                  "heat_onset": 50, "heat_peak": 50}]})
    assert r["peak"]["years"] == [2019, 2020, 2021, 2022, 2023, 2024]          # 2018 has one strip: left out
    assert r["peak"]["mean"] == 0 and r["peak"]["sd"] == pytest.approx(np.sqrt(2), abs=0.01)
    assert r["onset"]["max_strip"] == 49                                        # every strip-year counts here


def test_hindsight_is_the_first_forecast_whose_weather_reaches_the_cutoff():
    cut_day = D.S.doy_date(2027, CUT).isoformat()                               # 29 June
    early, late, other = (entry("2027-06-20", {}), entry(cut_day, {}), entry("2027-07-01", {}, {"id": "x"}))
    later = entry("2027-07-10", {})
    assert D.hindsight([early, other, late, later], MODEL, 2027, CUT) is late
    assert D.hindsight([early, other], MODEL, 2027, CUT) is None


def test_decompose_splits_the_miss_into_weather_and_model():
    r = row("37-39", 100.0, 130.0, sealed_onset=8.0, sealed_peak=-2.0)
    d = D.decompose(r, [entry("2027-07-01", {"37-39": (101, 126)})], MODEL, 2027)
    assert d["onset"] == {"sealed": 8.0, "model": 1.0, "weather": 7.0}        # mostly the weather surprised it
    assert d["peak"] == {"sealed": -2.0, "model": -4.0, "weather": 2.0}
    assert D.decompose(r, [entry("2027-06-01", {"37-39": (101, 126)})], MODEL, 2027) is None   # no hindsight yet


def layer_with(model_part, n_bands=3, spread=(-1, 0, 1)):
    """A scored layer whose hindsight peaks miss by model_part + spread (onset: 0 everywhere)."""
    rows, fc = [], {}
    for band, s in zip(BANDS[:n_bands], spread):
        rows.append(row(band, 100.0, 130.0, 0.0, model_part + s))
        fc[band] = (100, 130 + model_part + s)
    return {"model": MODEL, "bands": rows}, [entry("2027-07-01", fc)]


def test_season_alarm_needs_size_and_agreement():
    thr = D.Z * np.sqrt(2) + D.SOURCE_DAYS                                      # 2.83 + 1.5
    lay, ent = layer_with(-5.0)                                                 # -6, -5, -4: all early, past the line
    res = D.check_layer("Luna moth", lay, ent, PAST, 2027)
    assert res["peak"]["state"] == "alarm" and res["alarms"] == ["peak"]
    assert res["peak"]["threshold"] == pytest.approx(thr, abs=0.01) and "5.0 days early" in res["peak"]["text"]
    assert res["onset"]["state"] == "ok"
    lay, ent = layer_with(-4.0)                                                 # mean -4: inside 4.33
    assert D.check_layer("Luna moth", lay, ent, PAST, 2027)["peak"]["state"] == "ok"
    lay, ent = layer_with(-5.0, spread=(-14, 6, 8))                             # mean -5, but one strip drives it
    assert D.check_layer("Luna moth", lay, ent, PAST, 2027)["peak"]["state"] == "ok"
    lay, ent = layer_with(-9.0, n_bands=2)
    assert D.check_layer("Luna moth", lay, ent, PAST, 2027)["peak"]["state"] == "too_few"
    few = replay({2020: 0, 2021: 1, 2022: -1, 2023: 0})                         # 4 past years: under MIN_YEARS
    lay, ent = layer_with(-9.0)
    assert D.check_layer("Luna moth", lay, ent, few, 2027)["peak"]["state"] == "too_few"


def test_running_alarm_catches_slow_drift():
    lay, ent = layer_with(-3.5)                                                 # not enough for one season
    one = D.check_layer("Luna moth", lay, ent, PAST, 2027)
    assert one["peak"]["state"] == "ok" and "running" not in one["peak"]
    two = D.check_layer("Luna moth", lay, ent, PAST, 2027, {"peak": [-3.5]})
    run = two["peak"]["running"]
    assert run["seasons"] == 2 and run["threshold"] == pytest.approx(D.Z + D.SOURCE_DAYS, abs=0.02)
    assert run["state"] == "alarm" and two["alarms"] == ["peak/running"]


def test_strips_beyond_every_past_miss_are_listed_not_alarmed():
    lay, ent = layer_with(0.0, spread=(-9, 2, 3))       # past strips miss by at most 3
    res = D.check_layer("Luna moth", lay, ent, PAST, 2027)
    assert res["beyond_past"] == [{"band": "37-39", "kind": "peak", "model": -9.0}] and res["alarms"] == []


def setup_live(tmp_path, model_part, season=2027):
    lay, ent = layer_with(model_part)
    card = {"version": 1, "kind": "scorecard", "season": season, "score_date": f"{season}-08-02",
            "layers": {"luna": lay}}
    (tmp_path / "scorecard.json").write_text(json.dumps(card))
    d = tmp_path / "archive" / str(season)
    d.mkdir(parents=True, exist_ok=True)
    for e in ent:
        e = {**e, "as_of": e["as_of"].replace("2027", str(season)), "issued": e["issued"].replace("2027", str(season))}
        (d / f"{e['issued']}.json").write_text(json.dumps(e))


@pytest.fixture
def luna_past(tmp_path, monkeypatch):
    """Luna's live entry, reading PAST as its replay."""
    import dataclasses
    from live import registry
    f = tmp_path / "replay.json"
    f.write_text(json.dumps(PAST))
    monkeypatch.setattr(D.registry, "BY_KEY", {"luna": dataclasses.replace(registry.BY_KEY["luna"], replay=f)})


def test_run_writes_the_file_and_opens_each_issue_once(tmp_path, monkeypatch, luna_past):
    opened = []
    monkeypatch.setattr(D, "open_issue", lambda title, body: opened.append((title, body)) or True)
    setup_live(tmp_path, -6.0)
    out = tmp_path / "drift.json"
    doc = D.run(tmp_path / "scorecard.json", tmp_path / "archive", out, 2027, seed=None)
    assert json.loads(out.read_text())["layers"]["luna"]["peak"]["state"] == "alarm" == doc["layers"]["luna"]["peak"]["state"]
    assert [t for t, _ in opened] == ["Model drift: Luna moth peak (2027)"] and doc["raised"] == {"luna/peak": "2027-08-02"}
    assert "| 37-39 | 40 |" in opened[0][1]
    D.run(tmp_path / "scorecard.json", tmp_path / "archive", out, 2027, seed=None)
    assert len(opened) == 1                                                     # raised once a season


def test_a_failed_issue_is_retried_the_next_night(tmp_path, monkeypatch, luna_past):
    monkeypatch.setattr(D, "open_issue", lambda title, body: False)
    setup_live(tmp_path, -6.0)
    out = tmp_path / "drift.json"
    assert D.run(tmp_path / "scorecard.json", tmp_path / "archive", out, 2027, seed=None)["raised"] == {}


def test_past_seasons_feed_the_running_check_only_for_the_same_model(tmp_path, monkeypatch, luna_past):
    monkeypatch.setattr(D, "open_issue", lambda title, body: True)
    setup_live(tmp_path, -3.5, season=2026)
    seed = tmp_path / "seed.json"
    D.run(tmp_path / "scorecard.json", tmp_path / "archive", seed, 2026, seed=None)
    setup_live(tmp_path, -3.5)
    out = tmp_path / "drift.json"
    doc = D.run(tmp_path / "scorecard.json", tmp_path / "archive", out, 2027, seed=seed)
    assert list(doc["past"]) == ["2026"] and doc["layers"]["luna"]["peak"]["running"]["state"] == "alarm"
    assert doc["raised"] == {"luna/peak/running": "2027-08-02"}
    s = json.loads(seed.read_text())
    s["layers"]["luna"]["model"] = {"id": "p3.1-v1", "hash": "other"}          # last season ran another model
    seed.write_text(json.dumps(s))
    out.unlink()
    doc = D.run(tmp_path / "scorecard.json", tmp_path / "archive", out, 2027, seed=seed)
    assert "running" not in doc["layers"]["luna"]["peak"]


def test_the_2026_seed_is_what_the_code_gives_on_the_2026_files(tmp_path):
    """DRIFT_2026.json (the rehearsal season the 2027 running check starts from) is reproducible from the repo."""
    root = HERE.parents[1]
    doc = D.run(root / "public" / "live" / "scorecard.json", root / "pipeline" / "live" / "archive",
                tmp_path / "d.json", 2026, notify=False, seed=None)
    seed = json.loads(D.SEED.read_text())
    assert seed["season"] == 2026 and seed["layers"] == doc["layers"]
    assert seed["layers"]["luna"]["peak"]["state"] == "ok" and not seed["raised"]
