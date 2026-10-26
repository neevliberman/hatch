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


def write_atomic(p: Path, data: bytes):
    """Write via a temporary file and rename, so a killed run never leaves a half-written file."""
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(p)


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def records_path(live: Path, season, key, monday: dt.date) -> Path:
    base = live / "records" / str(season)
    return (base if key == "luna" else base / key) / f"{monday.isoformat()}.parquet"


def weekly_records(live: Path, season, sp, monday: dt.date, today: dt.date, fetch=S.fetch_records):
    """This week's one pull of the season's records for species `sp` (reused if this week's file exists). A pull
    smaller than last week's (a truncated or empty download: records are only ever added) is refused, not saved, so
    the next night tries again."""
    p = records_path(live, season, sp.key, monday)
    sidecar = p.with_suffix(".sha256")
    if p.exists() and sidecar.exists():
        if sidecar.read_text().split()[0] != sha256(p):
            raise RuntimeError(f"{p} does not match its sha256; the week's records were changed after saving")
        return pd.read_parquet(p)
    raw = fetch(season, today, sp.taxon)
    older = sorted(q for q in p.parent.glob("*.parquet") if q.name < p.name)
    if older and len(raw) < 0.9 * len(pd.read_parquet(older[-1])):
        raise RuntimeError(f"records pull for {sp.key}: {len(raw)} rows, under 90% of last week's; not saving it")
    import io
    buf = io.BytesIO()
    raw.to_parquet(buf)
    write_atomic(p, buf.getvalue())
    write_atomic(sidecar, f"{sha256(p)}  {p.name}\n".encode())   # the file counts as saved only once this exists
    return raw


def common_nights(a, b):
    """Both archives cut to the nights both have (by issue date)."""
    both = {e["issued"] for e in a} & {e["issued"] for e in b}
    return [e for e in a if e["issued"] in both], [e for e in b if e["issued"] in both]


def card_path(live: Path, season, slug) -> Path:
    return live / "league" / str(season) / f"{slug}.json"


def gate_state(slug, gates=None):
    """True / False once the gate's number is recorded (PREREG_2027.md: passes if D(2026) < +1.0 d), else None."""
    g = (gates if gates is not None else json.loads(GATES.read_text())).get(slug) or {}
    return None if g.get("d") is None else bool(g["d"] < rules.MARGIN)


def only_when_both_scored(champ, chall):
    """Each model's scorecard layer with a strip left unscored (so not frozen, and graded again next week) unless the
    other model scored it the same week. Both then freeze together, on the same records, so their n always agree."""
    a = {r["band"]: r for r in champ["bands"] if r.get("status") == "scored"}
    b = {r["band"]: r for r in chall["bands"] if r.get("status") == "scored"}
    for layer, other in ((champ, b), (chall, a)):
        layer["bands"] = [r if r.get("status") != "scored" or r["band"] in other else
                          {k: r[k] for k in ("band", "cutoff", "settles_on", "n", "pending_records")} | {"status": "waiting_for_other"}
                          for r in layer["bands"]]


def grade_challenger(ch, live: Path, season, today: dt.date, raw, replay, gates=None):
    """One challenger's row in the league table, writing both models' cards for this week. `today` is never past the
    challenger's verdict Monday (run() caps it), so nothing scored after the verdict date counts."""
    sp = registry.get(ch.species)
    champ_all = S.load_archive(sp.archive(live / "archive"), season)
    chall_all = S.load_archive(ch.archive_dir(live / "archive"), season)
    champ, chall = common_nights(champ_all, chall_all)
    cards, paths = {}, {}
    for role, entries in (("champion", champ), ("challenger", chall)):
        paths[role] = card_path(live, season, f"{ch.slug}.{role}")      # each from its own last card (frozen rows)
        card = S.scorecard(season, raw, entries, today, replay=replay, layer=ch.species, prev=S.read_card(paths[role]))
        cards[role] = card
    only_when_both_scored(cards["champion"]["layers"][ch.species], cards["challenger"]["layers"][ch.species])
    for role, card in cards.items():
        write_atomic(paths[role], json.dumps(card, separators=(",", ":"), allow_nan=False).encode())
    cards = {role: card["layers"][ch.species] for role, card in cards.items()}
    strips = rules.head_to_head(cards["champion"]["bands"], cards["challenger"]["bands"])
    final = season == ch.verdict.year and S.week_start(today) >= ch.verdict
    gate = None if ch.gate == "report-only" else gate_state(ch.slug, gates)   # a report-only shadow never passes
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
    layers, failed = {}, []
    for key in sorted({c.species for c in bench.tonight(season)}):
        sp = registry.get(key)
        replay = json.loads(sp.replay.read_text())
        rows = []
        for c in bench.tonight(season, [key]):
            day = min(today, c.verdict)                  # after the verdict Monday, the verdict week's table stands
            raw = weekly_records(live, season, sp, S.week_start(day), day, fetch)
            try:                                         # one challenger's failure never costs another's row
                rows.append(grade_challenger(c, live, season, day, raw, replay, gates))
            except Exception as err:  # noqa: BLE001
                print(f"::error::league: grading {c.slug} failed: {err!r}", flush=True)
                rows.append({"id": c.id, "why": c.why, "verdict": "error", "reason": repr(err)[:300], "nights": None})
                failed.append(c.slug)
        layers[key] = {"challengers": rows}
    return {"version": 1, "kind": "league", "season": season, "score_date": monday.isoformat(),
            "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "rule": {"margin_days": rules.MARGIN, "min_wins": rules.MIN_WINS, "min_strips": rules.MIN_STRIPS,
                     "min_records": rules.MIN_RECORDS,
                     "plain": "a challenger takes the map next season only if, on nights both forecast and strips both "
                              "had scored, its record-weighted miss is at least 1 day lower, it wins at least 3 strips "
                              "and its gate passed; never mid-season"},
            "layers": layers, "failed": failed}


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
    # earlier seasons' last tables are carried forward, so a new season never drops a decided verdict
    past = {str(k): v for k, v in ((old or {}).get("past") or {}).items()}
    if old and old.get("kind") == "league" and old.get("season") != season:
        past[str(old["season"])] = {k: old[k] for k in ("score_date", "layers")}
    table["past"] = dict(sorted(past.items()))
    write_atomic(out, (json.dumps(table, separators=(",", ":"), allow_nan=False) + "\n").encode())
    if table.get("failed"):                             # written with every other row; now raise the night's alarm
        raise RuntimeError(f"league table written, but grading failed for {', '.join(table['failed'])}")
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
