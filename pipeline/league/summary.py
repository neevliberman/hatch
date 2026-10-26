#!/usr/bin/env python3
"""The app's view of the league: a small `league` block added to the published scorecard (live/scorecard.json), which
the About panel already loads (src/ui/scorecard.ts). The site is deployed with only a few files from the live-data
branch, so the tryouts ride in that one rather than in files of their own.

Per species layer: each tryout this season or next (bench.py, plus the eastern heat clock, east.py), with where it
stands in this week's tables (live/league.json, live/league_east.json), and the drift check's state (live/drift.json).
Read only; nothing here grades or decides. Run nightly by pipeline/live/scorecard.py, last.

Run: python3 pipeline/league/summary.py --card live/scorecard.json --live live
     (main's public/live/scorecard.json, the 2026 rehearsal, is built with --drift pipeline/league/DRIFT_2026.json)
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from league import bench, east  # noqa: E402
from live import scorecard as S  # noqa: E402

# Plain names for the panel; a challenger missing here shows the part of its `why` before the colon.
NAMES = {"p3.1-v1": "Simpler warmth model", "p3-a1-v1": "Warm-spring guard", "east": "Eastern heat clock"}
RANK = {"too_few": 0, "ok": 1, "watch": 2, "alarm": 3}
EAST_SPECIES = "luna"   # the eastern heat clock is built from luna moth records (build_east.py)


def _num(x):
    return round(float(x), 1) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def tryouts(live: Path, season):
    """{layer key: [row]} for every tryout playing this season or starting next season."""
    table = S.read_card(live / "league.json") or {}
    rows_now = {}
    if table.get("season") == season:
        for key, layer in (table.get("layers") or {}).items():
            for r in (layer or {}).get("challengers") or []:
                if isinstance(r, dict):
                    rows_now[f"{key}~{r.get('id')}"] = r
    out = {}
    for c in bench.BENCH:
        if not c.first_season <= season + 1 or c.verdict.year < season:
            continue
        r = rows_now.get(c.slug) or {}
        t = r.get("tally") or {}
        out.setdefault(c.species, []).append({
            "id": c.id, "name": NAMES.get(c.id, c.why.split(":")[0]), "against": "map",
            "report_only": c.gate == "report-only", "first_season": c.first_season,
            "verdict_date": c.verdict.isoformat(),
            "status": r.get("verdict") or ("upcoming" if c.first_season > season else "in_progress"),
            "strips": t.get("strips"), "D": _num(t.get("D")), "wins": t.get("wins"), "takes_map": r.get("takes_map")})
    if season in east.SEASONS or season + 1 in east.SEASONS:
        e = S.read_card(live / "league_east.json") or {}
        e = e if e.get("season") == season else {}
        t = e.get("tally") or {}
        out.setdefault(EAST_SPECIES, []).append({
            "id": "east", "name": NAMES["east"], "against": "usual", "report_only": False,
            "first_season": min(east.SEASONS), "verdict_date": east.VERDICT.isoformat(),
            "status": e.get("verdict") or ("upcoming" if min(east.SEASONS) > season else "in_progress"),
            "strips": t.get("places"), "D": _num(t.get("D")), "wins": t.get("clock_wins"), "takes_map": None})
    return out


def drift_states(doc, season):
    """{layer key: "ok" | "watch" | "alarm"} from a drift file of this season (the worst of onset, peak and running)."""
    if not doc or doc.get("season") != season:
        return {}
    out = {}
    for key, layer in (doc.get("layers") or {}).items():
        states = [s for k in ("onset", "peak") for s in ((layer or {}).get(k) or {}, ((layer or {}).get(k) or {}).get("running") or {})]
        worst = max((RANK.get(s.get("state"), 0) for s in states), default=0)
        if worst:
            out[key] = next(k for k, v in RANK.items() if v == worst)
    return out


def block(live: Path, season, drift_path: Path | None = None):
    states = drift_states(S.read_card(drift_path or live / "drift.json"), season)
    tries = tryouts(live, season)
    return {"season": season, "layers": {k: {"tryouts": tries.get(k, []), "drift": states.get(k)}
                                         for k in sorted(set(tries) | set(states))}}


def attach(card_path: Path, live: Path, drift_path: Path | None = None):
    """Add the `league` block to the published scorecard, in place. -> the block, or None if there is no card."""
    card = S.read_card(card_path)
    if not card or not isinstance(card.get("season"), int):
        return None
    card["league"] = block(live, card["season"], drift_path)
    tmp = card_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(card, separators=(",", ":"), allow_nan=False))
    tmp.replace(card_path)
    return card["league"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--card", type=Path, required=True)
    ap.add_argument("--live", type=Path, required=True)
    ap.add_argument("--drift", type=Path, help="the drift file (default: <live>/drift.json)")
    a = ap.parse_args(argv)
    print(json.dumps(attach(a.card, a.live, a.drift), indent=1))


if __name__ == "__main__":
    main()
