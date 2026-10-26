"""The 2027 shadow rule "A1 cap + flag and widen" (frozen text: pipeline/fit/PREREG_2027.md, "Second shadow").

Analogy: a rain gauge that only ever read up to 250 mm. When the sky delivers more, the safe reading is "at least 250",
not 400 extrapolated from a scale nobody calibrated, and the forecaster adds "this is off our chart" to the card.

Pure functions (plus `load_envelopes`). build_live.py calls them only for a bench challenger that carries envelopes
(pipeline/league/bench.py, "luna~p3-a1-v1"), so the map and every scored P3 / P3.1 output are unchanged. Same maths as notebooks/southbias/sb.py (cap_inc, flagged) and run.py (the widening), where it was scored; day index
t = day of year - 1, so 1 April is index 90.

The envelope E[t] (largest banked Daymet degree-days, base 10 C from 1 March, on day t at any training place-year
of a fold) is built from the Daymet cube by pipeline/league/build_a1.py and shipped as pipeline/league/a1_envelopes.json;
`check_envelope` is the gate.

On a live night (written 2026-10-26, before any 2027 data, PREREG_2027.md amendment): the cap uses each fold's own E;
the flag reads only the weather known that night (PRISM to as_of, then the 7-day forecast, never the past-year
endings) against the widest of the 11 envelopes (outside every fit's range), from 1 April to the strip's A1 peak.
"""
import json

import numpy as np

FLAG_FROM = 90        # 1 April
N_FOLDS = 11          # one envelope per fold fit in pipeline/replay/fold_fits.json (2015-2025)


def envelope(cum, place_years):
    """E[t] = max over place-years (hex, year) of cum[hex, year, t]. cum: banked degree-days [hex, year, 365]."""
    pairs = np.unique(np.asarray(place_years, int).reshape(-1, 2), axis=0)
    return cum[pairs[:, 0], pairs[:, 1], :].max(0).astype(float)


def check_envelope(env):
    """Refuse an envelope that is the wrong shape, has holes, or goes down (a bank only grows)."""
    env = np.asarray(env, float)
    if env.shape != (365,) or not np.isfinite(env).all() or (np.diff(env) < -1e-9).any() or env[0] < 0:
        raise ValueError("envelope must be 365 finite, non-decreasing, non-negative numbers")
    return env


def cap_inc(inc, env):
    """A1. Daily degree-days whose running total never exceeds E: cumsum(result) = min(cumsum(inc), E)."""
    c = np.minimum(np.cumsum(inc, -1), np.asarray(env, float)[: inc.shape[-1]])
    return np.diff(c, axis=-1, prepend=0.0)


def flagged(inc, env, peak_day):
    """Per hexagon: is the real (uncapped) bank above E on any day index 90..peak_day-1 (peak_day = calendar day of the
    strip's A1 forecast peak, so index peak_day-1 inclusive)? A bank of exactly E is not flagged."""
    c = np.cumsum(inc, -1)
    t_end = int(min(round(peak_day) - 1, inc.shape[-1] - 1))
    if t_end < FLAG_FROM:
        return np.zeros(len(inc), bool)
    return (c[:, FLAG_FROM:t_end + 1] > np.asarray(env, float)[FLAG_FROM:t_end + 1] + 1e-9).any(1)


def widen(lo, hi, calendar, flag):
    """Flag and widen, don't move: a flagged strip's likely range stretches to include the usual (calendar) date.
    The point forecast is never touched. Unflagged: unchanged."""
    return (min(lo, calendar), max(hi, calendar)) if flag else (lo, hi)


def strip_flag(hex_flags, weights):
    """A strip is flagged if any hexagon with positive strip weight is (not a share; the middle strip's 29% counted)."""
    return bool(np.any(np.asarray(hex_flags, bool) & (np.asarray(weights, float) > 0)))


def load_envelopes(path, folds):
    """[fold, 365] from a1_envelopes.json; refuses a file built for other folds or fits."""
    js = json.loads(path.read_text())
    if js["folds"] != list(folds):
        raise ValueError(f"envelopes are for folds {js['folds']}, the fits have {list(folds)}")
    return np.array([check_envelope(e) for e in js["envelopes"]])


def live_flags(inc_known, envs, w, peaks):
    """Per strip: flagged on the known weather (inc_known: [cell, day] up to the last known day) against the widest
    envelope. w: [strip, cell] weights; peaks: each strip's A1 forecast peak (day of year; inf/None = never)."""
    env = np.asarray(envs, float).max(0)
    out = []
    for wb, pk in zip(w, peaks):
        pk = inc_known.shape[-1] if pk is None or not np.isfinite(pk) else pk
        out.append(strip_flag(flagged(inc_known, env, pk), wb))
    return out
