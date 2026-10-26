#!/usr/bin/env python3
"""Verdict notices: when a league verdict is given, the nightly job opens one GitHub issue saying what was decided
and what happens next. Nothing on the map changes here; a winner is swapped in between seasons by PROMOTE.md.

Reads the tables the nightly job has just written (live/league.json from weekly.py, live/league_east.json from
east.py). A verdict is final once it is anything but "in_progress" (or a grading "error"). Each notice is opened once:
the issues opened are kept in live/verdicts.json, and a failed attempt (no token, GitHub down) is tried again the next
night. Run nightly by pipeline/live/scorecard.py after the drift check.

Run: python3 pipeline/league/verdicts.py --live live
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from league import drift  # noqa: E402
from live import scorecard as S  # noqa: E402

OPEN = ("in_progress", "error")
NEXT = {
    "challenger_wins": "It takes the map next season. Before 1 March, swap it in by pipeline/league/PROMOTE.md, then "
                       "close this issue.",
    "champion_wins": "The challenger was at least 1 day worse and is retired. The map keeps its model; nothing to do.",
    "tie": "The map keeps its model. A tie is not evidence the two are equal; the challenger is not retried as if new.",
    "no_verdict": "Too few strips or records were scored. If its rule allows another attempt (PREREG_2027.md: 2028), "
                  "move its first season and verdict date a year on before 1 March; otherwise it leaves the bench.",
    "clock_wins": "The eastern heat clock earned an eastern layer from next season (EAST_2027.md). Building that "
                  "layer is the next step; close this issue once it is planned.",
    "calendar_stays": "The clock did not prove itself (EAST_2027.md); it is not retuned and retried as if new.",
}


def notices(live: Path):
    """[(tag, title, body)] for every final verdict in tonight's tables."""
    out = []
    league = S.read_card(live / "league.json") or {}
    for key, layer in (league.get("layers") or {}).items():
        for c in layer.get("challengers") or []:
            if c.get("verdict") in OPEN or c.get("verdict") is None:
                continue
            season = league["season"]
            t = c.get("tally") or {}
            nxt = NEXT.get(c["verdict"], "")
            if (c.get("gate") or {}).get("name") == "report-only":
                nxt = ("A report-only shadow: it was never eligible for the map. Its numbers (and its range coverage in "
                       "its weekly cards) are the report; plan any follow-up as a new tryout.")
            body = (f"**{c['verdict'].replace('_', ' ')}**: {c['reason']}\n\n{nxt}\n\n"
                    f"Challenger `{c['id']}` ({c.get('why', '')}) against the `{key}` map model, season {season}, "
                    f"verdict week {league['score_date']}. Strips scored for both: {t.get('strips')}, records "
                    f"{t.get('records')}, record-weighted miss {t.get('challenger')} vs {t.get('champion')} days "
                    f"(D = {t.get('D')}), strips won {t.get('wins')}. Gate: {c.get('gate')}.\n\n"
                    "Table: live/league.json on the live-data branch. Opened automatically by the nightly job.")
            out.append((f"league/{season}/{key}/{c['id']}", f"League verdict {season}: {key} {c['id']}, "
                        f"{c['verdict'].replace('_', ' ')}", body))
    east = S.read_card(live / "league_east.json") or {}
    if east.get("verdict") and east["verdict"] not in OPEN:
        t = east.get("tally") or {}
        body = (f"**{east['verdict'].replace('_', ' ')}**: {east['reason']}\n\n{NEXT.get(east['verdict'], '')}\n\n"
                f"Season {east['season']}, verdict week {east['score_date']}: {t.get('places')} places, "
                f"{t.get('records')} records, D = {t.get('D')} days, clock won {t.get('clock_wins')} places "
                f"(ties {t.get('ties')}).\n\nTable: live/league_east.json on the live-data branch. Opened automatically "
                "by the nightly job.")
        out.append((f"east/{east['season']}", f"Eastern heat clock verdict {east['season']}: "
                    f"{east['verdict'].replace('_', ' ')}", body))
    return out


def run(live: Path, notify=True):
    """Open an issue for each final verdict not yet noticed; keep the record in live/verdicts.json. -> the record."""
    path = live / "verdicts.json"
    done = (S.read_card(path) or {}).get("opened") or {}
    for tag, title, body in notices(live):
        if tag in done or not notify:
            continue
        if drift.open_issue(title, body):
            done[tag] = dt.date.today().isoformat()
    doc = {"version": 1, "kind": "verdicts", "opened": done}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    tmp.replace(path)
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--live", type=Path, required=True)
    ap.add_argument("--no-issue", action="store_true")
    a = ap.parse_args(argv)
    for tag, title, _ in notices(a.live):
        print(f"{tag}: {title}")
    run(a.live, notify=not a.no_issue)


if __name__ == "__main__":
    main()
