"""Add the room each lake and state name has, so the map can hide a name that is wider than its lake or state.

Reads public/basemap/{overview,detail}.json and src/data/midwest-states.json and rewrites the 'water' and 'state'
labels to [name, lng, lat, minZoom, kind, size, chordDeg, heightDeg]:
  chordDeg   the widest run of water (or state) in degrees of longitude, through the label's line of text
  heightDeg  the water straight above and below that point, in degrees of latitude (lakes only)
The anchor also moves to the roomiest spot of its own lake/state part, so a name sits mid-lake, not on the shore.
The fit is a pure function of the polygon and the anchor recorded in label_anchors.json, so a rerun gives the same
bytes. After build_basemap.py (fresh, unfitted labels): python3 pipeline/basemap/fit_labels.py --init, then
python3 pipeline/basemap/fit_labels.py. Test: python3 -m pytest pipeline/basemap/test_fit_labels.py
No dependencies beyond numpy.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/basemap'


def rings_of(geom):
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
    return [[np.array(r) for r in p] for p in polys]


def span(rings, fixed, at, axis):
    """The inside run along `axis` (0 = west-east) through `at`, on the line where the other coordinate is `fixed`
    (even-odd over all rings), as (low, high); None when `at` is outside."""
    xs = []
    o = 1 - axis
    for r in rings:
        a, b = r[:-1], r[1:]
        m = (a[:, o] > fixed) != (b[:, o] > fixed)
        if m.any():
            t = (fixed - a[m, o]) / (b[m, o] - a[m, o])
            xs.extend(a[m, axis] + t * (b[m, axis] - a[m, axis]))
    xs.sort()
    for i in range(0, len(xs) - 1, 2):
        if xs[i] <= at <= xs[i + 1]:
            return xs[i], xs[i + 1]
    return None


def run(rings, fixed, at, axis):
    """Usable length of the run: twice the distance to the nearer shore, because a name is drawn centred on its anchor.
    0 when `at` is outside."""
    r = span(rings, fixed, at, axis)
    return 2 * min(at - r[0], r[1] - at) if r else 0.0


def area(r):
    return float((r[:-1, 0] * r[1:, 1] - r[1:, 0] * r[:-1, 1]).sum())


def fit(flat, x0, y0, rows, kind, reach=None):
    """Search the part's bounding box for the roomiest point (near the first guess); return x, y, chord, height."""
    allp = np.concatenate(flat)
    (x1, y1), (x2, y2) = allp.min(0), allp.max(0)
    if reach:  # a bay or arm named inside a bigger lake shape stays where it is named
        x1, x2, y1, y2 = max(x1, x0 - reach), min(x2, x0 + reach), max(y1, y0 - reach), min(y2, y0 + reach)
    n = 40
    best = None
    for x in np.linspace(x1, x2, n):
        for y in np.linspace(y1, y2, n):
            chord = run(flat, y, x, 0)
            if chord <= 0:
                continue
            cos = math.cos(math.radians(y))
            vc = 0.0
            dv = rows
            if kind == 'water':
                vc = run(flat, x, y, 1)
                dv = min(vc / 2, 0.1 * cos * chord)
            chord = min(chord, run(flat, y - dv, x, 0), run(flat, y + dv, x, 0))
            score = min(chord, 5 * vc / cos) if kind == 'water' else chord
            score -= 0.02 * math.hypot(x - x0, y - y0)  # stay near the first guess unless there is room to gain
            if best is None or score > best[0]:
                best = (score, x, y, chord, vc)
    if best is None:  # no room anywhere in the window: keep the anchor, with no room to claim
        return x0, y0, 0.0, 0.0
    return best[1:]


# One short form for every park name (forest 'NF', lake shore 'NL', and so on), so none runs three times the others.
SHORT = {
    'Dakota Prairie Grasslands': 'Dakota Prairie NG',
    'George Washington and Jefferson NF': 'Jefferson NF',
    'Land Between the Lakes National Recreation Area': 'Land Between the Lakes NRA',
    'Midewin National Tallgrass Prairie': 'Midewin NTP',
    'Big South Fork NRRA': 'Big South Fork NRA',
}
# Mark Twain NF is a dozen separate tracts: name the two biggest, or the others read as unlabelled outlines.
EXTRA_PARK_SIZE = 1  # their size field: no real park is this small, so it marks the generated tracts
MORE_PARKS = [('Mark Twain NF', -91.21, 37.69, 6.5)]


ANCHORS = ROOT / 'pipeline/basemap/label_anchors.json'
FIT_KINDS = ('state', 'water', 'park')


def key(lab):
    """Which label this is. Names repeat (two Pelican Lakes), so the size tells them apart."""
    return f'{lab[4]}|{lab[0]}|{lab[5]}'


def load():
    return {n: json.loads((OUT / f'{n}.json').read_text()) for n in ('overview', 'detail')}


def save(files):
    for n, d in files.items():
        (OUT / f'{n}.json').write_text(json.dumps(d, separators=(',', ':'), ensure_ascii=False))


def init_anchors():
    """Record where build_basemap.py first put each lake, state and park name. Run once on fresh, unfitted output;
    the fit always starts from these, never from where a name already sits, so a rerun changes nothing."""
    files = load()
    out = {}
    for d in files.values():
        for lab in d['labels']:
            if lab[4] in FIT_KINDS:
                if len(lab) > 6:
                    raise SystemExit('labels are already fitted: run build_basemap.py first')
                out[key([SHORT.get(lab[0], lab[0])] + lab[1:])] = [lab[1], lab[2]]
    ANCHORS.write_text(json.dumps(out, indent=0, ensure_ascii=False, sort_keys=True) + '\n')


def main():
    states = json.loads((ROOT / 'src/data/midwest-states.json').read_text())['features']
    state_polys = {f['properties']['name'].upper(): rings_of(f['geometry']) for f in states if f['properties']['core']}
    anchors = json.loads(ANCHORS.read_text())
    files = load()
    lakes = [p for d in files.values() for f in d['water']['features'] for p in rings_of(f['geometry'])]
    green = [p for d in files.values() for f in d['green']['features'] for p in rings_of(f['geometry'])]
    detail = files['detail']['labels']
    # The extra tracts are generated: drop last run's, then add them again from MORE_PARKS.
    detail[:] = [lab for lab in detail if not (lab[4] == 'park' and lab[5] == EXTRA_PARK_SIZE)]
    for name, x, y, z in MORE_PARKS:
        host = [q for q in green if run(q, y, x, 0) > 0]
        if host:
            x, y, _, _ = fit(max(host, key=lambda q: abs(area(q[0]))), x, y, 0, 'state')
        detail.append([name, round(float(x), 3), round(float(y), 3), z, 'park', EXTRA_PARK_SIZE])
    for lab in detail:
        lab[0] = SHORT.get(lab[0], lab[0])
    shares = []
    for d in files.values():
        for lab in d['labels']:
            name, _, _, _, kind = lab[:5]
            if kind == 'city' and lab[5] >= 2_000_000:
                lab[3] = 0  # Chicago is named from the first view
            if kind not in FIT_KINDS or (kind == 'park' and lab[5] == EXTRA_PARK_SIZE):
                continue
            del lab[6:]
            lab[1], lab[2] = anchors[key(lab)]  # always from the recorded anchor
            x, y = lab[1], lab[2]
            if kind == 'state':
                rows = 0.35
                cands = [p for p in state_polys.get(name, []) if run(p, y, x, 0) > 0]
            elif kind == 'water':
                rows = 0
                cands = [p for p in lakes if run(p, y, x, 0) > 0]
            else:
                rows = 0.08
                cands = [p for p in green if run(p, y, x, 0) > 0]
            if not cands:
                print('no host for', name)
                continue
            # The biggest shape holding the point (a lake's rings include its islands: even-odd handles them).
            host = max(cands, key=lambda p: abs(area(p[0])))
            nx, ny, chord, vc = fit(host, x, y, rows, 'water' if kind == 'water' else 'state', lab[5] / 111 * 0.75 + 0.05 if kind == 'water' else None)
            if kind == 'park' and chord < 0.03:
                continue  # a thin or tiny park: named where it is, no room test
            lab[1], lab[2] = round(float(nx), 3), round(float(ny), 3)
            full = span(host, ny, nx, 0)
            if kind != 'park':
                shares.append((chord / (full[1] - full[0]), name))
            lab += [round(float(chord), 3)] + ([round(float(vc), 3)] if kind == 'water' else [])
    shares.sort()
    print('worst usable share of the run at the anchor:', [(n, round(float(v), 2)) for v, n in shares[:6]])
    save(files)


if __name__ == '__main__':
    if '--init' in sys.argv:
        init_anchors()
    else:
        main()
