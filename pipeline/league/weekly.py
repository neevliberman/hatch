#!/usr/bin/env python3
"""Weekly league table: every bench challenger graded against its champion on the same sealed nights and records.

Runs inside the nightly job's scorecard step (scorecard.py calls run_if_due), once per week: on the first night of
each scoring week (Mondays; a missed Monday is caught up the next night). Per species with challengers:
1. Records: one pull of the season's research-grade records, saved with its sha256 to
   live/records/<season>/<monday>.parquet (luna) or live/records/<season>/<key>/<monday>.parquet, and the same file
   feeds every model's scorecard (PREREG_2027.md: "Records").
2. Same nights: the champion's and the challenger's archives are cut to the nights both archived (an outage for
   either drops the night for both), then the unmodified scorecard() grades each, each from its own last card
   (live/league/<season>/<species>~<id>.<champion|challenger>.json), so a strip's score is frozen the week it is first given.
3. Head to head and verdict: rules.py. The table is written to live/league.json.

Run by hand:  python3 pipeline/league/weekly.py --live live --season 2027 [--today 2027-07-12] [--force]
"""
import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

from league import bench, rules  # noqa: E402
from live import registry, scorecard as S  # noqa: E402

GATES = HERE / "gates.json"


def records_path(live: Path, season, key, monday: dt.date) -> Path:
    base = live / "records" / str(season)
    return (base if key == "luna" else base / key) / f"{monday.isoformat()}.parquet"


def weekly_records(live: Path, season, sp, monday: dt.date, today: dt.date, fetch=S.fetch_records):
    """This week's one pull of the season's records for species `sp` (reused if this week's file exists)."""
    p = records_path(live, season, sp.key, monday)
    if p.exists():
        return pd.read_parquet(p)
    raw = fetch(season, today, sp.taxon)
    p.parent.mkdir(parents=True, exist_ok=True)
    raw.to_parquet(p)
    p.with_suffix(".sha256").write_text(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n")
    return raw


def common_nights(a, b):
    """Both archives cut to the nights both have (by issue date)."""
    both = {e["issued"] for e in a} & {e["issued"] for e in b}
    return [e for e in a if e["issued"] in both], [e for e in b if e["issued"] in both]


def card_path(live: Path, season, slug) -> Path:
    return live / "league" / str(season) / f"{slug}.json"


def gate_state(slug, gates=None):
    g = (gates if gates is not None else json.loads(GATES.read_text())).get(slug) or {}
    return g.get("passed")


def grade_challenger(ch, live: Path, season, today: dt.date, raw, replay, gates=None):
    """One challenger's row in the league table, writing both models' cards for this week."""
    sp = registry.get(ch.species)
    champ_all = S.load_archive(sp.archive(live / "archive"), season)
    chall_all = S.load_archive(ch.archive_dir(live / "archive"), season)
    champ, chall = common_nights(champ_all, chall_all)
    cards = {}
    for role, entries in (("champion", champ), ("challenger", chall)):
        p = card_path(live, season, f"{ch.slug}.{role}")      # each model from its own last card (frozen rows)
        card = S.scorecard(season, raw, entries, today, replay=replay, layer=ch.species, prev=S.read_card(p))
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(card, separators=(",", ":"), allow_nan=False))
        cards[role] = card["layers"][ch.species]
    strips = rules.head_to_head(cards["champion"]["bands"], cards["challenger"]["bands"])
    final = S.week_start(today) >= ch.verdict
    gate = gate_state(ch.slug, gates)
    verdict, reason = rules.decide(strips, final, gate)
    return {"id": ch.id, "why": ch.why, "model": cards["challenger"]["model"], "champion_model": cards["champion"]["model"],
            "nights": {"champion": len(champ_all), "challenger": len(chall_all), "common": len(champ)},
            "strips": [vars(s) for s in strips], "tally": rules.tally(strips),
            "verdict_date": ch.verdict.isoformat(), "gate": {"name": ch.gate, "passed": gate},
            "verdict": verdict, "reason": reason,
            "takes_map": season + 1 if verdict == "challenger_wins" else None}


def run(live: Path, season, today: dt.date, fetch=S.fetch_records, gates=None):
    """This week's league table (every species with challengers this season)."""
    monday = S.week_start(today)
    layers = {}
    for key in sorted({c.species for c in bench.tonight(season)}):
        sp = registry.get(key)
        raw = weekly_records(live, season, sp, monday, today, fetch)
        replay = json.loads(sp.replay.read_text())
        layers[key] = {"challengers": [grade_challenger(c, live, season, today, raw, replay, gates)
                                       for c in bench.tonight(season, [key])]}
    return {"version": 1, "kind": "league", "season": season, "score_date": monday.isoformat(),
            "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "rule": {"margin_days": rules.MARGIN, "min_wins": rules.MIN_WINS, "min_strips": rules.MIN_STRIPS,
                     "min_records": rules.MIN_RECORDS,
                     "plain": "a challenger takes the map next season only if, on nights both forecast and strips both "
                              "had scored, its record-weighted miss is at least 1 day lower, it wins at least 3 strips "
                              "and its gate passed; never mid-season"},
            "layers": layers}


def run_if_due(live: Path, season, today: dt.date, fetch=S.fetch_records, force=False):
    """The nightly hook: run once per scoring week. -> the path written, or None if this week is done or no challenger
    plays this season."""
    if not bench.tonight(season):
        return None
    out = live / "league.json"
    old = S.read_card(out)
    if not force and old and old.get("season") == season and old.get("score_date") == S.week_start(today).isoformat():
        return None
    table = run(live, season, today, fetch)
    out.write_text(json.dumps(table, separators=(",", ":"), allow_nan=False) + "\n")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--live", type=Path, required=True, help="the live-data folder (holds archive/, league.json)")
    ap.add_argument("--season", type=int)
    ap.add_argument("--today", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    ap.add_argument("--force", action="store_true", help="rerun even if this week's table exists")
    a = ap.parse_args(argv)
    p = run_if_due(a.live, a.season or a.today.year, a.today, force=a.force)
    if p is None:
        print("league: nothing to do (this week's table exists, or no challenger this season)")
        return 0
    for key, layer in json.loads(p.read_text())["layers"].items():
        for c in layer["challengers"]:
            print(f"league [{key}] {c['id']}: {c['verdict']} ({c['reason']}); nights {c['nights']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
