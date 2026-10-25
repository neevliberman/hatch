"""Offline tests for the league: the promotion rule, the weekly table, shadow archiving. python3 -m pytest pipeline/league"""
import datetime as dt
import json
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from league import bench, rules, weekly  # noqa: E402
from live import build_live as L, scorecard as S  # noqa: E402

SEASON = 2027
P31 = bench.BY_SLUG["luna~p3.1-v1"]


# ---------------------------------------------------------------- the rule
def strips(*rows):
    return [rules.Strip(f"b{i}", n, c, x) for i, (n, c, x) in enumerate(rows)]


def test_nothing_is_decided_before_the_verdict_date():
    s = strips((100, 9.0, 1.0), (100, 9.0, 1.0), (100, 9.0, 1.0))
    assert rules.decide(s, final=False, gate_passed=True)[0] == "in_progress"


def test_challenger_wins_only_with_margin_three_strips_and_its_gate():
    s = strips((60, 5.0, 4.0), (50, 5.0, 4.0), (40, 5.0, 4.0))          # D = -1.0 exactly, 3 strips won, 150 records
    assert rules.tally(s)["D"] == -1.0
    assert rules.decide(s, True, True)[0] == "challenger_wins"
    assert rules.decide(s, True, None)[0] == "tie"                        # gate not settled: cannot win
    assert rules.decide(s, True, False)[0] == "tie"
    two = strips((60, 5.0, 2.0), (50, 5.0, 2.0), (40, 5.0, 5.0))          # big D, but only 2 strips strictly won
    assert rules.decide(two, True, True)[0] == "tie"


def test_champion_wins_at_plus_one_and_small_samples_give_no_verdict():
    assert rules.decide(strips((60, 4.0, 5.0), (50, 4.0, 5.0), (40, 4.0, 5.0)), True, True)[0] == "champion_wins"
    assert rules.decide(strips((60, 5.0, 1.0), (50, 5.0, 1.0)), True, True)[0] == "no_verdict"        # 2 strips
    assert rules.decide(strips((40, 5.0, 1.0), (40, 5.0, 1.0), (40, 5.0, 1.0)), True, True)[0] == "no_verdict"   # 120 records


def test_headline_is_record_weighted():
    t = rules.tally(strips((300, 2.0, 4.0), (100, 6.0, 0.0)))
    assert t["champion"] == 3.0 and t["challenger"] == 3.0 and t["D"] == 0.0


def test_head_to_head_uses_strips_scored_for_both_and_refuses_different_records():
    a = [{"band": "37-39", "status": "scored", "n": 30, "miss": 3.0}, {"band": "39-41", "status": "pending", "n": 5}]
    b = [{"band": "37-39", "status": "scored", "n": 30, "miss": 2.5}, {"band": "39-41", "status": "scored", "n": 25, "miss": 1.0}]
    assert rules.head_to_head(a, b) == [rules.Strip("37-39", 30, 3.0, 2.5)]
    with pytest.raises(ValueError):
        rules.head_to_head(a, [{**b[0], "n": 31}])


# ---------------------------------------------------------------- the bench
def test_bench_is_the_preregistered_p31():
    assert [c.slug for c in bench.tonight(2026)] == []                    # nothing shadows before its first season
    assert [c.slug for c in bench.tonight(2027)] == ["luna~p3.1-v1"]
    assert bench.tonight(2027, ["firefly"]) == []
    assert P31.model_hash() == "a9fb5fe06cdb"                             # the hash PREREG_2027.md pins
    assert P31.verdict == dt.date(2027, 9, 27) and P31.verdict.weekday() == 0
    assert P31.archive_dir(Path("live/archive")) == Path("live/archive_p31")
    sp = P31.live_species()
    assert sp.fits == P31.fits and sp.replay.name == "luna-replay.json" and sp.key != "luna"


def test_shadow_entry_is_small_and_names_its_model():
    e = {"version": 1, "season": SEASON, "generated": "2027-04-01T13:40:00Z", "as_of": "2027-03-29",
         "forecast_through": "2027-04-05", "backfill": False, "model": {"id": "p3.1-v1", "hash": "a9fb5fe06cdb"},
         "bands": [], "median": [1] * 500, "sightings": [[1, 2]] * 100, "cells": ["x"] * 500}
    s = bench.shadow_entry(e, P31)
    assert "median" not in s and "sightings" not in s and "cells" not in s
    assert s["challenger"] == "p3.1-v1" and s["species"] == "luna"


def test_a_failing_challenger_never_costs_the_night(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("fits unreadable")
    monkeypatch.setattr(L, "forecast_species", boom)
    out, failed = L.shadows({}, SEASON, dt.date(2027, 4, 1), dt.date(2027, 4, 4), ["luna"])
    assert out == {} and failed == ["luna~p3.1-v1"]


def test_challenger_runs_with_its_own_model_and_no_sightings(monkeypatch):
    seen = {}

    def fake(sp, wx, season, as_of, today, prev=None, model_id=None, sightings=True):
        seen.update(fits=sp.fits, model_id=model_id, sightings=sightings)
        return {"version": 1, "season": season, "generated": "2027-04-04T13:40:00Z", "as_of": as_of.isoformat(),
                "forecast_through": as_of.isoformat(), "backfill": False, "model": {"id": model_id, "hash": "h"}, "bands": []}
    monkeypatch.setattr(L, "forecast_species", fake)
    out, failed = L.shadows({}, SEASON, dt.date(2027, 4, 1), dt.date(2027, 4, 4), ["luna"])
    assert failed == [] and list(out) == ["luna~p3.1-v1"]
    assert seen == {"fits": P31.fits, "model_id": "p3.1-v1", "sightings": False}


# ---------------------------------------------------------------- archiving and the weekly table
BAND_LAT = {"37-39": 38.0, "39-41": 40.0, "41-43": 42.0, "43-45": 44.0}


def entry(issued, model, shift, backfill=False):
    """A night's strip dates: real-ish days moved by `shift` days."""
    base = {"37-39": (150, 160), "39-41": (155, 165), "41-43": (158, 168), "43-45": (165, 175), "45-49": (170, 180)}
    return {"version": 1, "season": SEASON, "generated": f"{issued}T13:40:00Z", "as_of": issued, "backfill": backfill,
            "model": model, "bands": [{"band": b, "onset": o + shift, "onset_lo": o + shift - 7, "onset_hi": o + shift + 7,
                                       "peak": p + shift, "peak_lo": p + shift - 7, "peak_hi": p + shift + 7}
                                      for b, (o, p) in base.items()]}


def raw_records():
    """Research-grade adult records in four strips, onset ~150-165 and peak ~160-175 (the base days above)."""
    rows, i = [], 0
    for band, lat in BAND_LAT.items():
        o = {"37-39": 150, "39-41": 155, "41-43": 158, "43-45": 165}[band]
        for k in range(50):
            doy = o - 4 + k // 2                       # 50 records over 25 days: 10th pct ~ o, median ~ o + 8
            d = S.doy_date(SEASON, doy)
            rows.append({"id": i, "user_id": i, "observed_on": d.isoformat(), "created_at": d.isoformat() + "T20:00:00Z",
                         "lat": lat, "lng": -88.0 + 0.01 * (i % 50), "accuracy_m": 10.0, "obscured": False,
                         "geoprivacy": None, "quality_grade": "research", "captive": False, "life_stage": "adult"})
            i += 1
    return pd.DataFrame(rows)


CHAMP = {"id": "p3-v1", "hash": "7dc3c4c0887b"}
CHALL = {"id": "p3.1-v1", "hash": "a9fb5fe06cdb"}


def season_files(live: Path, champ_shift=6, chall_shift=0, drop_challenger=()):
    """Nightly archives from 1 April to 30 June: champion 6 days late, challenger on time (by default)."""
    d = dt.date(SEASON, 4, 1)
    while d <= dt.date(SEASON, 6, 30):
        S.add_to_archive(live / "archive", entry(d.isoformat(), CHAMP, champ_shift))
        if d.isoformat() not in drop_challenger:
            S.add_to_archive(live / "archive_p31", entry(d.isoformat(), CHALL, chall_shift))
        d += dt.timedelta(days=1)


def test_add_all_archives_challengers_in_their_own_folder(tmp_path):
    live = entry("2027-04-02", CHAMP, 0)
    live["shadows"] = {"luna~p3.1-v1": entry("2027-04-02", CHALL, 0),
                       "luna~unknown": entry("2027-04-02", CHALL, 0)}
    paths = S.add_all(tmp_path / "archive", live)
    assert tmp_path / "archive_p31" / "2027" / "2027-04-02.json" in paths
    assert not (tmp_path / "unknown").exists() and len(paths) == 2          # an unknown slug is never archived
    live["shadows"]["luna~p3.1-v1"] = entry("2027-04-02", CHALL, 0, backfill=True)
    (tmp_path / "archive_p31" / "2027" / "2027-04-02.json").unlink()
    S.add_all(tmp_path / "archive", live)
    assert not (tmp_path / "archive_p31" / "2027" / "2027-04-02.json").exists()   # a backfill is never sealed


def test_weekly_table_cuts_to_common_nights_and_saves_the_records(tmp_path):
    season_files(tmp_path, drop_challenger={"2027-04-03", "2027-04-04"})
    calls = []

    def fetch(season, until, taxon):
        calls.append(until)
        return raw_records()
    today = dt.date(2027, 7, 21)                          # a Wednesday: the week of Monday 19 July
    p = weekly.run_if_due(tmp_path, SEASON, today, fetch=fetch)
    assert p == tmp_path / "league.json"
    t = json.loads(p.read_text())
    c = t["layers"]["luna"]["challengers"][0]
    assert c["nights"] == {"champion": 91, "challenger": 89, "common": 89}
    assert c["verdict"] == "in_progress" and c["takes_map"] is None
    assert c["tally"]["strips"] >= 3 and c["tally"]["D"] < -1.0              # on time beats 6 days late
    rec = tmp_path / "records" / "2027" / "2027-07-19.parquet"
    assert rec.exists() and rec.with_suffix(".sha256").read_text().split()[0] == __import__("hashlib").sha256(rec.read_bytes()).hexdigest()
    assert weekly.run_if_due(tmp_path, SEASON, dt.date(2027, 7, 22), fetch=fetch) is None   # once a week
    assert len(calls) == 1


def test_verdict_after_the_verdict_date_needs_the_gate(tmp_path):
    season_files(tmp_path)

    def fetch(season, until, taxon):
        return raw_records()
    late = dt.date(2027, 9, 27)
    t = weekly.run(tmp_path, SEASON, late, fetch=fetch, gates={"luna~p3.1-v1": {"passed": None}})
    assert t["layers"]["luna"]["challengers"][0]["verdict"] == "tie"         # gate not settled
    t = weekly.run(tmp_path, SEASON, late, fetch=fetch, gates={"luna~p3.1-v1": {"passed": True}})
    c = t["layers"]["luna"]["challengers"][0]
    assert c["verdict"] == "challenger_wins" and c["takes_map"] == 2028


def test_scores_stay_frozen_week_to_week(tmp_path):
    season_files(tmp_path)

    def fetch(season, until, taxon):
        return raw_records()
    weekly.run(tmp_path, SEASON, dt.date(2027, 7, 19), fetch=fetch)
    first = json.loads((tmp_path / "league" / "2027" / "luna~p3.1-v1.challenger.json").read_text())
    # a late-uploaded batch the next week must not move a published score
    late = pd.concat([raw_records(), raw_records().assign(id=lambda d: d.id + 10_000, user_id=lambda d: d.user_id + 10_000,
                                                          observed_on=S.doy_date(SEASON, 175).isoformat())])
    weekly.run(tmp_path, SEASON, dt.date(2027, 7, 26), fetch=lambda *a: late)
    second = json.loads((tmp_path / "league" / "2027" / "luna~p3.1-v1.challenger.json").read_text())
    a = {r["band"]: r for r in first["layers"]["luna"]["bands"] if r["status"] == "scored"}
    b = {r["band"]: r for r in second["layers"]["luna"]["bands"] if r["status"] == "scored"}
    assert a and all(b[k] == a[k] for k in a)
