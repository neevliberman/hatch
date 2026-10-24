#!/usr/bin/env python3
"""Why the far south (37-39 N) is forecast early in 2026: every number in SOUTH_BIAS.md. No refit, no map change.

Uses the live pipeline's own inputs and code: the frozen fold fits (pipeline/replay/fold_fits.json), the effort
profile, the PRISM offsets and weather-day rule (pipeline/live), the strip mix (build_live.band_weights / band_reach)
and the model's sighting curve (fit.model.cell_sighting_share). Inputs, all cached in notebooks/data (gitignored):
- daymet/ (2015-2025 at the 551 map hexes, as build_live), prism_<year>.npz for 2023-2026 (rehearse.cached_prism);
- luna_replay_inat.parquet (the fit's iNaturalist pull, build_replay.fetch_luna) and luna_2026_rg.parquet (2026
  research grade, leadtime.season_records);
- moth_effort_2026.json (2026 moth records per day in IL / IN / OH, fetched here once).

Run: python3 pipeline/fit/south_bias.py   (writes pipeline/fit/results/south_bias.json, prints the same)
"""
import datetime as dt
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(ROOT / "pipeline"), str(ROOT / "notebooks")]

import h3  # noqa: E402
from fit import data as fdata, model as M  # noqa: E402
from hatch_p1 import inat  # noqa: E402
from hatch_p1.daymet import temperature_cube  # noqa: E402
from hatch_p1.degree_days import double_sine  # noqa: E402
from hatch_p1.prep import BAND_LABELS, clean  # noqa: E402
from live import build_live as L, sources  # noqa: E402

DATA = ROOT / "notebooks" / "data"
OUT = HERE / "results" / "south_bias.json"
YEARS = list(range(2015, 2026))
SOUTH = "37-39"
D15APR, D30APR = 104, 119          # day index of 15 and 30 April (non-leap; leap years are a day off, as Daymet)

replay = json.loads(L.REPLAY.read_text())
cells = replay["cells"]
ci = {c: i for i, c in enumerate(cells)}
ff = json.loads(L.FOLD_FITS.read_text())
SPEC = M.SPECS[ff["spec"]]
FOLDS = {int(y): (dict(f["params"], u=np.array([])), f["cuts"]) for y, f in ff["folds"].items()}
FLAT = {int(y): dict(v["p3_flat"]["params"], u=np.array([]))
        for y, v in json.loads((HERE / "results" / "loyo_params.json").read_text()).items()}
eff = json.loads((L.HERE / "effort_profile.json").read_text())
OFFSETS = np.array(json.loads((L.HERE / "prism_offsets.json").read_text())["offsets"])
clat = np.array([h3.cell_to_latlng(c)[0] for c in cells])
clng = np.array([h3.cell_to_latlng(c)[1] for c in cells])
EPROF = np.array(eff["profile"])[[eff["states"].index(s) for s in fdata.state_of(clat, clng)]]
CBAND = [BAND_LABELS[i] for i in L.band_index(clat)]
BW = L.band_weights(cells, replay["sightings"])
_, _, DMIN, DMAX = temperature_cube(cells, YEARS[0], YEARS[-1], DATA / "daymet")


# ---------------------------------------------------------------- weather and forecasts
def daymet(y):
    return DMIN[:, y - YEARS[0]].astype(float), DMAX[:, y - YEARS[0]].astype(float)


def prism(y):
    """Season y from PRISM as the live job reads it (weather days, Daymet offsets), 1 Mar to 30 Sep; zero after."""
    z = np.load(DATA / f"prism_{y}.npz")
    pmin, pmax = z["tmin"], z["tmax"]
    start = dt.date(y, 1, 1) + dt.timedelta(days=59)
    n = (dt.date(y, 9, 30) - start).days + 1
    if pmax.shape[1] < n + 1:                     # older caches stop at 30 Sep: its high is irrelevant in spring
        pmin, pmax = np.pad(pmin, ((0, 0), (0, 1)), mode="edge"), np.pad(pmax, ((0, 0), (0, 1)), mode="edge")
    pmin, pmax = sources.weather_days(pmin[:, :n + 1], pmax[:, :n + 1])
    months = np.array([d.month - 1 for d in sources.dates(start, dt.date(y, 9, 30))])
    tmin, tmax = np.zeros((len(cells), 365)), np.zeros((len(cells), 365))
    tmin[:, 59:59 + n] = L.fill_gaps(pmin + OFFSETS[:, months, 0])
    tmax[:, 59:59 + n] = L.fill_gaps(pmax + OFFSETS[:, months, 1])
    return tmin, tmax


def daily_dd(tmin, tmax):
    inc = double_sine(tmin, tmax, L.BASE, L.UPPER)
    inc[:, :L.START_DOY - 1] = 0
    return inc


def season_dd(y):
    """The weather the forecast is scored on: Daymet for fitted years, PRISM (live reading) for 2026."""
    return daily_dd(*(daymet(y) if y < 2026 else prism(y)))


def fits_for(y):
    return [y] if y in FOLDS else YEARS


def shares(inc, fy, params=None):
    p, cut = FOLDS[fy]
    spec = SPEC if params is None else M.SPECS["p3_flat"]
    return M.cell_sighting_share(p if params is None else params[fy], spec, inc,
                                 clat, np.array([cut[b] - 1 for b in CBAND]), EPROF)


def strip_dates(inc, fys, w=BW, params=None):
    """[strip, (onset, peak)] doy: median over the fits of the strip's 10% / 50% day (as build_live's bands)."""
    return np.median(np.array([L.band_reach(shares(inc, fy, params), w) for fy in fys], float), 0)


def hex_peaks(inc, fys):
    """Each hex's 50% day, median over the fits."""
    return np.nanmedian(np.array([[L.first_reach(s, [0.5])[0] or np.nan for s in shares(inc, fy)] for fy in fys], float), 0)


def strip_dd(c, b, day):
    w = BW[BAND_LABELS.index(b)]
    return float((w * c[:, day]).sum() / w.sum())


# ---------------------------------------------------------------- records
def first_wave_records():
    raw = pd.read_parquet(DATA / "luna_replay_inat.parquet")
    r26 = pd.read_parquet(DATA / "luna_2026_rg.parquet")
    d = pd.concat([clean(raw), clean(r26, years=(2026, 2026))])
    d = d[d.doy >= 60].copy()
    d["band"] = d.band.astype(str)
    d["state"] = fdata.state_of(d.lat.to_numpy(), d.lng.to_numpy())
    cuts = {b["label"]: min(b["cutoff"] or 240, 240) for b in replay["bands"]}
    return d, d[d.doy <= d.band.map(cuts)].copy(), cuts


def weights_from(rec):
    w = np.zeros_like(BW)
    for h, n in rec.hex.value_counts().items():
        if h in ci:
            w[L.band_index(clat[ci[h]]), ci[h]] += n
    return w


def effort_2026(states=("IL", "IN", "OH")):
    path = DATA / "moth_effort_2026.json"
    if path.exists():
        return json.loads(path.read_text())
    out = {}
    for st in states:
        js = inat._get("observations/histogram", {
            "taxon_id": fdata.LEPIDOPTERA, "without_taxon_id": fdata.BUTTERFLIES, "place_id": fdata.STATE_PLACES[st],
            "date_field": "observed", "interval": "day", "verifiable": "true", "d1": "2026-01-01", "d2": "2026-12-31"})
        out[st] = {k[:10]: v for k, v in js["results"]["day"].items()}
        time.sleep(1)
    path.write_text(json.dumps(out))
    return out


# ---------------------------------------------------------------- the checks
def main():
    R = {}
    allr, fw, cuts = first_wave_records()
    real = {(b, int(y)): (float(np.quantile(g.doy, .1)), float(np.median(g.doy)), len(g))
            for (b, y), g in fw.groupby(["band", "year"]) if len(g) >= 20}

    # 1. specific to 2026? replay's leave-one-year-out scores vs this season, same strip
    loyo = [s for s in replay["scores"] if s["band"] == SOUTH]
    R["loyo_south"] = {"peak_errors": [round(s["heat_peak"] - s["obs_peak"], 1) for s in loyo],
                       "onset_errors": [round(s["heat_onset"] - s["obs_onset"], 1) for s in loyo]}
    R["loyo_south"]["mean_peak"] = round(float(np.mean(R["loyo_south"]["peak_errors"])), 1)
    R["loyo_south"]["mean_onset"] = round(float(np.mean(R["loyo_south"]["onset_errors"])), 1)

    # strip-years: forecast, real, banked warmth
    inc_by, rows = {}, []
    for y in YEARS + [2026]:
        inc = inc_by[y] = season_dd(y)
        c = np.cumsum(inc, 1)
        fc = strip_dates(inc, fits_for(y))
        for B, b in enumerate(BAND_LABELS):
            row = {"band": b, "year": y, "fc_onset": fc[B, 0], "fc_peak": fc[B, 1],
                   "dd15apr": round(strip_dd(c, b, D15APR), 1), "dd30apr": round(strip_dd(c, b, D30APR), 1)}
            if (b, y) in real:
                o, p, n = real[(b, y)]
                row.update(real_onset=o, real_peak=p, n=n)
                for s0, lab in ((59, "mar1"), (90, "apr1"), (105, "apr15")):
                    cc = np.cumsum(np.where(np.arange(365) >= s0, inc, 0), 1)
                    row[f"dd_at_peak_from_{lab}"] = round(strip_dd(cc, b, int(p) - 1), 1)
            rows.append(row)
    sy = pd.DataFrame(rows)
    s26 = sy[(sy.band == SOUTH) & (sy.year == 2026)].iloc[0]
    R["south_2026"] = {"forecast": [s26.fc_onset, s26.fc_peak], "real": [s26.real_onset, s26.real_peak],
                       "peak_error": s26.fc_peak - s26.real_peak, "onset_error": round(s26.fc_onset - s26.real_onset, 1)}
    R["warmth"] = {b: {"dd15apr_2015_2025": [float(sy[(sy.band == b) & (sy.year < 2026)].dd15apr.min()),
                                             float(sy[(sy.band == b) & (sy.year < 2026)].dd15apr.max())],
                       "dd15apr_2026": float(sy[(sy.band == b) & (sy.year == 2026)].dd15apr.iloc[0]),
                       "dd30apr_2015_2025": [float(sy[(sy.band == b) & (sy.year < 2026)].dd30apr.min()),
                                             float(sy[(sy.band == b) & (sy.year < 2026)].dd30apr.max())],
                       "dd30apr_2026": float(sy[(sy.band == b) & (sy.year == 2026)].dd30apr.iloc[0])} for b in BAND_LABELS}
    sc = sy.dropna(subset=["real_peak"])
    sc = sc[(sc.band == SOUTH) & (sc.year < 2026)]
    R["dd_at_peak_spread_south"] = {lab: round(float(sc[f"dd_at_peak_from_{lab}"].std() / sc[f"dd_at_peak_from_{lab}"].mean()), 2)
                                    for lab in ("mar1", "apr1", "apr15")}
    m39 = sy[(sy.band == "39-41") & (sy.year == 2026)].iloc[0]
    R["middle_2026"] = {"peak_error": m39.fc_peak - m39.real_peak}

    # 2. few records / one metro, and target noise
    g = fw[(fw.year == 2026) & (fw.band == SOUTH)]
    vc = g.hex.value_counts()
    groups = [x.doy.to_numpy() for _, x in g.groupby("user_id")]
    rng = np.random.default_rng(0)
    boot = [np.median(np.concatenate([groups[k] for k in rng.integers(0, len(groups), len(groups))])) for _ in range(2000)]
    R["records_2026"] = {"n": len(g), "observers": int(g.user_id.nunique()), "hexes": int(g.hex.nunique()),
                         "top_hex": int(vc.iloc[0]), "top_hex_state": str(g[g.hex == vc.index[0]].state.iloc[0]),
                         "peak_without_top_hex": float(np.median(g[g.hex != vc.index[0]].doy)),
                         "peak_bootstrap_sd": round(float(np.std(boot)), 1),
                         "peak_bootstrap_95": [float(v) for v in np.percentile(boot, [2.5, 97.5])],
                         "peak_by_state": {s: float(np.median(x.doy)) for s, x in g.groupby("state")},
                         "share_by_15apr": {int(y): round(float((x.doy <= 105).mean()), 2)
                                            for y, x in fw[fw.band == SOUTH].groupby("year") if len(x) >= 20},
                         "pulses": {"days_91_110": int(g.doy.between(91, 110).sum()),
                                    "days_111_120": int(g.doy.between(111, 120).sum()),
                                    "days_121_160": int(g.doy.between(121, 160).sum())}}

    # 3. second brood mixed in
    a26 = allr[(allr.year == 2026) & (allr.band == SOUTH)]
    R["second_brood"] = {"cutoff": cuts[SOUTH], "first_wave_after_157": int((g.doy > 157).sum()),
                         "bins_10d_from_150": np.histogram(a26.doy, bins=range(150, 231, 10))[0].tolist(),
                         "peak_if_cut_at": {c: float(np.median(g[g.doy <= c].doy)) for c in (150, 160, cuts[SOUTH])}}

    # 4. daylength term: the same folds' no-daylength fits
    inc26 = inc_by[2026]
    R["photoperiod"] = {"p3": strip_dates(inc26, YEARS)[0, 1], "no_daylength": strip_dates(inc26, YEARS, params=FLAT)[0, 1]}

    # 5. PRISM vs Daymet, years both exist
    R["prism_vs_daymet"] = {y: {"daymet": strip_dates(daily_dd(*daymet(y)), [y])[0, 1],
                                "prism": strip_dates(daily_dd(*prism(y)), [y])[0, 1]} for y in (2023, 2024, 2025)}

    # 6. strip weighting
    R["weighting"] = {"open_licence_replay": R["photoperiod"]["p3"],
                      "all_records_2015_2025": strip_dates(inc26, YEARS, w=weights_from(fw[fw.year < 2026]))[0, 1],
                      "own_2026_hexes": strip_dates(inc26, YEARS, w=weights_from(fw[fw.year == 2026]))[0, 1]}

    # 7. effort: April vs May moth records in 2026 against the typical shape
    e26 = effort_2026()
    R["effort_april_may"] = {}
    for st, days in e26.items():
        v = np.ones(366)
        for k, n in days.items():
            v[dt.date.fromisoformat(k).timetuple().tm_yday - 1] += n
        prof = np.array(eff["profile"][eff["states"].index(st)])
        R["effort_april_may"][st] = {"2026": round(float(v[90:120].sum() / v[120:151].sum()), 2),
                                     "typical": round(float(prof[90:120].sum() / prof[120:151].sum()), 2)}

    # 8. beyond the fitted range, place by place
    parts = []
    fwh = fw[fw.hex.isin(ci)].copy()
    fwh["i"] = fwh.hex.map(ci)
    for y in YEARS + [2026]:
        x = fwh[fwh.year == y].copy()
        c = np.cumsum(inc_by[y], 1)
        x["fc"] = hex_peaks(inc_by[y], fits_for(y))[x.i]
        x["dd15"] = c[x.i, D15APR]
        parts.append(x)
    hx = pd.concat(parts)
    hx["res"] = hx.doy - hx.fc
    past = hx[hx.year < 2026]
    now = hx[(hx.year == 2026) & hx.band.isin(["37-39", "39-41", "41-43"])]
    bins = [0, 50, 100, 150, 200, 250, 400]
    R["by_warmth"] = {
        "past_max_dd15": round(float(past.dd15.max())),
        "south_2026_above_past_max": [int((hx[(hx.year == 2026) & (hx.band == SOUTH)].dd15 > past.dd15.max()).sum()),
                                      int(((hx.year == 2026) & (hx.band == SOUTH)).sum())],
        "past_residual_median_by_bin": {str(k): float(v) for k, v in
                                        past[past.band.isin(["37-39", "39-41", "41-43"])].groupby(pd.cut(past.dd15, bins), observed=True).res.median().items()},
        "2026_residual_median_by_bin": {str(k): float(v) for k, v in now.groupby(pd.cut(now.dd15, bins), observed=True).res.median().items()},
        "2026_residual_n_by_bin": {str(k): int(v) for k, v in now.groupby(pd.cut(now.dd15, bins), observed=True).res.size().items()},
        "past_earliest_hex_peak": float(past.fc.min()),
        "south_2026_hex_peaks": [float(hx[(hx.year == 2026) & (hx.band == SOUTH)].fc.min()),
                                 float(hx[(hx.year == 2026) & (hx.band == SOUTH)].fc.max())]}
    cal = np.mean([s["obs_peak"] for s in loyo])
    R["half_calendar_mix_post_hoc"] = {"calendar_peak": round(float(cal), 1),
                                       "mix": round(float((R["photoperiod"]["p3"] + cal) / 2), 1)}
    sy.to_csv(HERE / "results" / "south_bias_strip_years.csv", index=False)
    OUT.write_text(json.dumps(R, indent=1, default=float) + "\n")
    print(json.dumps(R, indent=1, default=float))
    return 0


if __name__ == "__main__":
    sys.exit(main())
