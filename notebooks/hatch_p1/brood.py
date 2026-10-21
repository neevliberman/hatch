"""Split off the southern second brood using the rule in FROZEN_CHOICES.md."""
import numpy as np
from scipy.ndimage import gaussian_filter1d


def brood_cutoff(doy, lo=150, hi=220, bw=7, frac=0.8):
    """Day after which records are second brood, or None if the band shows one brood.

    Smooth the pooled day-of-year histogram. The dip is the lowest point in
    [lo, hi]. It splits the broods if there is a real hump on both sides and the
    dip is under `frac` of the first (spring) hump.
    frac was 0.5 when frozen; changed to 0.8, see the change log.
    """
    s = gaussian_filter1d(np.bincount(np.asarray(doy, int), minlength=367)[:367].astype(float), bw)
    dip = lo + int(np.argmin(s[lo:hi + 1]))
    before, after = s[:dip].max(), s[dip + 1:].max()
    if s[dip] < frac * before and s[dip] < frac * after:
        return dip
    return None
