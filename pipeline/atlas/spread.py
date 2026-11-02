"""How much a species' season moves from year to year: public/atlas/spread.bin, the time bar's soft band.

For each year 2015-2025, the photos of that year (the sighting dots, dots.py) are slid against the other years'
photos pooled (leave one year out) to find the slide that best fits that year's whole season (seen.py's best_shift,
so both broods of a two-brood species move together). Each photo's day is first set against its latitude (the season
reaches the north later, and a year with more photos from the south is not an early year). Some of the scatter
between years' slides is only chance (a year of 40 photos can't pin its slide down to the day): each year's slide is
bootstrapped and that chance part taken out (method of moments), leaving the real year-to-year spread, sd. The band
is the typical season slid from 1.28 sd earlier to 1.28 sd later: in 8 years of 10 the season sits inside it (10th
to 90th percentile, if years scatter about normally).

Analogy: a bus that is due at 8:00. Its timetable is the ribbon; this is how many minutes early or late it ran on
most mornings, after allowing for the stopwatch being a little rough on mornings with few riders.

spread.bin: uint8 [species], 1.28 sd in whole days, or 255 for no band (fewer than MIN_YEARS years of MIN_PHOTOS
photos each).
  python3 pipeline/atlas/spread.py          # reads public/atlas/dots/ and species.json; no network, ~1 min
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas.config import BOX, FIRST_YEAR, LAST_YEAR  # noqa: E402

OUT = ROOT / "public/atlas"
MIN_PHOTOS = 25  # photos a year needs before its slide counts
MIN_YEARS = 5    # years a species needs before it gets a band
REACH = 30       # largest slide tried, days
BOOT = 60        # bootstrap draws per year
Z = 1.2816       # 10th to 90th percentile of a normal
NONE = 255
DAYS = 366


def read_dots(i):
    """(day of year, latitude, year) of species i's photos 2015-2025 (dots.py's layout)."""
    b = (OUT / "dots" / f"{i}.bin").read_bytes()
    n = len(b) // 11
    if n == 0:
        return np.zeros(0), np.zeros(0), np.zeros(0, int)
    o = 4 * n
    doy = np.frombuffer(b, "<u2", n, o).astype(float)
    lat = np.frombuffer(b, "<u2", n, o + 2 * n) / 65535 * (BOX["n"] - BOX["s"]) + BOX["s"]
    year = np.frombuffer(b, "u1", n, o + 6 * n).astype(int) + 2000
    leap = (year % 4 == 0) & ((year % 100 != 0) | (year % 400 == 0))
    doy = np.where(leap & (doy >= 60), doy - 1, doy)  # as the page's dots: 1 Mar is day 60 every year
    k = (year >= FIRST_YEAR) & (year <= LAST_YEAR)
    return doy[k], lat[k], year[k]


def lat_slope(doy, lat):
    """Days later per degree north, from the photos within a month of the median (so a second brood doesn't pull
    the line), held to 0-6 days (the spring front runs roughly 2-5 days a degree)."""
    k = np.abs(doy - np.median(doy)) <= 30
    if k.sum() < 20 or np.ptp(lat[k]) < 1:
        return 0.0
    return float(np.clip(np.polyfit(lat[k], doy[k], 1)[0], 0, 6))


def density(days):
    """Pooled photos per day, smoothed over a week, with a floor (as seen.best_shift), padded REACH each side."""
    c = np.bincount(np.clip(np.round(days).astype(int), 0, DAYS - 1), minlength=DAYS).astype(float)
    k = np.ones(7) / 7
    e = np.convolve(np.r_[c[-3:], c, c[:3]], k, "valid")
    e = e / e.sum() + 1e-6
    e = e / e.sum()
    return np.log(np.r_[np.full(REACH, e[0]), e, np.full(REACH, e[-1])])


def best_shift(days, logpad):
    """The slide (days; + early) that best fits these photos' days to the pooled season."""
    idx = np.clip(np.round(days).astype(int), 0, DAYS - 1)
    ll = np.array([logpad[REACH + d + idx].sum() for d in range(-REACH, REACH + 1)])
    return int(np.argmax(ll)) - REACH


def spread(doy, lat, year, rng):
    """(1.28 sd in days or None, per-year slides, raw sd, chance sd) for one species."""
    years = [y for y in np.unique(year) if (year == y).sum() >= MIN_PHOTOS]
    if len(years) < MIN_YEARS:
        return None, {}, None, None
    adj = doy - lat_slope(doy, lat) * (lat - np.median(lat))
    slides, var = {}, []
    for y in years:
        mine = adj[year == y]
        logpad = density(adj[year != y])
        slides[int(y)] = best_shift(mine, logpad)
        boot = [best_shift(rng.choice(mine, len(mine)), logpad) for _ in range(BOOT)]
        var.append(np.var(boot, ddof=1))
    s = np.array(list(slides.values()), float)
    raw = float(np.var(s, ddof=1))
    chance = float(np.mean(var))
    sd = np.sqrt(max(0.0, raw - chance))
    return Z * sd, slides, np.sqrt(raw), np.sqrt(chance)


def main(show=()):
    species = json.loads((OUT / "species.json").read_text())
    rng = np.random.default_rng(0)
    out = np.full(len(species), NONE, np.uint8)
    for i, s in enumerate(species):
        if s["name"] == "(other)":
            continue
        doy, lat, year = read_dots(i)
        if len(doy) == 0:
            continue
        half, slides, raw, chance = spread(doy, lat, year, rng)
        if half is not None:
            out[i] = min(NONE - 1, int(round(half)))
        if s["name"] in show:
            print(f"{s['name']}: band +-{half:.1f} d (sd raw {raw:.1f}, chance {chance:.1f}); slides (+ early) {slides}")
    out.tofile(OUT / "spread.bin")
    ok = out[out != NONE]
    print(f"{len(ok)} of {len(species) - 1} species get a band; half-width median {np.median(ok):.0f} d, "
          f"10th-90th pct {np.percentile(ok, 10):.0f}-{np.percentile(ok, 90):.0f} d, zero for {(ok == 0).sum()}")


if __name__ == "__main__":
    main(show=sys.argv[1:])
