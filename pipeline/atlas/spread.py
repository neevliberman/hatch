"""How much a species' season moves from year to year: public/atlas/spread.bin, the time bar's soft band.

For each year 2015-2024 (the network's training years; 2025, its held-out test year, stays out), the photos of that
year (the sighting dots, dots.py) are slid against the other years' photos pooled (leave one year out) to find the
slide that best fits that year's whole season (as seen.py's best_shift, so both broods of a two-brood species move
together). Each photo's day is first set against its latitude (the season reaches the north later, and a year with
more photos from the south is not an early year): the slope comes from sliding each 2-degree band's photos against all
of them, the same whole-season fit, so it never cuts photos off by date and a two-brood species' gap doesn't pull it.

Some of the scatter between years' slides is only chance, and photos come in clumps, so a year of 40 photos from a
handful of outings, or with a bioblitz weekend in it, can't pin its slide down. A year counts only with MIN_PHOTOS
photos on MIN_DAYS different days in MIN_CLUMPS clumps. Each year's slide is bootstrapped twice, by outings (photos in
one 1-degree square on days at most 3 apart chain together) and by map-wide 3-day blocks (an event weekend), and the
larger variance is that year's noise. A species gets a band only when the years scatter more than their noise allows
(Cochran's Q, chi-square, 95%). Its width is then estimated apart from that test: the between-year variance tau^2 by
Paule-Mandel with each year's own noise, and the band is a prediction interval for a new year's peak, t (k - 1
degrees of freedom, 80%) x tau x sqrt(1 + 1/k), shown only when at least MIN_BAND days.

Analogy: a bus that is due at 8:00. Its timetable is the ribbon; this is how many minutes early or late it runs on
most mornings, after allowing for the stopwatch being rough on mornings with few riders.

spread.bin: "SPR1", uint32 species count, uint32 FNV-1a hash of the species names (species.json order, "(other)" left
out, UTF-16 code units, joined by newlines: the page ignores a file built for another species list), then uint8
[species.json row]: the band's
half width in whole days, or 255 for no band (too few good years, a spread chance alone could make, or under
MIN_BAND days).
  python3 pipeline/atlas/spread.py [scientific name ...]   # reads public/atlas/dots/ and species.json; no network
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np
from scipy import stats

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas.config import BOX, FIRST_YEAR, TEST_YEAR  # noqa: E402

LAST = TEST_YEAR - 1  # the years the network trained on; the held-out test year stays out

OUT = ROOT / "public/atlas"
MIN_PHOTOS = 40   # photos a year needs before its slide counts
MIN_DAYS = 22     # ... on at least this many different days (40 photos from a few outings fall on fewer)
MIN_CLUMPS = 15   # ... in at least this many clumps (below: one year is a handful of outings)
MIN_YEARS = 5     # years a species needs before it gets a band
REACH = 30        # largest slide tried, days
BOOT = 100        # bootstrap draws per year
CELL = 1.0        # the bootstrap resamples clumps: photos in one 1-degree square on days at most GAP apart
GAP = 3
BLOCK = 3         # ... or, without longitudes, BLOCK-day blocks
BAND_DEG = 2      # latitude bands for the slope
COVER = 0.8       # the band holds a new year's peak this often
ALPHA = 0.05      # the year-to-year spread must beat chance at this level
MIN_VAR = 0.5     # a year's slide is never known better than this (days^2): slides are whole days
MIN_BAND = 3      # narrower than this (days either side) is no band (src/layers/atlasLayer.ts MIN_BAND)
NONE = 255
DAYS = 366


def fnv(names):
    h = 0x811C9DC5
    for u in np.frombuffer("\n".join(names).encode("utf-16-le"), "<u2").tolist():
        h = ((h ^ u) * 0x01000193) & 0xFFFFFFFF
    return h


def read_dots(i):
    """(day of year, latitude, year, longitude) of species i's photos FIRST_YEAR-LAST (dots.py's layout)."""
    b = (OUT / "dots" / f"{i}.bin").read_bytes()
    n = len(b) // 11
    if n == 0:
        return np.zeros(0), np.zeros(0), np.zeros(0, int), np.zeros(0)
    doy = np.frombuffer(b, "<u2", n, 4 * n).astype(float)
    lat = np.frombuffer(b, "<u2", n, 6 * n) / 65535 * (BOX["n"] - BOX["s"]) + BOX["s"]
    lng = np.frombuffer(b, "<u2", n, 8 * n) / 65535 * (BOX["e"] - BOX["w"]) + BOX["w"]
    year = np.frombuffer(b, "u1", n, 10 * n).astype(int) + 2000
    leap = (year % 4 == 0) & ((year % 100 != 0) | (year % 400 == 0))
    doy = np.where(leap & (doy >= 60), doy - 1, doy)  # as the page's dots: 1 Mar is day 60 every year
    k = (year >= FIRST_YEAR) & (year <= LAST)
    return doy[k], lat[k], year[k], lng[k]


def counts(days):
    return np.bincount(np.clip(np.round(days).astype(int), 0, DAYS - 1), minlength=DAYS).astype(float)


def density(c):
    """log of photos per day (counts c), smoothed over a week, with a floor (as seen.best_shift), padded REACH each side."""
    e = np.convolve(np.r_[c[-3:], c, c[:3]], np.ones(7) / 7, "valid")
    e = e / e.sum() + 1e-6
    e = e / e.sum()
    return np.log(np.r_[np.full(REACH, e[0]), e, np.full(REACH, e[-1])])


def slides(c, logpad):
    """Best slide (days; + early) for each row of day counts c ([n, DAYS] or [DAYS]) against the pooled season."""
    c = np.atleast_2d(c)
    ll = np.stack([c @ logpad[REACH + d:REACH + d + DAYS] for d in range(-REACH, REACH + 1)], 1)
    return np.argmax(ll, 1) - REACH


def lat_slope(doy, lat):
    """Days later per degree north: each BAND_DEG band's whole-season slide against all the photos, regressed on the
    band's latitude (weighted by photos). Held to -3..8 days a degree (the spring front runs roughly 2-5)."""
    logpad = density(counts(doy))
    band = np.floor(lat / BAND_DEG)
    x, y, w = [], [], []
    for b in np.unique(band):
        k = band == b
        if k.sum() >= 30:
            x.append(lat[k].mean())
            y.append(-slides(counts(doy[k]), logpad)[0])
            w.append(k.sum())
    if len(x) < 2 or np.ptp(x) < 1:
        return 0.0
    return float(np.clip(np.polyfit(x, y, 1, w=np.sqrt(w))[0], -3, 8))


def clumps(doy, lat, lng):
    """A clump number for each photo of one year: photos in the same 1-degree square on days at most GAP apart
    (an outing, a keen observer's week) chain into one clump. Without longitudes, BLOCK-day blocks of the whole map."""
    if lng is None:
        return np.unique(np.floor(doy / BLOCK), return_inverse=True)[1].ravel()
    cell = np.unique(np.c_[np.floor(lat / CELL), np.floor(lng / CELL)], axis=0, return_inverse=True)[1].ravel()
    order = np.lexsort((doy, cell))
    new = np.r_[True, (np.diff(cell[order]) != 0) | (np.diff(doy[order]) > GAP)]
    out = np.empty(len(doy), int)
    out[order] = np.cumsum(new) - 1
    return out


def boot_var(mine, clump, logpad, rng):
    """Bootstrap variance of a year's slide, drawing its clumps with replacement, each with all its photos."""
    per = np.zeros((clump.max() + 1, DAYS))
    np.add.at(per, (clump, np.clip(np.round(mine).astype(int), 0, DAYS - 1)), 1)
    m = len(per)
    draw = rng.multinomial(m, np.full(m, 1 / m), BOOT) @ per
    return np.var(slides(draw, logpad), ddof=1) * m / (m - 1)  # the bootstrap's n - 1


def paule_mandel(x, v):
    """Between-year variance tau^2 for estimates x with their own noise variances v (Paule-Mandel: the tau^2 at which
    the weighted scatter about the weighted mean equals its expectation, k - 1), the weights 1 / (v + tau^2)."""
    def q(t2):
        w = 1 / (v + t2)
        return np.sum(w * (x - np.sum(w * x) / w.sum()) ** 2) - (len(x) - 1)
    if q(0.0) <= 0:
        return 0.0
    lo, hi = 0.0, max(1.0, float(np.var(x)) * 4)
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if q(mid) > 0 else (lo, mid)
    return (lo + hi) / 2


def spread(doy, lat, year, rng, lng=None):
    """(band half width in days or None, per-year slides, tau (sd between years) or None, typical chance sd) for one
    species. Without longitudes, clumps are by days alone (more cautious)."""
    def enough(y):
        k = year == y
        return (k.sum() >= MIN_PHOTOS and len(np.unique(doy[k])) >= MIN_DAYS
                and clumps(doy[k], lat[k], None if lng is None else lng[k]).max() + 1 >= MIN_CLUMPS)
    years = [y for y in np.unique(year) if enough(y)]
    k = len(years)
    if k < MIN_YEARS:
        return None, {}, None, None
    adj = doy - lat_slope(doy, lat) * (lat - np.median(lat))
    out, var = {}, []
    for y in years:
        here = year == y
        mine = adj[here]
        logpad = density(counts(adj[year != y]))
        out[int(y)] = int(slides(counts(mine), logpad)[0])
        # Two kinds of clump, and the noisier answer counts: outings (one square, a few days) and map-wide events
        # (a bioblitz weekend: every photo in the same BLOCK days, wherever it was taken).
        local = boot_var(mine, clumps(doy[here], lat[here], None if lng is None else lng[here]), logpad, rng)
        wide = boot_var(mine, clumps(doy[here], lat[here], None), logpad, rng)
        var.append(max(local, wide, MIN_VAR))
    # Each slide is measured against the other years, which spreads the slides by k / (k - 1) about their mean.
    x = np.array(list(out.values()), float) * (k - 1) / k
    v = np.array(var)
    # The gate: Cochran's Q, the weighted scatter, beats what chance alone would make (chi-square, k - 1, 95%).
    w = 1 / v
    q = np.sum(w * (x - np.sum(w * x) / w.sum()) ** 2)
    if q <= stats.chi2.ppf(1 - ALPHA, k - 1):
        return None, out, None, float(np.sqrt(np.median(v)))
    # The width, from tau^2 estimated with each year's own noise (not the scatter that passed the gate): a prediction
    # interval for a new year's peak about the usual one, t (k - 1, 80%) x tau x sqrt(1 + 1/k).
    t2 = paule_mandel(x, v)
    half = stats.t.ppf(0.5 + COVER / 2, k - 1) * np.sqrt(t2 * (1 + 1 / k))
    if half < MIN_BAND:
        return None, out, float(np.sqrt(t2)), float(np.sqrt(np.median(v)))
    return half, out, float(np.sqrt(t2)), float(np.sqrt(np.median(v)))


def main(show=()):
    species = json.loads((OUT / "species.json").read_text())
    rng = np.random.default_rng(0)
    out = np.full(len(species), NONE, np.uint8)
    for i, s in enumerate(species):
        if s["name"] == "(other)":
            continue
        doy, lat, year, lng = read_dots(i)
        if len(doy) == 0:
            continue
        half, sl, sd, chance = spread(doy, lat, year, rng, lng)
        if half is not None:
            out[i] = min(NONE - 1, int(round(half)))
        if s["name"] in show:
            print(f"{s['name']}: band {'none' if half is None else f'+-{half:.1f} d'} (sd {sd}, chance {chance}); "
                  f"lat slope {lat_slope(doy, lat):.1f} d/deg; slides (+ early) {sl}")
    real = [s["name"] for s in species if s["name"] != "(other)"]  # as the page's species list (loadIndex)
    head = b"SPR1" + struct.pack("<II", len(real), fnv(real))
    (OUT / "spread.bin").write_bytes(head + out.tobytes())
    ok = out[out != NONE]
    print(f"{len(ok)} of {len(species) - 1} species get a band; half-width median {np.median(ok):.0f} d, "
          f"10th-90th pct {np.percentile(ok, 10):.0f}-{np.percentile(ok, 90):.0f} d")


if __name__ == "__main__":
    main(show=sys.argv[1:])
