"""Add the room each lake and state name has, so the map can hide a name that is wider than its lake or state.

Reads public/basemap/{overview,detail}.json and src/data/midwest-states.json and rewrites the 'water' and 'state'
labels to [name, lng, lat, minZoom, kind, size, chordDeg, heightDeg]:
  chordDeg   the widest run of water (or state) in degrees of longitude, through the label's line of text
  heightDeg  the water straight above and below that point, in degrees of latitude (lakes only)
The anchor also moves to the roomiest spot of its own lake/state part, so a name sits mid-lake, not on the shore.
No dependencies beyond numpy.  Run: python3 pipeline/basemap/fit_labels.py
"""
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/basemap'


def rings_of(geom):
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
    return [[np.array(r) for r in p] for p in polys]


def run(rings, fixed, at, axis):
    """Length of the inside run along `axis` (0 = west-east) through `at`, on the line where the other coordinate is
    `fixed`; even-odd over all rings. 0 when `at` is outside."""
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
            return xs[i + 1] - xs[i]
    return 0.0


def area(r):
    return float((r[:-1, 0] * r[1:, 1] - r[1:, 0] * r[:-1, 1]).sum())


def fit(flat, x0, y0, rows, kind):
    """Search the part's bounding box for the roomiest point (near the first guess); return x, y, chord, height."""
    allp = np.concatenate(flat)
    (x1, y1), (x2, y2) = allp.min(0), allp.max(0)
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
            score -= 0.1 * math.hypot(x - x0, y - y0)  # stay near the first guess unless there is room to gain
            if best is None or score > best[0]:
                best = (score, x, y, chord, vc)
    return best[1:]


# One short form for every park name (forest 'NF', lake shore 'NL', and so on), so none runs three times the others.
SHORT = {
    'Dakota Prairie Grasslands': 'Dakota Prairie NG',
    'George Washington and Jefferson NF': 'Jefferson NF',
    'Land Between the Lakes National Recreation Area': 'Land Between the Lakes NRA',
    'Midewin National Tallgrass Prairie': 'Midewin NTP',
    'Big South Fork NRRA': 'Big South Fork NRA',
}
# Mark Twain NF is a dozen separate tracts: name the three biggest, or the others read as unlabelled outlines.
MORE_PARKS = [('Mark Twain NF', -91.21, 37.69, 6.5), ('Mark Twain NF', -92.13, 37.65, 6.5), ('Mark Twain NF', -90.39, 36.88, 7.0)]


def main():
    states = json.loads((ROOT / 'src/data/midwest-states.json').read_text())['features']
    state_polys = {f['properties']['name'].upper(): rings_of(f['geometry']) for f in states if f['properties']['core']}
    files = {n: json.loads((OUT / f'{n}.json').read_text()) for n in ('overview', 'detail')}
    lakes = [p for d in files.values() for f in d['water']['features'] for p in rings_of(f['geometry'])]
    green = [p for d in files.values() for f in d['green']['features'] for p in rings_of(f['geometry'])]
    detail = files['detail']['labels']
    detail[:] = [lab for lab in detail if not (lab[4] == 'park' and lab[0] == 'Mark Twain NF' and lab[1] != -91.171)]
    for name, x, y, z in MORE_PARKS:
        host = [q for q in green if run(q, y, x, 0) > 0]
        if host:
            x, y, _, _ = fit(max(host, key=lambda q: abs(area(q[0]))), x, y, 0, 'state')
        detail.append([name, round(float(x), 3), round(float(y), 3), z, 'park', 100])
    for lab in detail:
        lab[0] = SHORT.get(lab[0], lab[0])
    for d in files.values():
        for lab in d['labels']:
            name, x, y, z, kind = lab[:5]
            if kind == 'state':
                rows = 0.35
                cands = [p for p in state_polys.get(name, []) if run(p, y, x, 0) > 0]
            elif kind == 'water':
                rows = 0
                cands = [p for p in lakes if run(p, y, x, 0) > 0]
            else:
                continue
            if not cands:
                print('no host for', name)
                continue
            # The biggest shape holding the point (a lake's rings include its islands: even-odd handles them).
            host = max(cands, key=lambda p: abs(area(p[0])))
            nx, ny, chord, vc = fit(host, x, y, rows, kind)
            del lab[6:]
            lab[1], lab[2] = round(float(nx), 3), round(float(ny), 3)
            lab += [round(float(chord), 2)] + ([round(float(vc), 2)] if kind == 'water' else [])
    for n, d in files.items():
        (OUT / f'{n}.json').write_text(json.dumps(d, separators=(',', ':'), ensure_ascii=False))


if __name__ == '__main__':
    main()
