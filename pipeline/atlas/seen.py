"""Expected vs seen: public/atlas/seen-YEAR.bin and seen-YEAR.json.

For every insect photo of YEAR (a season the network never saw; it learned 2015-2025), the network says how likely
each species was to be in it, given where and when it was taken and how warm the spring had been. Added up over all
of YEAR's photos, that is how many photos of each species to expect, and on which days. Set against how many there
really were, it shows each species' year: seen more or less often than expected, earlier or later. Because the
expectation is built from the photos people actually took, more people out with cameras raises both sides alike.

Analogy: a teacher who knows each pupil's usual marks. Given this year's exam papers, they can say who did better
or worse than expected, without being fooled by the exam being easy or hard.

- seen-YEAR.bin: uint8, [species][2 (expected, seen)][ribbon step] (export.py SEASON, STEP: photos in the 4 days
  around each step), both scaled to the larger of the two tops, so the time bar can draw them on one scale.
- seen-YEAR.json: {"year", "last_day", "photos", "species": [[seen, expected, ratio, days], ...]} in species order.
  ratio: seen / expected, or null when the gap is within chance. days: how much earlier (+) or later (-) its season
  came than expected (the slide that best fits its whole season), or null when within chance or with fewer than
  MIN_TIMING photos.
  python3 pipeline/atlas/seen.py            # needs the records through YEAR, warmth.npz and model/run2/atlas.pt
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas import model as M  # noqa: E402
from pipeline.atlas.config import DATA, FIRST_YEAR  # noqa: E402
from pipeline.atlas.export import OUT, SEASON, STEP, YEAR  # noqa: E402

MIN_TIMING = 30   # photos before its timing is judged
Z = 3.0           # a gap counts once it is this many standard errors from expected
MIN_RATIO = 1.25  # ... and at least this many times more (or fewer) photos than expected
MIN_DAYS = 3.0    # ... or at least this many days earlier or later


def dispersion(o, e):
    """How much more counts scatter than chance alone (a Poisson count) would make them: photos come in clumps, a
    keen observer or a good patch, so the plain chance test would call far too many species surprising. Robust: the
    median of each species' (seen - expected)^2 / expected over that of chance (0.455, a chi-square with 1 degree)."""
    ok = e >= 5
    return max(1.0, float(np.median((o[ok] - e[ok]) ** 2 / e[ok]) / 0.455))


def best_shift(o_day, e_day, reach=30):
    """(days, log-likelihood gain) for sliding the expected season earlier (+) or later (-) to fit the photos seen.
    It matches the whole shape (both broods of a two-brood species), not just the middle, which jumps from one brood to
    the other when their sizes change."""
    k = np.ones(7) / 7
    e = np.convolve(np.r_[e_day[-3:], e_day, e_day[:3]], k, "valid")
    e = e / e.sum() + 1e-6  # a floor, so a photo on a day nothing was expected costs a lot but not infinitely
    e = e / e.sum()
    pad = np.r_[np.full(reach, e[0]), e, np.full(reach, e[-1])]
    # Seen on day d, it was expected on day d + delta: delta > 0 means it came early.
    ll = np.array([(o_day * np.log(pad[reach + d:reach + d + len(e)])).sum() for d in range(-reach, reach + 1)])
    best = int(np.argmax(ll))
    return best - reach, float(ll[best] - ll[reach])


def judge(o_day, e_day, phi, phi_t):
    """(ratio or None, days earlier or None) for one species' photos by day of year, seen and expected. phi, phi_t:
    how much the counts and the timing scatter beyond chance (dispersion)."""
    o, e = o_day.sum(), e_day.sum()
    ratio = None
    if e > 0:
        z = (o - e) / np.sqrt(phi * e)
        r = o / e
        if abs(z) >= Z and (r >= MIN_RATIO or r <= 1 / MIN_RATIO):
            ratio = round(float(r), 2)
    shift = None
    if o >= MIN_TIMING:
        d, gain = best_shift(o_day, e_day)
        # A likelihood-ratio test (twice the gain is chi-square with 1 degree), with the clumping allowed for.
        if abs(d) >= MIN_DAYS and 2 * gain / phi_t >= Z ** 2:
            shift = d
    return ratio, shift


def timing_dispersion(seen, expected):
    """As dispersion(), for the timing test: the median of twice each species' best-slide gain over chance's. (It also
    absorbs the slide being the best of 61 tries, so the test stays honest.)"""
    gains = [2 * best_shift(o, e)[1] for o, e in zip(seen, expected) if o.sum() >= MIN_TIMING]
    return max(1.0, float(np.median(gains)) / 0.455)


def ribbon(day_counts):
    """[S, 365] photos by day -> [S, steps]: the 4 days around each ribbon step."""
    steps = np.arange(SEASON[0], SEASON[1] + 1, STEP)
    out = np.zeros((day_counts.shape[0], len(steps)))
    for j, d in enumerate(steps):
        out[:, j] = day_counts[:, max(0, d - 3):d + 1].sum(1)  # days d-2 .. d+1 (doy d is column d-1)
    return out


@torch.no_grad()
def main():
    ck = torch.load(DATA / "model/run2/atlas.pt")
    sp = ck["species"]
    net = M.Atlas(len(sp) + 1)
    net.load_state_dict(ck["state"])
    last = int(np.load(DATA / "warmth.npz")["last_day_2026"])

    df = D.load_records(last_year=YEAR)
    df = df[(df.year == YEAR) & (df.doy <= last)]
    w = D.Warmth.load(np.arange(FIRST_YEAR, YEAR))
    df = D.attach_clock(df, w, w.days_ahead())
    y = D.labels(df, sp)
    n_out = len(sp) + 1
    doy = df.doy.to_numpy()
    print(f"{len(df):,} photos of {YEAR} through day {last}")

    seen = np.zeros((n_out, 365))
    np.add.at(seen, (y, doy - 1), 1)
    expected = torch.zeros(n_out, 365, dtype=torch.float64)
    place = M.place_features(df.lat, df.lng, df.norm_dd)
    for sl, lp in M.predict_log_probs(net, place, doy, df.delta.to_numpy()):
        p = lp.exp().double()
        # Each photo adds its probabilities to its own day: [365, b] one-hot times [b, S].
        onehot = torch.zeros(365, p.shape[0], dtype=torch.float64)
        onehot[torch.as_tensor(doy[sl] - 1), torch.arange(p.shape[0])] = 1
        expected += (onehot @ p).T
    expected = expected.numpy()

    phi, phi_t = dispersion(seen.sum(1), expected.sum(1)), timing_dispersion(seen, expected)
    print(f"dispersion: counts {phi:.1f}, timing {phi_t:.1f}")
    rows = []
    for s in range(n_out):
        ratio, shift = judge(seen[s], expected[s], phi, phi_t)
        rows.append([int(seen[s].sum()), round(float(expected[s].sum()), 1), ratio, shift])

    o, e = ribbon(seen), ribbon(expected)
    top = np.maximum(o.max(1), e.max(1))[:, None]
    scaled = np.stack([e, o], 1) / np.where(top > 0, top, 1)[:, None]
    np.round(255 * scaled).astype(np.uint8).tofile(OUT / f"seen-{YEAR}.bin")
    (OUT / f"seen-{YEAR}.json").write_text(json.dumps(
        {"year": YEAR, "last_day": last, "photos": len(df), "species": rows}, separators=(",", ":")))

    named = [(sp[i] if i < len(sp) else "(other)", *r) for i, r in enumerate(rows)]
    more = sorted((r for r in named if r[3]), key=lambda r: -r[3])
    early = sorted((r for r in named if r[4]), key=lambda r: -r[4])
    print(f"{sum(r[2] is not None for r in rows)} species off in numbers, {sum(r[3] is not None for r in rows)} in timing")
    for title, lst in (("most more than expected", more[:8]), ("most fewer", more[::-1][:8]),
                       ("earliest", early[:8]), ("latest", early[::-1][:8])):
        print(title)
        for name, o_, e_, r, d in lst:
            print(f"  {name:32s} seen {o_:6d} expected {e_:8.1f} ratio {r} days {d}")


if __name__ == "__main__":
    main()
