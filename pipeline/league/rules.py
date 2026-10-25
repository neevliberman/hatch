"""The promotion rule: when a challenger has earned the map. Written before any season it judges; pure and tested.

It is PREREG_2027.md's decision rule for P3 vs P3.1, word for word, and the same rule serves every later challenger:
- Only strips scored for BOTH models count (same records, same `n`), each strip's miss as the scorecard rounds it.
- Headline miss = strips' misses averaged with weights n. D = challenger's headline minus champion's (negative = the
  challenger was closer).
- Challenger wins: D <= -1.0 day AND a strictly lower miss in at least 3 strips AND its gate passed.
- Champion wins: D >= +1.0 day (the challenger is retired).
- No verdict: fewer than 3 strips or 150 records scored for both.
- Tie: anything else. The map keeps the champion. A tie is not evidence the models are equal.
- Before the verdict date everything is "in progress": the same numbers are shown, nothing is decided.

Why 1.0 day: across the 9 past leave-one-year-out seasons the season-level D between two P3-family models has an SD
of about 0.32 day (PREREG_2027.md), so noise alone rarely reaches 1 day.
"""
from dataclasses import dataclass

MARGIN = 1.0
MIN_WINS = 3
MIN_STRIPS = 3
MIN_RECORDS = 150


@dataclass(frozen=True)
class Strip:
    band: str
    n: int                 # first-wave records behind the strip's real dates (the same for both models)
    champion: float        # champion's miss, days, as the scorecard rounds it
    challenger: float


def head_to_head(champ_rows, chall_rows):
    """Strips scored for both models, from two scorecard layers' rows. A strip whose `n` differs between the two
    means they were graded on different records, which the rule forbids: that raises."""
    a = {r["band"]: r for r in champ_rows if r.get("status") == "scored"}
    b = {r["band"]: r for r in chall_rows if r.get("status") == "scored"}
    out = []
    for band in sorted(set(a) & set(b)):
        if a[band]["n"] != b[band]["n"]:
            raise ValueError(f"strip {band}: n {a[band]['n']} vs {b[band]['n']}; the two models were not graded on the same records")
        out.append(Strip(band, int(a[band]["n"]), float(a[band]["miss"]), float(b[band]["miss"])))
    return out


def tally(strips):
    """The numbers the rule reads."""
    total = sum(s.n for s in strips)
    if not strips or total == 0:
        return {"strips": len(strips), "records": total, "champion": None, "challenger": None, "D": None,
                "wins": 0, "losses": 0}
    hc = sum(s.n * s.champion for s in strips) / total
    hx = sum(s.n * s.challenger for s in strips) / total
    return {"strips": len(strips), "records": total, "champion": round(hc, 2), "challenger": round(hx, 2),
            "D": round(hx - hc, 6),          # rounding only clears float dust: -1.0 must be -1.0
            "wins": sum(s.challenger < s.champion for s in strips),
            "losses": sum(s.challenger > s.champion for s in strips)}


def decide(strips, final, gate_passed):
    """-> (verdict, reason). verdict: in_progress / no_verdict / challenger_wins / champion_wins / tie.
    gate_passed: True / False / None (not yet known: then the challenger cannot win)."""
    t = tally(strips)
    if not final:
        return "in_progress", "the season's verdict date has not come; nothing is decided"
    if t["strips"] < MIN_STRIPS or t["records"] < MIN_RECORDS:
        return "no_verdict", f"{t['strips']} strips and {t['records']} records scored for both (need {MIN_STRIPS} and {MIN_RECORDS})"
    if t["D"] >= MARGIN:
        return "champion_wins", f"D = {t['D']:+.2f} d: the challenger was at least {MARGIN:g} day worse; it is retired"
    if t["D"] <= -MARGIN and t["wins"] >= MIN_WINS:
        if gate_passed is True:
            return "challenger_wins", f"D = {t['D']:+.2f} d with {t['wins']} strips won: it takes the map next season"
        return "tie", f"D = {t['D']:+.2f} d with {t['wins']} strips won, but its gate {'failed' if gate_passed is False else 'is not settled'}"
    return "tie", f"D = {t['D']:+.2f} d, {t['wins']} strips won (needs D <= -{MARGIN:g} and {MIN_WINS} strips): the champion stays"
