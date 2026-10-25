#!/usr/bin/env python3
"""Tryout 2b (exploratory, written AFTER seeing R1's result, so not pre-registered): a local heat clock.

Analogy: instead of one recipe for the whole country ("bake at 350 for 30 min"), each kitchen keeps its own timer
setting from past years, and this year's oven temperature decides when it rings.

For each place (Midwest band or eastern 2 x 6 degree cell), its training years give the warmth (degree-days above
10 C since 1 March, P3's base and cap) piled up by the observed onset and peak. Forecast for a held-out year = the day
this year's warmth reaches that place's average pile. No curve shape is fitted, so nothing is shared across places;
the calendar handles "where", this year's weather handles "when".

Cold start (a place never seen): its warmth target comes from every other eastern cell, regressed on latitude.

    python3 pipeline/league/tryouts/clock.py           # needs results/regional_loyo_rows.csv (and _cold_rows.csv)
    python3 pipeline/league/tryouts/clock.py learning  # East: how many past seasons the clock needs (1, 2, 3, 5)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import regional as G  # noqa: E402

OUT = G.OUT


def heat(hx, w, yi):
    """Cumulative degree-days from 1 March for a weighted set of hexes, one value per day index from D0."""
    inc = G.R4.inc_cube((G.R4.BASE, G.R4.UPPER, 0))[hx, yi, G.D0:].astype(float)
    return (w[:, None] * np.cumsum(inc, axis=1)).sum(0)


def day_at(curve, dd):
    i = int(np.searchsorted(curve, dd))
    return float(G.D0 + min(i, len(curve) - 1))


def dd_at(curve, day):
    return float(np.interp(day - G.D0, np.arange(len(curve)), curve))


def cell_records(kind, cell, rec=None):
    rec = G.D.rec if rec is None else rec
    return rec[(rec.region == "mw") & (rec.band.astype(str) == cell)] if kind == "mw" else rec[rec.region == cell]


def fold_targets(year):
    """Training place-years for the fold that holds out `year`, built exactly as regional.loyo_fold builds its
    calendar (the fold's own brood cut-offs, >= 20 records): -> DataFrame set, cell, year, onset, peak."""
    rec = G.D.rec
    tr_all = rec[rec.year != year]
    mw_cuts, w_cuts = G.EV.cutoffs(tr_all[tr_all.region == "mw"]), G.R4._wide_cuts(tr_all)
    train = G.R4._with_cut(tr_all, mw_cuts, w_cuts)
    mw = train[train.region == "mw"]
    a = G.EV.targets(mw.assign(band=mw.band.astype(str))).rename(columns={"band": "cell"}).assign(set="mw")
    trw = train[train.region != "mw"]
    b = trw.groupby(["region", "year"]).t.agg(["size", lambda s: s.quantile(.1), "median"]).reset_index()
    b.columns = ["cell", "year", "n", "onset", "peak"]
    b = b[b.n >= G.EV.MIN_N].assign(set="east")
    return pd.concat([a, b], ignore_index=True), train


def loyo(d):
    out = []
    y0 = int(G.D.years[0])
    folds = {int(y): fold_targets(int(y)) for y in d.year.unique()}
    for r in d.itertuples():
        past, train = folds[int(r.year)]
        past = past[(past.set == r.set) & (past.cell == r.cell)]
        hx, w = G.EV.hex_weights(cell_records(r.set, r.cell, train))
        if len(past) == 0 or len(hx) == 0:
            out.append((np.nan, np.nan))
            continue
        tgt = {q: np.mean([dd_at(heat(hx, w, int(p.year) - y0), getattr(p, q)) for p in past.itertuples()])
               for q in ("onset", "peak")}
        cur = heat(hx, w, int(r.year) - y0)
        out.append((day_at(cur, tgt["onset"]), day_at(cur, tgt["peak"])))
    d = d.copy()
    d["clock_onset"], d["clock_peak"] = zip(*out)
    d["mix_onset"], d["mix_peak"] = (d.clock_onset + d.cal_onset) / 2, (d.clock_peak + d.cal_peak) / 2
    return d


def cold(c, east):
    """c: cold rows (one region hidden). Warmth targets of every OTHER eastern cell-year, regressed on latitude."""
    y0 = int(G.D.years[0])
    tg = []
    for r in east.itertuples():
        cr = G.D.rec[G.D.rec.region == r.cell]
        hx, w = G.EV.hex_weights(cr)
        cur = heat(hx, w, int(r.year) - y0)
        tg.append({"cell": r.cell, "lat": float((G.D.hex_lat[hx] * w).sum()),
                   "onset": dd_at(cur, r.onset), "peak": dd_at(cur, r.peak)})
    tg = pd.DataFrame(tg)
    out = []
    for r in c.itertuples():
        o = tg[tg.cell != r.cell]
        cr = G.D.rec[G.D.rec.region == r.cell]
        hx, w = G.EV.hex_weights(cr)
        cur = heat(hx, w, int(r.year) - y0)
        out.append(tuple(day_at(cur, np.polyval(np.polyfit(o.lat, o[q], 1), r.lat)) for q in ("onset", "peak")))
    c = c.copy()
    c["clock_onset"], c["clock_peak"] = zip(*out)
    return c


def learning(ks=(1, 2, 3, 5), seed=0):
    """East leave-one-year-out with only k past seasons (picked at random) for the clock and the calendar."""
    d = pd.read_csv(OUT / "regional_loyo_rows.csv").dropna(subset=["cal_onset"])
    d = d[d.set == "east"]
    y0 = int(G.D.years[0])
    folds = {int(y): fold_targets(int(y)) for y in d.year.unique()}
    rng = np.random.default_rng(seed)
    res = {}
    for k in ks:
        rows = []
        for r in d.itertuples():
            past, train = folds[int(r.year)]
            past = past[(past.set == "east") & (past.cell == r.cell)]
            if len(past) < k:
                continue
            past = past.iloc[rng.choice(len(past), k, replace=False)]
            hx, w = G.EV.hex_weights(cell_records("east", r.cell, train))
            cur = heat(hx, w, int(r.year) - y0)
            row = {"year": r.year, "onset": r.onset, "peak": r.peak, "one_onset": r.one_onset, "one_peak": r.one_peak}
            for q in ("onset", "peak"):
                tgt = np.mean([dd_at(heat(hx, w, int(p.year) - y0), getattr(p, q)) for p in past.itertuples()])
                row[f"clock_{q}"], row[f"cal_{q}"] = day_at(cur, tgt), past[q].mean()
            rows.append(row)
        x = pd.DataFrame(rows)
        res[f"past_{k}"] = {"n": len(x), **{m: round(G.mae(x, m), 2) for m in ("clock", "cal", "one")}}
        print(k, res[f"past_{k}"], flush=True)
    (OUT / "clock_learning.json").write_text(json.dumps(res, indent=1))


def main():
    G.load()
    res = {}
    d = pd.read_csv(OUT / "regional_loyo_rows.csv").dropna(subset=["cal_onset"])
    d = loyo(d)
    d.to_csv(OUT / "clock_loyo_rows.csv", index=False, float_format="%.2f")
    for s, g in d.groupby("set"):
        g = g.dropna(subset=["clock_onset"])
        res[f"loyo_{s}"] = {m: round(G.mae(g, m), 2) for m in ("cal", "r1", "clock", "mix")}
        res[f"loyo_{s}"]["n"] = len(g)
        res[f"loyo_{s}"]["clock_minus_cal_ci"] = [round(v, 2) for v in G.boot_diff(g, "clock", "cal")]
        res[f"loyo_{s}"]["mix_minus_cal_ci"] = [round(v, 2) for v in G.boot_diff(g, "mix", "cal")]
    cf = OUT / "regional_cold_rows.csv"
    if cf.exists():
        c = cold(pd.read_csv(cf), d[d.set == "east"])
        c.to_csv(OUT / "clock_cold_rows.csv", index=False, float_format="%.2f")
        res["cold"] = {m: round(G.mae(c, m), 2) for m in ("slid", "one", "r1", "clock")}
        res["cold"]["n"] = len(c)
        res["cold"]["clock_minus_slid_ci"] = [round(v, 2) for v in G.boot_diff(c, "clock", "slid")]
    (OUT / "clock_summary.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    if sys.argv[1:] == ["learning"]:
        G.load()
        learning()
    else:
        main()
