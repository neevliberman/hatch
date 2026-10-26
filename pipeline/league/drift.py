#!/usr/bin/env python3
"""Model-drift alarm: is a species' model on the map going stale? Rule written 2026-10-26, before any 2027 data.

Analogy: a forecast can miss for two reasons. Either the weather it was told about was wrong (it was given a cool week
and got a heat wave), or it reads the weather wrongly (the moths no longer answer warmth the way it learned). Only the
second is drift. The archive tells them apart: late in the season the same frozen model is re-run every night on the
weather as it really was, so the strip's forecast issued once its window is over is the model's answer *in hindsight*.
1. Per scored strip (scorecard.json) and date (onset, peak): sealed miss = the scorecard's graded forecast - real;
   model part = hindsight forecast - real; weather part = sealed - model part (what the 7-day forecast and the
   typical-year endings got wrong).
2. Season bias B = the mean model part over the strips that have one (unweighted, as below).
3. Reference: the same model's leave-one-year-out replay (the replay file's `scores`: whole-season weather, each year
   fitted without itself), one bias per past year with at least MIN_STRIPS strips; its mean m and SD s.
4. Allowance: the live weather is PRISM, the replay's Daymet; on 2023-2025 that alone moved luna's peak 1.3 days
   earlier (pipeline/fit/SOUTH_BIAS.md), so SOURCE_DAYS = 1.5 is added to every threshold.
5. **Season alarm** when at least MIN_STRIPS strips have a model part, the reference has at least MIN_YEARS years,
   |B - m| > Z * s + SOURCE_DAYS, and at least AGREE of those strips miss on the same side of m as B.
   **Running alarm** (slow drift no single season shows) once two or more live seasons each have a B: their mean
   B_n against Z * s / sqrt(n) + SOURCE_DAYS.
6. An alarm decides nothing: it opens one GitHub issue saying a refit tryout is due before next season (the league's
   usual rules then apply). Strips whose own model part is beyond every past strip-year's are listed, never an alarm
   on their own (with ~30 past strip-years, about one in 30 new ones would be by chance).

Writes live/drift.json (this season per layer; earlier seasons kept under `past`). Run nightly by
pipeline/live/scorecard.py after the scorecard; cheap, no network except the issue.

Run: python3 pipeline/league/drift.py --card live/scorecard.json --archive live/archive --out live/drift.json
"""
import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from live import registry, scorecard as S  # noqa: E402

MIN_STRIPS = 3
MIN_YEARS = 5
Z = 2.0
AGREE = 2 / 3
SOURCE_DAYS = 1.5      # PRISM (live) vs Daymet (replay): see the module notes
SEED = HERE / "DRIFT_2026.json"   # the 2026 rehearsal season, so 2027 already has a season to run with
KINDS = ("onset", "peak")


def reference(replay):
    """The replay's leave-one-year-out season biases: {kind: {"years", "biases", "mean", "sd", "max_strip"}}."""
    by = {}
    for s in replay.get("scores") or []:
        by.setdefault(int(s["year"]), []).append(s)
    years = sorted(y for y, r in by.items() if len(r) >= MIN_STRIPS)
    out = {}
    for k in KINDS:
        b = [float(np.mean([s[f"heat_{k}"] - s[f"obs_{k}"] for s in by[y]])) for y in years]
        strip = [abs(s[f"heat_{k}"] - s[f"obs_{k}"]) for s in replay.get("scores") or []]
        out[k] = {"years": years, "biases": [round(v, 2) for v in b],
                  "mean": round(float(np.mean(b)), 2) if b else None,
                  "sd": round(float(np.std(b, ddof=1)), 2) if len(b) > 1 else None,
                  "max_strip": round(float(max(strip)), 1) if strip else None}
    return out


def hindsight(entries, model, season, cut):
    """The first archived forecast from the season's model whose weather runs to the strip's cut-off (its first-wave
    window is over, so no weather after it is guessed), or None."""
    end = S.doy_date(season, cut)
    for e in entries:
        if e["model"] == model and dt.date.fromisoformat(e["as_of"]) >= end:
            return e
    return None


def decompose(row, entries, model, season):
    """One scored strip: {kind: {sealed, model, weather}} plus the hindsight entry's issue date, or None without one."""
    e = hindsight(entries, model, season, row["cutoff"])
    f = next((b for b in (e or {}).get("bands", []) if b["band"] == row["band"]), None)
    if f is None or any(f.get(k) is None for k in KINDS):
        return None
    out = {"band": row["band"], "n": row["n"], "hindsight_issued": e["issued"]}
    for k in KINDS:
        sealed, part = row[k]["error"], round(f[k] - row[k]["real"], 1)
        out[k] = {"sealed": sealed, "model": part, "weather": round(sealed - part, 1)}
    return out


def plain(name, kind, b, ref, when):
    side = "late" if b > 0 else "early"
    return (f"{name}: even on the real weather, the {kind} forecast ran {abs(b):.1f} days {side} on average {when}, "
            f"against {ref['mean']:+.1f} ± {ref['sd']:.1f} days in its past seasons. The model may be going stale: "
            "a refit tryout is due before next season.")


def check_layer(name, layer, entries, replay, season, past_bias=None):
    """This season's drift check for one scorecard layer. past_bias: {kind: [B of each earlier live season]}."""
    ref = reference(replay)
    model = layer.get("model")
    rows = [r for r in layer.get("bands", []) if r.get("status") == "scored"]
    strips = [d for d in (decompose(r, entries, model, season) for r in rows) if d]
    out = {"model": model, "strips": strips, "reference": ref, "alarms": [], "beyond_past": []}
    for k in KINDS:
        parts = [s[k]["model"] for s in strips]
        r = ref[k]
        res = {"strips": len(parts), "bias": round(float(np.mean(parts)), 2) if parts else None,
               "weather": round(float(np.mean([s[k]["weather"] for s in strips])), 2) if strips else None}
        usable = len(r["years"]) >= MIN_YEARS and bool(r["sd"])
        if len(parts) < MIN_STRIPS or not usable:
            res["state"] = "too_few"
        else:
            dev = res["bias"] - r["mean"]
            agree = sum(np.sign(p - r["mean"]) == np.sign(dev) for p in parts) / len(parts)
            res["z"] = round(dev / r["sd"], 2)
            res["agree"] = round(float(agree), 2)
            res["threshold"] = round(Z * r["sd"] + SOURCE_DAYS, 2)
            res["state"] = "alarm" if abs(dev) > res["threshold"] and agree >= AGREE else "ok"
            if res["state"] == "alarm":
                out["alarms"].append(k)
                res["text"] = plain(name, k, res["bias"], r, "this season")
        seasons = [*(past_bias or {}).get(k, []), *([res["bias"]] if res["state"] != "too_few" else [])]
        if usable and len(seasons) >= 2:
            mb = float(np.mean(seasons))
            run_ = {"seasons": len(seasons), "bias": round(mb, 2),
                    "threshold": round(float(Z * r["sd"] / np.sqrt(len(seasons)) + SOURCE_DAYS), 2)}
            run_["state"] = "alarm" if abs(mb - r["mean"]) > run_["threshold"] else "ok"
            if run_["state"] == "alarm":
                out["alarms"].append(f"{k}/running")
                run_["text"] = plain(name, k, mb, r, f"over its last {len(seasons)} seasons")
            res["running"] = run_
        out[k] = res
        if r["max_strip"] is not None:
            out["beyond_past"] += [{"band": s["band"], "kind": k, "model": s[k]["model"]} for s in strips
                                   if abs(s[k]["model"]) > r["max_strip"]]
    return out


def open_issue(title, body):
    """One GitHub issue via the gh CLI, when the nightly job's token is there; True once it exists (or is opened)."""
    if not (os.environ.get("GH_TOKEN") and os.environ.get("GITHUB_REPOSITORY") and shutil.which("gh")):
        print(f"(no GitHub token here; would open issue: {title})")
        return False
    repo = os.environ["GITHUB_REPOSITORY"]
    found = subprocess.run(["gh", "issue", "list", "--repo", repo, "--state", "all", "--search", f'"{title}" in:title',
                            "--json", "title", "--jq", ".[].title"], capture_output=True, text=True, timeout=60)
    if found.returncode == 0 and title in found.stdout.splitlines():
        return True
    made = subprocess.run(["gh", "issue", "create", "--repo", repo, "--title", title, "--body", body],
                          capture_output=True, text=True, timeout=60)
    if made.returncode:
        print(f"::warning::could not open the drift issue: {made.stderr.strip()[-300:]}", flush=True)
        return False
    print(f"opened issue: {made.stdout.strip()}")
    return True


def issue_body(key, season, res, kind, running=False):
    s = res[kind]["running"] if running else res[kind]
    rows = "\n".join(f"| {d['band']} | {d['n']} | {d[kind]['sealed']:+.1f} | {d[kind]['model']:+.1f} | "
                     f"{d[kind]['weather']:+.1f} |" for d in res["strips"])
    return (f"{s['text']}\n\nSeason {season}, layer `{key}`, model `{res['model']['id']}` ({res['model']['hash']}). "
            f"Rule: pipeline/league/drift.py (threshold {s['threshold']} days).\n\n"
            f"| Strip | Records | Sealed miss | Model part (hindsight) | Weather part |\n|---|---|---|---|---|\n{rows}\n\n"
            f"Past seasons ({', '.join(map(str, res['reference'][kind]['years']))}): "
            f"{', '.join(f'{b:+.1f}' for b in res['reference'][kind]['biases'])} days.\n\n"
            "What to do: before 1 March, refit with this season added and run it as a tryout "
            "(pipeline/league/README.md); nothing on the map changes mid-season. Close this once that is decided.\n\n"
            "Opened automatically by the nightly scorecard job.")


def run(card_path: Path, archive: Path, out: Path, season, notify=True, seed=SEED):
    """Check every layer of the published scorecard; write `out`; open an issue for each alarm not yet raised."""
    card = S.read_card(card_path)
    if not card or card.get("season") != season:
        return None
    prev = S.read_card(out) or {}
    past = {}
    for src in (S.read_card(seed) if seed else None, prev):    # the seed first; the last published file wins
        src = src or {}
        past.update(src.get("past") or {})
        if src.get("season") not in (None, season):
            past[str(src["season"])] = src["layers"]
    past = {y: v for y, v in past.items() if int(y) < season}
    raised = (prev.get("raised") or {}) if prev.get("season") == season else {}
    layers = {}
    for key, layer in card["layers"].items():
        sp = registry.BY_KEY.get(key)
        if sp is None:
            continue
        earlier = {k: [l[key][k]["bias"] for _, l in sorted(past.items())
                       if key in l and l[key][k].get("state", "too_few") != "too_few"
                       and (l[key].get("model") or {}).get("hash") == (layer.get("model") or {}).get("hash")]
                   for k in KINDS}
        res = check_layer(sp.name, layer, S.load_archive(sp.archive(archive), season),
                          json.loads(sp.replay.read_text()), season, earlier)
        layers[key] = res
        for k in res["alarms"]:
            tag = f"{key}/{k}"
            if tag in raised or not notify:
                continue
            kind, _, running = k.partition("/")
            when = f"{min(int(y) for y in past)}-{season}" if running else str(season)
            if open_issue(f"Model drift: {sp.name} {kind} ({when})", issue_body(key, season, res, kind, bool(running))):
                raised[tag] = card["score_date"]
    doc = {"version": 1, "kind": "drift", "season": season, "score_date": card["score_date"],
           "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "rule": {"min_strips": MIN_STRIPS, "min_years": MIN_YEARS, "z": Z, "agree": round(AGREE, 3)},
           "layers": layers, "raised": raised, "past": past}
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False) + "\n")
    tmp.replace(out)
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--card", type=Path, required=True)
    ap.add_argument("--archive", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--season", type=int)
    ap.add_argument("--no-issue", action="store_true")
    a = ap.parse_args(argv)
    card = S.read_card(a.card) or {}
    doc = run(a.card, a.archive, a.out, a.season or card.get("season"), notify=not a.no_issue)
    if doc is None:
        raise SystemExit("no scorecard for that season")
    for key, res in doc["layers"].items():
        for k in KINDS:
            s = res[k]
            print(f"{key:16s} {k:5s} strips={s['strips']} model bias={s['bias']} weather={s['weather']} "
                  f"state={s['state']} z={s.get('z')} threshold={s.get('threshold')} running={s.get('running')}")


if __name__ == "__main__":
    main()
