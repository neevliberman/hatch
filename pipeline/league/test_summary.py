"""Offline tests for the app's league block (summary.py)."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from league import summary as M  # noqa: E402

ROOT = HERE.parents[1]


def test_before_the_season_every_tryout_is_upcoming(tmp_path):
    b = M.block(tmp_path, 2026, HERE / "DRIFT_2026.json")
    luna = b["layers"]["luna"]
    assert [t["name"] for t in luna["tryouts"]] == ["Simpler warmth model", "Warm-spring guard", "Eastern heat clock"]
    assert {t["status"] for t in luna["tryouts"]} == {"upcoming"} and luna["drift"] == "ok"
    assert [t["report_only"] for t in luna["tryouts"]] == [False, True, False]
    assert b["layers"]["firefly"] == {"tryouts": [], "drift": "ok"}
    assert M.block(tmp_path, 2029)["layers"] == {}                       # all decided and gone, no drift file


def test_in_season_rows_come_from_the_weekly_tables(tmp_path):
    (tmp_path / "league.json").write_text(json.dumps({"season": 2027, "layers": {"luna": {"challengers": [
        {"id": "p3.1-v1", "verdict": "in_progress", "tally": {"strips": 4, "D": -1.234, "wins": 3}},
        {"id": "p3-a1-v1", "verdict": "error", "reason": "boom", "nights": None}, "junk"]}}}))
    (tmp_path / "league_east.json").write_text(json.dumps(
        {"season": 2027, "verdict": "clock_wins", "tally": {"places": 12, "D": -1.5, "clock_wins": 7}}))
    rows = {t["id"]: t for t in M.block(tmp_path, 2027)["layers"]["luna"]["tryouts"]}
    assert (rows["p3.1-v1"]["status"], rows["p3.1-v1"]["strips"], rows["p3.1-v1"]["D"]) == ("in_progress", 4, -1.2)
    assert rows["p3-a1-v1"]["status"] == "error" and rows["p3-a1-v1"]["D"] is None
    assert (rows["east"]["status"], rows["east"]["strips"], rows["east"]["against"]) == ("clock_wins", 12, "usual")
    (tmp_path / "league.json").write_text(json.dumps({"season": 2026, "layers": {"luna": {"challengers": [
        {"id": "p3.1-v1", "verdict": "tie"}]}}}))                         # another season's table is not this one's
    assert M.block(tmp_path, 2027)["layers"]["luna"]["tryouts"][0]["status"] == "in_progress"


def test_drift_state_is_the_worst_of_onset_peak_and_running():
    doc = {"season": 2027, "layers": {
        "luna": {"onset": {"state": "ok", "running": {"state": "alarm"}}, "peak": {"state": "watch"}},
        "firefly": {"onset": {"state": "watch"}, "peak": {"state": "too_few"}},
        "japanese-beetle": {"onset": {"state": "too_few"}, "peak": {}}}}
    assert M.drift_states(doc, 2027) == {"luna": "alarm", "firefly": "watch"}
    assert M.drift_states(doc, 2028) == {} and M.drift_states(None, 2027) == {}


def test_attach_adds_the_block_and_keeps_the_rest(tmp_path):
    card = tmp_path / "scorecard.json"
    assert M.attach(card, tmp_path) is None                              # no card: nothing written
    card.write_text("{not json")
    assert M.attach(card, tmp_path) is None
    card.write_text(json.dumps({"version": 1, "kind": "scorecard", "season": 2026, "layers": {"luna": {}}}))
    M.attach(card, tmp_path, HERE / "DRIFT_2026.json")
    d = json.loads(card.read_text())
    assert d["layers"] == {"luna": {}} and d["league"]["layers"]["luna"]["drift"] == "ok"


def test_the_bundled_rehearsal_carries_the_block():
    d = json.loads((ROOT / "public" / "live" / "scorecard.json").read_text())
    assert d["league"] == M.block(Path("/nonexistent"), d["season"], HERE / "DRIFT_2026.json")
