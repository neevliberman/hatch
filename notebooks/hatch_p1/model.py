"""The four baselines from build-plan-v2 P1, scored leave-one-year-out on dates.

Shapes: dd[hex, year, day] is cumulative degree-days (day 0 = 1 Jan).
A "record" is one deduplicated sighting with hex index h, year index y, day index t.
"""
import numpy as np
import pandas as pd
from scipy.stats import norm

from .degree_days import accumulate

Q_ONSET, Q_PEAK = 0.10, 0.50
MIN_N = 20


def dd_cube(tmin, tmax, base, upper=30.0):
    return accumulate(tmin, tmax, base, upper).astype(np.float32)


def targets(rec, min_n=MIN_N):
    """Observed onset (10th pct) and peak (median) day per band-year."""
    g = rec.groupby(["band", "year"], observed=True)["t"]
    out = pd.DataFrame({"n": g.size(), "onset": g.quantile(Q_ONSET), "peak": g.quantile(Q_PEAK)})
    return out[out["n"] >= min_n].reset_index()


def noise_floor(rec, tg, draws=500, seed=0):
    """Bootstrap SD of each band-year's onset and peak: how well the target itself is known."""
    rng = np.random.default_rng(seed)
    sd = []
    for _, r in tg.iterrows():
        t = rec[(rec.band == r.band) & (rec.year == r.year)]["t"].to_numpy()
        b = rng.choice(t, (draws, len(t)))
        sd.append((np.quantile(b, Q_ONSET, axis=1).std(), np.quantile(b, Q_PEAK, axis=1).std()))
    tg = tg.copy()
    tg[["sd_onset", "sd_peak"]] = sd
    return tg


# ---- heat model: sightings spread around mu degree-days with spread sigma ----

def dd_at_sightings(rec, dd):
    return dd[rec["h"].to_numpy(), rec["y"].to_numpy(), rec["t"].to_numpy()]


def fit_heat(rec, dd):
    """mu, sigma of degree-days at the training sightings (robust: median, IQR)."""
    q25, q50, q75 = np.percentile(dd_at_sightings(rec, dd), [25, 50, 75])
    return q50, max((q75 - q25) / 1.349, 1.0)


def predict_empirical(dd, hexes, weights, y, train_dd):
    """Exploratory, NOT a frozen baseline: like predict_heat, but the bell curve
    is replaced by the actual (skewed) spread of degree-days at training sightings."""
    srt = np.sort(train_dd)
    cdf = np.searchsorted(srt, dd[hexes, y, :], side="right") / len(srt)
    share = (weights[:, None] * cdf).sum(0)
    return np.searchsorted(share, Q_ONSET), np.searchsorted(share, Q_PEAK)


def predict_heat(dd, hexes, weights, y, mu, sigma):
    """Day when the hex-weighted share of sightings crosses 10% and 50%.

    share(t) = sum_h w_h * Phi((DD_h(t) - mu) / sigma): each hex contributes
    the fraction of its moths that have 'cashed in' by day t.
    """
    share = (weights[:, None] * norm.cdf((dd[hexes, y, :] - mu) / sigma)).sum(0)
    return np.searchsorted(share, Q_ONSET), np.searchsorted(share, Q_PEAK)


def predict_rule(dd, hexes, weights, y, target):
    """Published rule: the day the hex-weighted degree-days reach `target` (a peak)."""
    share = (weights[:, None] * (dd[hexes, y, :] >= target)).sum(0)
    return np.searchsorted(share, Q_PEAK)


def _band_weights(train, band):
    w = train[train.band == band]["h"].value_counts()
    return w.index.to_numpy(), (w / w.sum()).to_numpy()


def heat_predictions(rec, tg, dd, years):
    """(c)-style predictions for every scored band-year, leave-one-year-out."""
    rows = []
    for yr in sorted(tg.year.unique()):
        train = rec[rec.year != yr]
        mu, sig = fit_heat(train, dd)
        for _, r in tg[tg.year == yr].iterrows():
            hx, w = _band_weights(train, r.band)
            o, p = predict_heat(dd, hx, w, int(np.where(years == yr)[0][0]), mu, sig)
            rows.append((r.band, yr, o, p, mu, sig))
    return pd.DataFrame(rows, columns=["band", "year", "onset_pred", "peak_pred", "mu", "sigma"])


def empirical_predictions(rec, tg, dd, years):
    """Exploratory skew-aware heat model, leave-one-year-out (base fixed)."""
    rows = []
    for yr in sorted(tg.year.unique()):
        train = rec[rec.year != yr]
        x = dd_at_sightings(train, dd)
        for _, r in tg[tg.year == yr].iterrows():
            hx, w = _band_weights(train, r.band)
            o, p = predict_empirical(dd, hx, w, int(np.where(years == yr)[0][0]), x)
            rows.append((r.band, yr, o, p))
    return pd.DataFrame(rows, columns=["band", "year", "onset_pred", "peak_pred"])


def calendar_predictions(tg):
    """(a) the band's mean onset/peak in the other scored years."""
    rows = []
    for _, r in tg.iterrows():
        o = tg[(tg.band == r.band) & (tg.year != r.year)]
        if len(o):
            rows.append((r.band, r.year, o.onset.mean(), o.peak.mean()))
    return pd.DataFrame(rows, columns=["band", "year", "onset_pred", "peak_pred"])


def _mae(tg, pred):
    m = tg.merge(pred, on=["band", "year"])
    e_on, e_pk = (m.onset_pred - m.onset).abs(), (m.peak_pred - m.peak).abs()
    return m.assign(err_onset=e_on, err_peak=e_pk)


def score(tg, pred):
    m = _mae(tg, pred)
    return {"n_band_years": len(m), "mae_onset": m.err_onset.mean(), "mae_peak": m.err_peak.mean(),
            "mae": (m.err_onset.mean() + m.err_peak.mean()) / 2}


def learn_base(rec, tg, cubes, years, train_years):
    """(d) pick the base whose (c)-style fit has the lowest in-sample MAE on the training years."""
    best = None
    tr_rec, tr_tg = rec[rec.year.isin(train_years)], tg[tg.year.isin(train_years)]
    for base, dd in cubes.items():
        mu, sig = fit_heat(tr_rec, dd)
        errs = []
        for _, r in tr_tg.iterrows():
            hx, w = _band_weights(tr_rec, r.band)
            o, p = predict_heat(dd, hx, w, int(np.where(years == r.year)[0][0]), mu, sig)
            errs += [abs(o - r.onset), abs(p - r.peak)]
        e = np.mean(errs)
        if best is None or e < best[1]:
            best = (base, e)
    return best[0]


def full_predictions(rec, tg, cubes, years):
    """(d) leave-one-year-out: learn the base on the other years, then predict."""
    rows = []
    for yr in sorted(tg.year.unique()):
        train_years = [y for y in years if y != yr]
        base = learn_base(rec, tg, cubes, years, train_years)
        dd = cubes[base]
        train = rec[rec.year != yr]
        mu, sig = fit_heat(train, dd)
        for _, r in tg[tg.year == yr].iterrows():
            hx, w = _band_weights(train, r.band)
            o, p = predict_heat(dd, hx, w, int(np.where(years == yr)[0][0]), mu, sig)
            rows.append((r.band, yr, o, p, base))
    return pd.DataFrame(rows, columns=["band", "year", "onset_pred", "peak_pred", "base"])


def paired_bootstrap(tg, pred_a, pred_b, draws=2000, seed=0):
    """MAE(a) - MAE(b), resampling whole years. >0 means b is better."""
    ma, mb = _mae(tg, pred_a), _mae(tg, pred_b)
    m = ma.merge(mb, on=["band", "year"], suffixes=("_a", "_b"))
    m["d"] = (m.err_onset_a + m.err_peak_a) / 2 - (m.err_onset_b + m.err_peak_b) / 2
    by_year = m.groupby("year")["d"].agg(["sum", "size"])
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(by_year), (draws, len(by_year)))
    s, n = by_year["sum"].to_numpy()[idx].sum(1), by_year["size"].to_numpy()[idx].sum(1)
    boot = s / n
    return m.d.mean(), np.percentile(boot, [2.5, 97.5])
