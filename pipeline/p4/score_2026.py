#!/usr/bin/env python3
"""Supporting test 4 (FROZEN_P4.md): the 2026 season, which no fit has seen.

Each candidate is fitted once on all of 2015-2025 (its own training region), then forecasts 2026 with PRISM weather
(fetch_2026.py) and the typical effort shape, and is scored on 2026's first-brood records exactly like a held-out
year: Midwest band-years (P3's bands) and eastern cell-years, >= 20 records each.

    python3 pipeline/p4/score_2026.py --cands c0 c1 ...
"""
import argparse
import json
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from p4 import model4 as M4, run_p4 as R, wide as W  # noqa: E402
from p4.fetch_2026 import OUT as PRISM  # noqa: E402
from fit import data as FD, evaluate as EV  # noqa: E402
from hatch_p1.degree_days import accumulate  # noqa: E402
from hatch_p1.model import predict_empirical  # noqa: E402
from hatch_p1.prep import BANDS, BAND_LABELS  # noqa: E402


def prism_cube(hexes):
    """tmin/tmax [hex, 1, 365] for 2026 (NaN where a hex has no file; gaps interpolated)."""
    tn = np.full((len(hexes), 1, 365), np.nan)
    tx = tn.copy()
    for i, h in enumerate(hexes):
        f = PRISM / f"{h}.npz"
        if not f.exists():
            continue
        z = np.load(f)
        for arr, out in ((z["tmin"], tn), (z["tmax"], tx)):
            a = pd.Series(arr).interpolate(limit_direction="both").to_numpy()
            out[i, 0, :len(a)] = a
            out[i, 0, len(a):] = a[-1]
    return tn, tx


def records_2026():
    raw = W.fetch_records()
    d = W.clean_wide(raw, years=(2026, 2026))
    d = d[d.doy <= 240].copy()
    paths = FD._state_paths()
    pts = np.column_stack([d.lng.to_numpy(float), d.lat.to_numpy(float)])
    inside = np.zeros(len(d), bool)
    for ps in paths.values():
        for p in ps:
            inside |= p.contains_points(pts)
    d["region"] = np.where(inside, "mw", W.region_cell(d.lat, d.lng))
    d["band"] = pd.cut(d.lat, BANDS, labels=BAND_LABELS, right=False).astype(object)
    d.loc[~inside, "band"] = None
    d = d[(d.region != "mw") | d.band.notna()]
    d["t"] = d.yday - 1
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cands", nargs="+", default=["c0"])
    a = ap.parse_args()
    R.D = R.load()
    rec = R.D.rec
    mw_cuts = EV.cutoffs(rec[rec.region == "mw"])
    w_cuts = R._wide_cuts(rec)
    allfb = R._with_cut(rec, mw_cuts, w_cuts)
    t26 = records_2026()
    t26 = t26.assign(cutdoy=np.where(t26.region == "mw", t26.band.map(mw_cuts).fillna(240),
                                     t26.region.map(w_cuts).fillna(240)).astype(int))
    t26 = t26[t26.doy <= t26.cutdoy]
    tn, tx = prism_cube(R.D.hexes)
    have = ~np.isnan(tn[:, 0, 0])
    tmean = (tn + tx) / 2
    chill26 = tmean[:, 0, :59].mean(-1) - ((R.D.tmin + R.D.tmax) / 2)[:, :, :59].mean(-1).mean(1)
    tr_years = list(range(len(R.D.years)))
    out = {}
    for cname in a.cands:
        cand = R.CANDS[cname]
        f = R.CACHE / f"full_{cname}.pkl"
        if f.exists():
            key, ft = pickle.loads(f.read_bytes())
        else:
            train = allfb if cand.region == "wide" else allfb[allfb.region == "mw"]
            grid = R.dd_grid(cand) or [(b, R.UPPER, 0) for b in (6.0, 8.0, 10.0, 12.0)]
            fits = {k: R.fit_cand(cand, train, k) for k in grid}
            if cand.dd and cand.dd[0] == "thresh":
                bb = min(fits, key=lambda k: fits[k].nll)[0]
                fits.update({(bb, u, 0): R.fit_cand(cand, train, (bb, u, 0)) for u in (24.0, 27.0, 33.0)})
            key = min(fits, key=lambda k: fits[k].nll)
            ft = fits[key]
            f.write_bytes(pickle.dumps((key, ft)))
        base, upper, tau = key
        tn2, tx2 = (tn, tx) if tau == 0 else (R.ema(tn, tau), R.ema(tx, tau))
        inc26 = np.diff(accumulate(tn2, tx2, base, upper), axis=-1, prepend=0)
        cum26 = np.cumsum(np.diff(accumulate(tn, tx, R.BASE, R.UPPER), axis=-1, prepend=0), -1)
        E = R.D.E_state if cand.effort == "state" else R.D.E_grid
        eprof = EV.effort_profile(E, tr_years)
        p = ft.without_year()
        rows = []
        p1cum = np.cumsum(R.inc_cube((R.BASE, R.UPPER, 0)), -1)
        for (reg, band), g in t26.groupby([t26.region, t26.band.fillna("")]):
            if len(g) < EV.MIN_N:
                continue
            ref = allfb[(allfb.region == reg) & ((allfb.band == band) if reg == "mw" else True)]
            if cand.region == "mw" and reg != "mw":
                continue
            hx, w = EV.hex_weights(ref)
            ok = have[hx]
            hx, w = hx[ok], w[ok] / w[ok].sum()
            cut = (mw_cuts[band] if reg == "mw" else w_cuts.get(reg, 240)) - 1
            ep = eprof[R.D.hex_state[hx]] if cand.effort == "state" else eprof[R.D.hex_eg[hx]]
            o, pk = M4.predict_cell(p, ft.spec, inc26[hx, 0, :], R.D.hex_lat[hx], chill26[hx], w,
                                    np.full(len(hx), cut), ep)
            p1tr = p1cum[ref.h, ref.y, ref.t]
            po, pp = predict_empirical(cum26, hx, w, 0, p1tr)
            tg = EV.targets(ref.assign(band="x"))
            co, cp = (tg.onset.mean(), tg.peak.mean()) if len(tg) else (np.nan, np.nan)
            rows.append({"set": "mw" if reg == "mw" else "east", "cell": band if reg == "mw" else reg, "year": 2026,
                         "n": len(g), "onset": g.t.quantile(.1), "peak": g.t.median(), "m_onset": o, "m_peak": pk,
                         "p1_onset": int(po), "p1_peak": int(pp), "cal_onset": co, "cal_peak": cp,
                         "dd_apr15": float((cum26[hx, 0, 104] * w).sum())})
        pd.DataFrame(rows).to_csv(R.RESULTS / f"rows2026_{cname}.csv", index=False, float_format="%.2f")
        out[cname] = R.score(rows)
        print(cname, key, json.dumps(out[cname]), flush=True)
    s = json.loads((R.RESULTS / "summary.json").read_text()) if (R.RESULTS / "summary.json").exists() else {}
    for c, v in out.items():
        s[f"2026_{c}"] = v
    (R.RESULTS / "summary.json").write_text(json.dumps(s, indent=1))


if __name__ == "__main__":
    main()
