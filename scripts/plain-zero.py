# Atkinson Hyperlegible draws its zero slashed, which in running text reads as "Ø" ("1Ø days"), and the font has no
# plain alternate to switch on with font-feature-settings. This swaps in a plain zero: the zero's own outline, with
# the letter O's counter fitted inside it at the O's stroke thickness (see src/fonts/README.md).
# Usage: python3 scripts/plain-zero.py in.woff2 out.woff2 (needs fontTools)
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.boundsPen import BoundsPen

src, dst = sys.argv[1], sys.argv[2]
f = TTFont(src)
gs = f.getGlyphSet()

def contours(name):
    p = RecordingPen()
    gs[name].draw(p)
    out, cur = [], []
    for op, args in p.value:
        cur.append((op, args))
        if op in ('closePath', 'endPath'):
            out.append(cur)
            cur = []
    return out

def bounds(cs):
    b = BoundsPen(None)
    for c in cs:
        for op, args in c:
            getattr(b, op)(*args)
    return b.bounds

def area(c):
    pts = [a[-1] for op, a in c if a]
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])) / 2

z, o = contours('zero'), contours('O')
assert len(z) == 3 and len(o) == 2, (len(z), len(o))
zo = max(z, key=lambda c: abs(area(c)))  # outer contour of the zero
oo = max(o, key=lambda c: abs(area(c)))
oi = min(o, key=lambda c: abs(area(c)))  # the O's counter
zx0, zy0, zx1, zy1 = bounds([zo])
ox0, oy0, ox1, oy1 = bounds([oo])
ix0, iy0, ix1, iy1 = bounds([oi])
# Keep the O's stroke thickness: the counter is inset from the zero's outline by the O's own stems.
nx0, nx1, ny0, ny1 = zx0 + (ix0 - ox0), zx1 - (ox1 - ix1), zy0 + (iy0 - oy0), zy1 - (oy1 - iy1)
sx, sy = (nx1 - nx0) / (ix1 - ix0), (ny1 - ny0) / (iy1 - iy0)
tr = lambda p: (round(nx0 + (p[0] - ix0) * sx), round(ny0 + (p[1] - iy0) * sy))

pen = TTGlyphPen(None)
for op, args in zo:
    getattr(pen, op)(*args)
for op, args in oi:
    getattr(pen, op)(*[tr(a) for a in args])
g = pen.glyph()
f['glyf']['zero'] = g
g.recalcBounds(f['glyf'])
f.flavor = 'woff2'
f.save(dst)
print('ok', sx, sy)
