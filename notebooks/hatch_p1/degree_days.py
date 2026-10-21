"""Degree-days: the 'warmth saved up' a bug counts toward emergence.

Analogy: each day pays into a bank account. Only warmth above the base
temperature counts, and warmth above the upper cutoff is capped (too hot
doesn't speed a bug up any further).

Temperature inside a day is modelled as a sine wave between Tmin and Tmax
(Baskerville & Emin 1969). Double-sine = morning half uses today's Tmin,
evening half uses tomorrow's Tmin, which tracks fronts better.
"""
import numpy as np


def single_sine(tmin, tmax, base, upper=30.0):
    """Mean degrees above `base` (capped at `upper`) under a sine from tmin to tmax.

    One closed form covers every case: theta1/theta2 are where the sine crosses
    base/upper (clipped to +-pi/2 when it never crosses), so the integral just
    picks up the right pieces. Works on numpy arrays of any shape.
    """
    tmin, tmax = np.minimum(tmin, tmax), np.maximum(tmin, tmax)
    m = (tmax + tmin) / 2
    w = np.maximum((tmax - tmin) / 2, 1e-9)
    t1 = np.arcsin(np.clip((base - m) / w, -1, 1))
    t2 = np.arcsin(np.clip((upper - m) / w, -1, 1))
    return ((m - base) * (t2 - t1) + w * (np.cos(t1) - np.cos(t2))
            + (upper - base) * (np.pi / 2 - t2)) / np.pi


def double_sine(tmin, tmax, base, upper=30.0):
    """Daily degree-days along the last axis (days). Last day reuses its own Tmin."""
    tmin_next = np.concatenate([tmin[..., 1:], tmin[..., -1:]], axis=-1)
    return 0.5 * single_sine(tmin, tmax, base, upper) + 0.5 * single_sine(tmin_next, tmax, base, upper)


def accumulate(tmin, tmax, base, upper=30.0, start_doy=60):
    """Cumulative degree-days by day of year (index 0 = 1 Jan), zero before 1 Mar (doy 60)."""
    dd = double_sine(tmin, tmax, base, upper)
    dd[..., : start_doy - 1] = 0
    return np.cumsum(dd, axis=-1)
