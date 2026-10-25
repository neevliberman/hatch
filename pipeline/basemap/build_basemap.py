"""Build public/basemap/{overview,detail,woods}.json: the map's rivers, lakes, roads, forests and place names.

All public domain: Natural Earth 10m (lakes, rivers, roads, National Park Service areas), the US Forest Service's
national forest boundaries, and the Census Bureau's 2024 place gazetteer (locations) with its 2023 city population
estimates (which towns to name first), and the USGS National Land Cover Database 2021 (where the woods are, woods.json).
Around the Midwest: the other US states (Census, from node_modules/us-atlas, so run `npm ci` first) and Natural Earth's
countries, as quiet land, plus the mask and shore hexagons that trim the forecast to the coasts and state lines.
Run from the repo root: `pip install shapely pyshp numpy scipy matplotlib pillow "h3>=4,<5"`, then
`python3 pipeline/basemap/build_basemap.py`. Downloads go to notebooks/data/basemap/ (git-ignored); reruns are offline.

Town labels sit at downtown for the bigger cities (CITY_CENTRES), and public/basemap/shore.json gives the Great Lakes
shore the finer Census 1:500,000 outline at town scale (shore_fix).

Every feature carries `z`, the zoom it shows from (the app's zoom: the whole Midwest is about 4.5 on a phone and 5.5 on
a laptop, a town fills the screen at 9.5). Labels are [text, lng, lat, z, kind, rank]; the app names higher ranks first
and skips any label that would overlap one already placed.
"""
import csv
import io
import json
import math
import urllib.request
import zipfile
from pathlib import Path

import shapefile
import shapely
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / 'notebooks/data/basemap'
OUT = ROOT / 'public/basemap'
# Two files: what the zoomed-out views show (fetched at start), and the rest (fetched once you zoom in past DETAIL_ZOOM).
DETAIL_ZOOM = 6.5
BBOX = box(-98.5, 36.0, -79.5, 50.0)  # the Midwest view with a margin
NE = 'https://naciscdn.org/naturalearth/10m/'
SOURCES = {
    'ne_10m_lakes': NE + 'physical/ne_10m_lakes.zip',
    'ne_10m_lakes_north_america': NE + 'physical/ne_10m_lakes_north_america.zip',
    'ne_10m_rivers_lake_centerlines': NE + 'physical/ne_10m_rivers_lake_centerlines.zip',
    'ne_10m_rivers_north_america': NE + 'physical/ne_10m_rivers_north_america.zip',
    'ne_10m_roads': NE + 'cultural/ne_10m_roads.zip',
    'ne_10m_parks_and_protected_lands': NE + 'cultural/ne_10m_parks_and_protected_lands.zip',
    'usfs': 'https://data.fs.usda.gov/geodata/edw/edw_resources/shp/S_USA.AdministrativeForest.zip',
    'gaz': 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip',
    'ne_10m_admin_0_countries_lakes': NE + 'cultural/ne_10m_admin_0_countries_lakes.zip',
    # Census 1:500,000 state outlines, clipped to the shore: twenty times finer than the 1:10m ones the app draws.
    'cb_states': 'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_500k.zip',
}
# Quiet land around the Midwest (the other US states, Canada, Mexico), so the widest and tallest screens show
# Pittsburgh on land rather than in water. It reaches past the whole-Midwest view on any screen shape.
CONTEXT_BOX = box(-118.0, 23.0, -60.0, 57.0)
POP_URL = 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv'
# Census state codes: the seven forecast states get their towns named; neighbours only their bigger cities.
CORE = {'17': 'IL', '18': 'IN', '19': 'IA', '26': 'MI', '27': 'MN', '39': 'OH', '55': 'WI'}
NEIGHBOURS = {'29': 'MO', '21': 'KY', '38': 'ND', '46': 'SD', '31': 'NE', '42': 'PA', '54': 'WV'}
MIN_POP_CORE, MIN_POP_NEIGHBOUR = 3000, 40000


def fetch(name, url):
    d = CACHE / name
    if not d.exists():
        print('downloading', url)
        req = urllib.request.Request(url, headers={'User-Agent': 'hatch-basemap'})
        data = urllib.request.urlopen(req, timeout=300).read()
        if url.endswith('.zip'):
            zipfile.ZipFile(io.BytesIO(data)).extractall(d)
        else:
            d.mkdir(parents=True)
            (d / Path(url).name).write_bytes(data)
    return d


_land = None


def land():
    """The US states the map draws as paper (the forecast states and their neighbours). Canada is water-coloured on
    this map, so lines there would float in the lake."""
    global _land
    if _land is None:
        data = json.loads((ROOT / 'src/data/midwest-states.json').read_text())
        _land = unary_union([shape(f['geometry']) for f in data['features']]).buffer(0.01)
    return _land


def read(name, stem=None, within=BBOX):
    """(geometry, record) for each shape in the download that touches the Midwest (or `within`), clipped to it."""
    d = fetch(name, SOURCES[name])
    shp = next(d.glob(f'{stem or "*"}.shp'))
    for sr in shapefile.Reader(str(shp)).iterShapeRecords():
        if sr.shape.shapeType == 0:
            continue
        g = shape(sr.shape.__geo_interface__)
        if g.intersects(within):
            yield g.intersection(within), sr.record.as_dict()


def rounded(geom, tol, nd=3):
    """Simplified, coordinates to 3 decimals (about 100 m, a pixel or less at the closest zoom); `nd` for more."""
    if geom.geom_type == 'GeometryCollection':  # a line clipped at a shore can leave stray points: keep the lines
        geom = unary_union([p for p in geom.geoms if p.geom_type in ('LineString', 'MultiLineString')])
    g = geom.simplify(tol, preserve_topology=True)
    if g.is_empty:
        return None

    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]

    m = mapping(g)
    if m['type'] == 'GeometryCollection':
        return None
    return {'type': m['type'], 'coordinates': r(m['coordinates'])}


def feature(geom, tol, **props):
    g = rounded(geom, tol)
    return {'type': 'Feature', 'geometry': g, 'properties': props} if g else None


def zoom_for_size(km):
    """The zoom at which something km across spans ~25 px (one degree of latitude is ~111 km; 512 px world at zoom 0)."""
    deg = km / 111.0
    return math.log2(25 * 360 / (512 * max(deg, 1e-6)))


def lakes():
    feats, labels = [], []
    for name in ('ne_10m_lakes', 'ne_10m_lakes_north_america'):
        for g, rec in read(name):
            if g.is_empty or g.geom_type not in ('Polygon', 'MultiPolygon'):
                continue
            great = rec.get('scalerank') == 0
            if not great:
                g = g.intersection(land())
                if g.is_empty or g.geom_type not in ('Polygon', 'MultiPolygon'):
                    continue
            size_km = math.sqrt(g.area) * 111 * 0.72
            z = 0 if great else max(5.0, min(8.5, zoom_for_size(size_km)))
            f = feature(g, 0.002, z=round(z, 1), great=1 if great else 0)
            if f:
                feats.append(f)
            label = rec.get('label') or rec.get('name')
            if label and (great or size_km > 4):
                p = g.representative_point()
                # The big lakes are named from the start; a small "great lake" (St. Clair) waits like any other.
                lz = 0 if great and size_km > 100 else max(z, 6.0) + 1.0
                labels.append([label, round(p.x, 3), round(p.y, 3), round(lz, 1), 'water', round(size_km)])
    return feats, labels


_borders = None


def borders():
    """The state lines the app draws (src/data/midwest-states.json), as lines."""
    global _borders
    if _borders is None:
        data = json.loads((ROOT / 'src/data/midwest-states.json').read_text())
        _borders = unary_union([shape(f['geometry']).boundary for f in data['features']])
    return _borders


def merge(g):
    from shapely.ops import linemerge
    return linemerge(g) if g.geom_type == 'MultiLineString' else g


SNAP_DEG = 0.025   # a river this close to a state line (~2.5 km) is taken to be the line
SNAP_RUN = 0.1     # ... if it follows it for at least ~10 km (a crossing is not a border river)


def snap_to_borders(g):
    """A border river (the Ohio, the Mississippi, the Wabash, the St. Croix) drawn on the state line itself.

    The state lines (Census 1:10m) and the rivers (Natural Earth) trace the same water a kilometre or two apart, so
    zoomed in they read as two lines side by side. Where a river runs along a state line, the river takes the line's
    path, with a short jog where it joins and leaves it."""
    from shapely.geometry import LineString, MultiLineString
    from shapely.ops import nearest_points
    if g.is_empty:
        return g
    along = borders().intersection(g.buffer(SNAP_DEG))
    pieces = [along] if along.geom_type == 'LineString' else [p for p in getattr(along, 'geoms', []) if p.geom_type == 'LineString']
    if not pieces:
        return g
    merged = merge(unary_union(pieces))
    runs = [r for r in getattr(merged, 'geoms', [merged]) if r.geom_type == 'LineString' and r.length >= SNAP_RUN]
    if not runs:
        return g
    run = MultiLineString(runs)
    rest = g.difference(run.buffer(SNAP_DEG * 1.2))
    out = [rest] if not rest.is_empty else []
    # Join each loose end of what is left to the state line it now follows.
    ends = []
    for line in getattr(rest, 'geoms', [rest]):
        if line.geom_type == 'LineString' and not line.is_empty:
            ends += [line.coords[0], line.coords[-1]]
    from shapely.geometry import Point
    for e in ends:
        pt = Point(e)
        if pt.distance(run) <= SNAP_DEG * 1.3:
            out.append(LineString([e, nearest_points(run, pt)[0].coords[0]]))
    out.append(run)
    return merge(unary_union(out))


def rivers():
    feats = []
    for name in ('ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_north_america'):
        for g, rec in read(name):
            if g.is_empty or rec.get('featurecla') == 'Lake Centerline':
                continue
            g = snap_to_borders(g.intersection(land()))
            rank = rec['scalerank']
            # The big rivers (Mississippi, Ohio, Missouri) from the start; the North America extras as you zoom.
            z = max(0.0, float(rec['min_zoom']) - 0.5)
            w = 2.0 if rank <= 5 else 1.4 if rank <= 9 else 1.0
            f = feature(g, 0.002, z=round(z, 1), w=w)
            if f:
                feats.append(f)
    return feats


def roads():
    feats = []
    for g, rec in read('ne_10m_roads'):
        # Only the interstates and other major highways: enough to find your way, few enough to stay quiet.
        if g.is_empty or rec['featurecla'] != 'Road' or rec['type'] != 'Major Highway':
            continue
        g = g.intersection(land())
        f = feature(g, 0.002, z=6.5 if rec['scalerank'] <= 5 else 7.5)
        if f:
            feats.append(f)
    return feats


def big_parts(g, min_km2=20):
    """Only the pieces of a forest bigger than min_km2: the scattered small tracts read as specks, not forest."""
    parts = [p for p in getattr(g, 'geoms', [g]) if p.geom_type == 'Polygon' and p.area * 111 * 111 * 0.72 >= min_km2]
    return unary_union(parts) if parts else None


def forests():
    feats, labels = [], []
    for g, rec in read('usfs', 'S_USA.AdministrativeForest'):
        if g.is_empty:
            continue
        name = rec['FORESTNAME']
        g = big_parts(g.intersection(land()))
        if g is None:
            continue
        f = feature(g, 0.003, z=6.5)
        if f:
            feats.append(f)
        p = g.representative_point()
        labels.append([name.replace(' National Forests', ' NF').replace(' National Forest', ' NF'),
                       round(p.x, 3), round(p.y, 3), 6.5, 'park', round(g.area * 1000)])
    for g, rec in read('ne_10m_parks_and_protected_lands', '*_area'):
        g = g.intersection(land())
        if g.is_empty:
            continue
        f = feature(g, 0.002, z=6.5)
        if f:
            feats.append(f)
        p = g.representative_point()
        labels.append([rec['unit_name'], round(p.x, 3), round(p.y, 3), 6.5, 'park', round(g.area * 1000)])
    return feats, labels


SUFFIXES = (' urban county', ' metro government', ' city', ' village', ' town', ' borough')


def town_name(name):
    """'Madison city' -> 'Madison', 'Indianapolis city (balance)' -> 'Indianapolis', 'Louisville/Jefferson County ...'
    -> 'Louisville', 'Lexington-Fayette urban county' -> 'Lexington'."""
    name = name.replace(' (balance)', '').split('/')[0]
    for suffix in SUFFIXES:
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return 'Lexington' if name == 'Lexington-Fayette' else name


# The gazetteer's point for a place is the middle of its outline, which for a big or oddly shaped city sits kilometres
# from downtown: Chicago's is 6 km inland of the Loop, Louisville's (a merged city and county) 9 km east of the river.
# These are downtown points for the larger cities; a smaller place keeps the gazetteer's point, which is within a
# kilometre or two of it. A name with two entries (Springfield) takes the one near the gazetteer's point.
CITY_CENTRES = {
    'Chicago': [(-87.6298, 41.8781)], 'Columbus': [(-82.9988, 39.9612)], 'Indianapolis': [(-86.1581, 39.7684)],
    'Detroit': [(-83.0458, 42.3314)], 'Louisville': [(-85.7585, 38.2527)], 'Milwaukee': [(-87.9065, 43.0389)],
    'Kansas City': [(-94.5786, 39.0997)], 'Omaha': [(-95.9345, 41.2565)], 'Minneapolis': [(-93.2650, 44.9778)],
    'Cleveland': [(-81.6944, 41.4993)], 'Lexington': [(-84.5037, 38.0406)], 'Cincinnati': [(-84.5120, 39.1031)],
    'St. Paul': [(-93.0900, 44.9537)], 'Pittsburgh': [(-79.9959, 40.4406)], 'Lincoln': [(-96.7026, 40.8136)],
    'St. Louis': [(-90.1994, 38.6270)], 'Madison': [(-89.4012, 43.0731)], 'Fort Wayne': [(-85.1394, 41.0793)],
    'Toledo': [(-83.5379, 41.6528)], 'Des Moines': [(-93.6250, 41.5868)], 'Sioux Falls': [(-96.7311, 43.5446)],
    'Grand Rapids': [(-85.6681, 42.9634)], 'Akron': [(-81.5190, 41.0814)], 'Aurora': [(-88.3201, 41.7606)],
    'Springfield': [(-93.2923, 37.2089), (-89.6440, 39.7990)], 'Joliet': [(-88.0817, 41.5250)],
    'Rockford': [(-89.0940, 42.2711)], 'Cedar Rapids': [(-91.6656, 41.9779)], 'Dayton': [(-84.1916, 39.7589)],
    'Fargo': [(-96.7898, 46.8772)], 'Rochester': [(-92.4802, 44.0121)], 'Ann Arbor': [(-83.7430, 42.2808)],
    'Evansville': [(-87.5711, 37.9716)], 'Lansing': [(-84.5555, 42.7325)], 'Peoria': [(-89.5890, 40.6936)],
    'Green Bay': [(-88.0133, 44.5133)], 'South Bend': [(-86.2520, 41.6764)], 'Davenport': [(-90.5776, 41.5236)],
    'Duluth': [(-92.1005, 46.7867)], 'Gary': [(-87.3464, 41.5934)], 'Racine': [(-87.7829, 42.7261)],
    'Kenosha': [(-87.8212, 42.5847)], 'Waukegan': [(-87.8448, 42.3636)], 'Evanston': [(-87.6877, 42.0451)],
    'Sheboygan': [(-87.7145, 43.7508)], 'Muskegon': [(-86.2484, 43.2342)], 'Erie': [(-80.0851, 42.1292)],
    'Traverse City': [(-85.6206, 44.7631)], 'Independence': [(-94.4155, 39.0911)], 'Rock Island': [(-90.5776, 41.5095)],
}
CENTRE_REACH = 0.25  # degrees: a downtown point further than this from the gazetteer's is a different place


def downtown(name, lng, lat):
    near = [c for c in CITY_CENTRES.get(name, []) if abs(c[0] - lng) < CENTRE_REACH and abs(c[1] - lat) < CENTRE_REACH]
    return min(near, key=lambda c: (c[0] - lng) ** 2 + (c[1] - lat) ** 2) if near else (lng, lat)


def towns():
    pop = {}
    d = fetch('popest', POP_URL)
    with open(next(d.glob('*.csv')), encoding='latin-1') as fh:
        for row in csv.DictReader(fh):
            if row['SUMLEV'] == '162':
                pop[row['STATE'] + row['PLACE']] = int(row['POPESTIMATE2023'])
    labels = []
    d = fetch('gaz', SOURCES['gaz'])
    with open(next(d.glob('*.txt')), encoding='utf-8') as fh:
        rows = csv.reader(fh, delimiter='\t')
        head = [h.strip() for h in next(rows)]
        for row in rows:
            r = dict(zip(head, (c.strip() for c in row)))
            st = r['GEOID'][:2]
            n = pop.get(r['GEOID'])
            if n is None or st not in CORE and st not in NEIGHBOURS:
                continue
            if n < (MIN_POP_CORE if st in CORE else MIN_POP_NEIGHBOUR):
                continue
            lng, lat = float(r['INTPTLONG']), float(r['INTPTLAT'])
            if not BBOX.contains(box(lng, lat, lng, lat)):
                continue
            name = town_name(r['NAME'])
            lng, lat = downtown(name, lng, lat)
            # Big cities from the whole-Midwest view; a town of 2,000 from about town scale.
            z = 4.6 + (6.0 - math.log10(n)) / 0.5
            labels.append([name, round(lng, 3), round(lat, 3), round(max(0.0, z), 1),
                           'city' if n >= 100000 else 'town', n])
    # A city and a village of the same name side by side (Pewaukee, WI) would print twice: keep the bigger one.
    labels.sort(key=lambda lab: -lab[5])
    kept = []
    for lab in labels:
        if not any(k[0] == lab[0] and abs(k[1] - lab[1]) < 0.2 and abs(k[2] - lab[2]) < 0.15 for k in kept):
            kept.append(lab)
    return kept


def states():
    """A name for each forecast state, for the zoomed-out views (placed by hand where the shape misleads)."""
    data = json.loads((ROOT / 'src/data/midwest-states.json').read_text())
    at = {'MI': (-84.7, 43.6), 'MN': (-94.4, 46.0), 'IL': (-89.2, 40.0), 'OH': (-82.8, 40.3)}
    out = []
    for f in data['features']:
        p = f['properties']
        if not p.get('core'):
            continue
        g = shape(f['geometry'])
        x, y = at.get(p['abbr']) or (lambda q: (q.x, q.y))(g.representative_point())
        out.append([p['name'].upper(), round(x, 2), round(y, 2), 0, 'state', 0])
    return out


NLCD_WMS = ('https://www.mrlc.gov/geoserver/mrlc_display/wms?service=WMS&version=1.1.1&request=GetMap'
            '&layers=NLCD_2021_Land_Cover_L48&styles=&srs=EPSG:4326&format=image/png')
# NLCD 2021 classes by their colour in the WMS palette: 41 deciduous forest, 43 mixed forest (luna moth country:
# birch, walnut, hickory, sweetgum). Evergreen (42) and wooded wetland are left out.
WOODS_RGB = [(104, 170, 99), (181, 201, 142)]


def woods():
    """Where deciduous and mixed woods dominate, as smooth polygons (USGS NLCD 2021, public domain).

    NLCD is 30 m; the map server samples it every 0.005 degrees (~500 m), which is noisy pixel by pixel but an
    unbiased sample. Blurring that over ~1.5 km gives the share of woods around each point, and the 40% contour
    of the share is the outline: like squinting at an aerial photo until the woodlots merge into woods."""
    import numpy as np
    from PIL import Image
    from scipy.ndimage import gaussian_filter
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from shapely.geometry import Polygon

    w, s, e, n = BBOX.bounds
    nx, ny, px = 5, 4, 0.005
    d = CACHE / 'nlcd'
    d.mkdir(parents=True, exist_ok=True)
    rows = []
    for j in reversed(range(ny)):
        row = []
        for i in range(nx):
            f = d / f't_{i}_{j}.png'
            if not f.exists():
                x0, x1 = w + (e - w) * i / nx, w + (e - w) * (i + 1) / nx
                y0, y1 = s + (n - s) * j / ny, s + (n - s) * (j + 1) / ny
                url = f'{NLCD_WMS}&bbox={x0},{y0},{x1},{y1}&width={round((x1 - x0) / px)}&height={round((y1 - y0) / px)}'
                print('downloading NLCD tile', i, j)
                f.write_bytes(urllib.request.urlopen(url, timeout=300).read())
            row.append(np.asarray(Image.open(f).convert('RGB')))
        rows.append(np.concatenate(row, axis=1))
    a = np.concatenate(rows, axis=0)
    mask = np.zeros(a.shape[:2])
    for c in WOODS_RGB:
        mask += np.all(a == np.array(c, dtype=np.uint8), axis=2)
    share = gaussian_filter(mask, 3)
    cs = plt.contourf(np.linspace(w, e, a.shape[1]), np.linspace(n, s, a.shape[0]), share, levels=[0.4, 2])
    rings = [Polygon(r).buffer(0) for path in cs.get_paths() for r in path.to_polygons() if len(r) >= 4]
    g = Polygon()
    for r in rings:  # contour rings nest (woods, clearing, woodlot in the clearing): even-odd fill
        g = g.symmetric_difference(r)
    g = big_parts(g.intersection(land()), min_km2=10)
    if g is None or g.is_empty:
        return []
    f = feature(g, 0.004, z=6.0)
    return [f] if f else []


def us_atlas():
    """Every US state from us-atlas (the Census 1:10m outlines src/data/midwest-states.json is cut from, so shared
    borders match it): ({fips: [polygon as lists of arc ids]}, decoded arcs). Needs `npm ci` (node_modules)."""
    topo = json.loads((ROOT / 'node_modules/us-atlas/states-10m.json').read_text())
    (sx, sy), (tx, ty) = topo['transform']['scale'], topo['transform']['translate']
    arcs = []
    for arc in topo['arcs']:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((round(x * sx + tx, 3), round(y * sy + ty, 3)))
        arcs.append(pts)
    states = {}
    for g in topo['objects']['states']['geometries']:
        states[str(g['id']).zfill(2)] = g['arcs'] if g['type'] == 'MultiPolygon' else [g['arcs']]
    return states, arcs


def ring(arc_ids, arcs):
    pts = []
    for i in arc_ids:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts += a if not pts else a[1:]
    return pts


# The states src/data/midwest-states.json already has (scripts/build-geo.mjs), by Census FIPS code.
DRAWN = ('55', '17', '27', '19', '26', '18', '39', '29', '38', '46', '31', '21')


def context():
    """The quiet land around the forecast states, and a mask for the app: (outside features, far Great Lakes).

    `outside` is drawn over the hexagons: the sea (kind 0) and the land beyond the seven forecast states (kind 1) cover
    everything but those states, so a hexagon poking out over a shore or a state line is cut off there, as the lakes cut
    the shore hexagons. Kind 2 are the faint lines of the US states the app does not outline already."""
    from shapely.geometry import LineString, MultiLineString, Polygon
    data = json.loads((ROOT / 'src/data/midwest-states.json').read_text())
    core = unary_union([shape(f['geometry']) for f in data['features'] if f['properties']['core']])
    states, arcs = us_atlas()
    drawn = {i if i >= 0 else ~i for fips in DRAWN for poly in states[fips] for r in poly for i in r}
    # Simplify each arc once, so shared borders stay shared; never the arcs of the states the app already draws.
    simple = []
    for k, a in enumerate(arcs):
        pts = a
        if k not in drawn and len(a) > 2:
            sl = [(round(x, 3), round(y, 3)) for x, y in LineString(a).simplify(0.02).coords]
            pts = sl if len(sl) >= (4 if a[0] == a[-1] else 2) else a
        simple.append(pts)
    polys, lines = [], {}
    for fips, ps in states.items():
        if fips in DRAWN:
            continue
        for poly in ps:
            rings = [ring(r, simple) for r in poly]
            if len(rings[0]) < 4:
                continue
            g = Polygon(rings[0], [r for r in rings[1:] if len(r) >= 4]).buffer(0)
            if g.intersects(CONTEXT_BOX):
                polys.append(g)
                for i in {i if i >= 0 else ~i for r in poly for i in r}:
                    lines[i] = lines.get(i, 0) + 1
    neighbours = [shape(f['geometry']) for f in data['features'] if not f['properties']['core']]
    us = unary_union(polys + neighbours + [core])
    # Canada, Mexico and the islands: Natural Earth (big lakes cut out), coarsely: it is only context. The two sources
    # draw the border a little apart, so these are widened ~300 m and the US taken out: no hairline of sea opens along
    # the land border, while the Detroit and St. Clair rivers (about a kilometre wide) stay open.
    abroad = []
    for g, rec in read('ne_10m_admin_0_countries_lakes', within=CONTEXT_BOX):
        if rec.get('ADM0_A3') != 'USA' and not g.is_empty:
            # Coarse, but full detail within ~30 km of the forecast states (the river shores along Michigan).
            near = core.buffer(0.3, quad_segs=2)
            g = unary_union([g.simplify(0.02, preserve_topology=True).difference(near), g.intersection(near)])
            g = big_parts(g, min_km2=200)
            if g is not None:
                abroad.append(g.buffer(0.003, quad_segs=1))
    # The other states are widened ~300 m too: rounding can leave a 100 m crack against the forecast states.
    land_ctx = unary_union([unary_union(polys).buffer(0.003, quad_segs=1), unary_union(abroad).difference(us),
                            *neighbours])
    # Coarse away from the forecast states, exact against them.
    land_ctx = land_ctx.intersection(CONTEXT_BOX)
    near = core.buffer(0.08, quad_segs=2)
    land_ctx = unary_union([land_ctx.simplify(0.02).difference(near), land_ctx.intersection(near)])
    land_ctx = land_ctx.difference(core)
    # The sea only matters near the forecast states (where hexagons poke out): beyond, the page's own water shows.
    sea = CONTEXT_BOX.difference(core).difference(land_ctx).intersection(core.buffer(0.7, quad_segs=2))
    # Only the borders between two states (an arc of one state alone is a coast or the border with Canada or Mexico,
    # which the land colour already shows or need not).
    shared = sorted(i for i, n in lines.items() if n > 1 and i not in drawn)
    outline = MultiLineString([simple[i] for i in shared]).intersection(box(-106.0, 24.0, -66.0, 50.0))
    feats = [f for f in (exact_feature(sea, z=0, kind=0), exact_feature(land_ctx, z=0, kind=1),
                         exact_feature(outline, z=0, kind=2)) if f]
    for f in feats:
        print('outside kind', f['properties']['kind'], f'{len(json.dumps(f)) / 1024:.0f} KB')
    # The Great Lakes past the detail box (the east end of Erie, Lake Ontario): there is land around them now.
    far = []
    for g, rec in read('ne_10m_lakes', within=CONTEXT_BOX):
        if rec.get('scalerank') != 0:
            continue
        g = g.difference(BBOX)
        if not g.is_empty and g.geom_type in ('Polygon', 'MultiPolygon'):
            f = feature(g, 0.004, z=0, great=1)
            if f:
                far.append(f)
    return feats, far, sea


def exact_feature(geom, **props):
    """Like feature(), without simplifying: these shapes must meet the state outlines exactly."""
    if geom.geom_type == 'GeometryCollection':
        geom = unary_union([p for p in geom.geoms if p.geom_type != 'Point'])
    if geom.is_empty:
        return None

    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], 3), round(c[1], 3)]
        return [r(x) for x in c]

    m = mapping(geom)
    return {'type': 'Feature', 'geometry': {'type': m['type'], 'coordinates': r(m['coordinates'])}, 'properties': props}


def pads(res, dry=None):
    """Hexagons just outside the forecast ones, each paired with a forecast neighbour whose colour it takes.

    A forecast hexagon is one whose centre is in a forecast state, so up to half a hexagon of bare paper is left along
    every shore and state line, which reads as missing data. The app draws these under the forecast hexagons in their
    neighbour's colour, and the lakes and the `outside` mask cut them off at the shore and the state line. Only the
    ones reaching into a forecast state are kept. [[pad, neighbour], ...]"""
    import h3
    from shapely.geometry import Polygon
    data = json.loads((ROOT / 'src/data/midwest-states.json').read_text())
    cells = set()
    for f in data['features']:
        if f['properties']['core']:
            cells.update(h3.geo_to_cells(f['geometry'], res))
    core = unary_union([shape(f['geometry']) for f in data['features'] if f['properties']['core']])
    if dry is not None:
        core = core.union(dry)   # the shore land the Census 1:500,000 outline gives back (see shore_fix)
    out = {}
    for c in sorted(cells):
        for n in sorted(h3.grid_disk(c, 1)):
            if n not in cells and n not in out and Polygon([(x, y) for y, x in h3.cell_to_boundary(n)]).intersects(core):
                out[n] = c
    return sorted([p, c] for p, c in out.items())


SHORE_STATES = ('IL', 'IN', 'OH', 'MI', 'WI', 'MN')   # the forecast states on a Great Lake
SHORE_BAND = 0.25  # degrees: only within ~25 km of a Great Lake; inland the two outlines agree on borders
SHORE_WIDTH = 0.0015  # degrees: strips thinner than ~0.35 km are left alone
SHORE_TOL = 0.001  # ~100 m, a pixel at zoom 10; the 1:500,000 outline's own vertices are about this far apart


def shore_fix():
    """(dry, wet): where the map's Great Lakes shore is wrong at town scale (public domain Census data).

    The state outlines the app draws are Census 1:10m, whose shore is smoothed over a kilometre or so: the Streeterville
    and Navy Pier landfill in Chicago is lake on the map, Milwaukee's harbour is land. The Census 1:500,000 outlines are
    clipped to the real shore and about twenty times finer, but too big to ship whole (and the 1:10m ones feed the
    forecast grid, which must not move). So only the difference along the Great Lakes is kept:
    `dry` is shore land the map shows as water (cut out of the lakes and the sea mask, and given hexagons), `wet` is
    water it shows as land (painted over it, see shore_file)."""
    data = json.loads((ROOT / 'src/data/midwest-states.json').read_text())
    ten = unary_union([shape(f['geometry']).buffer(0) for f in data['features']])
    great = unary_union([g.buffer(0) for name in ('ne_10m_lakes', 'ne_10m_lakes_north_america') for g, rec in read(name)
                         if rec.get('scalerank') == 0 and g.geom_type in ('Polygon', 'MultiPolygon')])
    band = great.buffer(SHORE_BAND, quad_segs=2)
    fine = unary_union([g.buffer(0) for g, rec in read('cb_states', 'cb_2023_us_state_500k')
                        if rec['STUSPS'] in SHORE_STATES])
    drawn = ten.difference(great)   # what the app paints as land beside the lakes
    def wide(g):
        # Only the strips wider than SHORE_WIDTH (an error under a couple of pixels at the closest zoom is no news),
        # simplified like the rest of the basemap.
        return unary_union([p.simplify(SHORE_TOL, preserve_topology=True) for p in getattr(g, 'geoms', [g])
                            if p.geom_type == 'Polygon' and not p.buffer(-SHORE_WIDTH).is_empty])
    return wide(fine.intersection(band).difference(drawn)), wide(drawn.intersection(band).difference(fine))


def shore_file(dry, wet, sea):
    """shore.json, fetched once the map is zoomed in to town scale. From there the app draws the Great Lakes' shore from
    it instead of from the Natural Earth lakes (which it then leaves out): `sea` is the sea mask as context() made it
    with the shore land given back (`dry`) cut out; `dry` is that land, filled under the hexagons; `wet` is the water
    the 1:10m outline keeps dry, painted over it; `ink` is the state lines without their coast, since the old coast now
    runs inland of the shore, through the land that was given back. `sea` is the sea mask as context() made it."""
    data = json.loads((ROOT / 'src/data/midwest-states.json').read_text())
    core = unary_union([shape(f['geometry']).buffer(0) for f in data['features'] if f['properties']['core']])
    ink = core.boundary.difference(sea.buffer(0.002, quad_segs=1))

    def snapped(geom):
        # On the 0.001-degree grid the coordinates are written at, so rounding cannot fold a thin strip or a narrow
        # channel into a self-touching ring, which the map's polygon fill would draw as stray triangles.
        return shapely.set_precision(geom.buffer(0), 0.001)

    def collection(geom):
        feats = []
        for part in getattr(snapped(geom), 'geoms', [geom]):
            g = rounded(part, SHORE_TOL) if part.geom_type == 'Polygon' and not part.is_empty else None
            if g:
                feats.append({'type': 'Feature', 'geometry': g, 'properties': {}})
        return {'type': 'FeatureCollection', 'features': feats}

    return {'version': 1,
            'sea': exact_feature(snapped(sea.difference(dry)), z=0, kind=0),
            'dry': collection(dry), 'wet': collection(wet),
            'ink': {'type': 'Feature', 'geometry': rounded(ink, SHORE_TOL), 'properties': {}}}


def main():
    dry, wet = shore_fix()
    water, water_labels = lakes()
    green, green_labels = forests()
    outside, far_lakes, sea = context()
    layers = {'water': water + far_lakes, 'rivers': rivers(), 'roads': roads(), 'green': green, 'outside': outside}
    labels = states() + water_labels + green_labels + towns()
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / 'woods.json'
    path.write_text(json.dumps({'version': 1, 'woods': {'type': 'FeatureCollection', 'features': woods()}},
                               separators=(',', ':')))
    print(path, f'{path.stat().st_size / 1024:.0f} KB')
    # The shore fix's water and state lines (see shore_file) are their own file: only a town-scale view needs them.
    path = OUT / 'shore.json'
    path.write_text(json.dumps(shore_file(dry, wet, sea), separators=(',', ':')))
    print(path, f'{path.stat().st_size / 1024:.0f} KB')
    for part, near in (('overview', False), ('detail', True)):
        keep = lambda z: (z >= DETAIL_ZOOM) == near  # noqa: E731
        out = {'version': 1}
        for k, feats in layers.items():
            out[k] = {'type': 'FeatureCollection', 'features': [f for f in feats if keep(f['properties']['z'])]}
        out['labels'] = [lab for lab in labels if keep(lab[3])]
        # The extra shore hexagons (see pads): the whole-Midwest level at start, the finer levels once zoomed in.
        out['pads'] = {str(r): pads(r, dry if near else None) for r in ((5, 6) if near else (4,))}
        path = OUT / f'{part}.json'
        path.write_text(json.dumps(out, separators=(',', ':'), ensure_ascii=False))
        print(path, f'{path.stat().st_size / 1024:.0f} KB,',
              {k: len(v['features']) for k, v in out.items() if k != 'pads' and isinstance(v, dict)},
              len(out['labels']), 'labels', {r: len(v) for r, v in out['pads'].items()}, 'pads')


if __name__ == '__main__':
    main()
