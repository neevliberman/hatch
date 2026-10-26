"""Offline tests for the verdict notices (verdicts.py)."""
import datetime as dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from league import verdicts as V, weekly  # noqa: E402
from league.test_league import SEASON, raw_records, season_files  # noqa: E402


def east_table(tmp_path, verdict):
    (tmp_path / "league_east.json").write_text(json.dumps(
        {"season": 2027, "score_date": "2027-09-27", "verdict": verdict, "reason": "r",
         "tally": {"places": 12, "records": 1500, "D": -1.2, "clock_wins": 7, "ties": 0}}))


def test_only_final_verdicts_are_noticed_once(tmp_path, monkeypatch):
    opened = []
    monkeypatch.setattr(V.drift, "open_issue", lambda title, body: opened.append((title, body)) or True)
    season_files(tmp_path)
    fetch = lambda *a: raw_records()                                       # noqa: E731
    weekly.run_if_due(tmp_path, SEASON, dt.date(2027, 7, 21), fetch=fetch)
    east_table(tmp_path, "in_progress")
    assert V.run(tmp_path)["opened"] == {} and opened == []                 # mid-season: nothing is decided
    weekly.run_if_due(tmp_path, SEASON, dt.date(2027, 9, 27), fetch=fetch)  # the verdict week (no gate yet: a tie)
    east_table(tmp_path, "clock_wins")
    doc = V.run(tmp_path)
    titles = [t for t, _ in opened]
    assert titles == ["League verdict 2027: luna p3.1-v1, tie", "League verdict 2027: luna p3-a1-v1, no verdict",  # no A1 archive here
                      "Eastern heat clock verdict 2027: clock wins"]
    assert set(doc["opened"]) == {"league/2027/luna/p3.1-v1/tie", "league/2027/luna/p3-a1-v1/no_verdict",
                                  "east/2027/clock_wins"}
    bodies = dict(opened)
    assert "is not settled" in bodies[titles[0]] and "a new issue says so" in bodies[titles[0]]
    assert "never eligible for the map" in bodies[titles[1]]
    assert "eastern layer" in bodies[titles[2]]
    V.run(tmp_path)
    assert len(opened) == 3                                                  # once each
    t = json.loads((tmp_path / "league.json").read_text())
    t["layers"]["luna"]["challengers"][0].update(verdict="challenger_wins", reason="gate passed")
    (tmp_path / "league.json").write_text(json.dumps(t))                     # the gate is recorded later: a new verdict
    V.run(tmp_path)
    assert opened[-1][0] == "League verdict 2027: luna p3.1-v1, challenger wins" and "PROMOTE.md" in opened[-1][1]


def test_a_failed_issue_is_tried_again(tmp_path, monkeypatch):
    east_table(tmp_path, "calendar_stays")
    monkeypatch.setattr(V.drift, "open_issue", lambda title, body: False)
    assert V.run(tmp_path)["opened"] == {}
    monkeypatch.setattr(V.drift, "open_issue", lambda title, body: True)
    assert list(V.run(tmp_path)["opened"]) == ["east/2027/calendar_stays"]


def test_grading_errors_are_not_verdicts(tmp_path):
    (tmp_path / "league.json").write_text(json.dumps(
        {"season": 2027, "score_date": "2027-09-27",
         "layers": {"luna": {"challengers": [{"id": "x", "verdict": "error", "reason": "boom"}]}}}))
    assert V.notices(tmp_path) == []


def test_odd_files_never_crash_the_night(tmp_path):
    (tmp_path / "league.json").write_text(json.dumps(
        {"score_date": "2027-09-27", "layers": {"luna": {"challengers": [{"id": "x", "verdict": "tie"}, "junk"]},
                                                "firefly": None}}))
    assert V.notices(tmp_path) == []                                         # no season: nothing to say
    (tmp_path / "league.json").write_text("{not json")
    east_table(tmp_path, "no_verdict")
    (n,) = V.notices(tmp_path)
    assert "east.py" in n[2] and "PREREG" not in n[2]
