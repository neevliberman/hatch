"""Build public/basemap/{overview,detail}.json: the map's rivers, lakes, roads, forests and place names.

All public domain: Natural Earth 10m (lakes, rivers, roads, National Park Service areas), the US Forest Service's
national forest boundaries, and the Census Bureau's 2024 place gazetteer (locations) with its 2023 city population
estimates (which towns to name first). Run from the repo root: `pip install shapely pyshp`, then
`python3 pipeline/basemap/build_basemap.py`. Downloads go to notebooks/data/basemap/ (git-ignored); reruns are offline.

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
}
POP_URL = 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv'
# Census state codes: the seven forecast states get their towns named; neighbours only their bigger cities.
CORE = {'17': 'IL', '18': 'IN', '19': 'IA', '26': 'MI', '27': 'MN', '39': 'OH', '55': 'WI'}
NEIGHBOURS = {'29': 'MO', '21': 'KY', '38': 'ND', '46': 'SD', '31': 'NE', '42': 'PA', '54': 'WV'}
MIN_POP_CORE, MIN_POP_NEIGHBOUR = 1500, 40000


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


def read(name, stem=None):
    """(geometry, record) for each shape in the download that touches the Midwest, clipped to it."""
    d = fetch(name, SOURCES[name])
    shp = next(d.glob(f'{stem or "*"}.shp'))
    for sr in shapefile.Reader(str(shp)).iterShapeRecords():
        if sr.shape.shapeType == 0:
            continue
        g = shape(sr.shape.__geo_interface__)
        if g.intersects(BBOX):
            yield g.intersection(BBOX), sr.record.as_dict()


def rounded(geom, tol):
    """Simplified, coordinates to 3 decimals (about 100 m, a pixel or less at the closest zoom)."""
    if geom.geom_type == 'GeometryCollection':  # a line clipped at a shore can leave stray points: keep the lines
        geom = unary_union([p for p in geom.geoms if p.geom_type in ('LineString', 'MultiLineString')])
    g = geom.simplify(tol, preserve_topology=True)
    if g.is_empty:
        return None

    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], 3), round(c[1], 3)]
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


def rivers():
    feats = []
    for name in ('ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_north_america'):
        for g, rec in read(name):
            if g.is_empty or rec.get('featurecla') == 'Lake Centerline':
                continue
            g = g.intersection(land())
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


def forests():
    feats, labels = [], []
    for g, rec in read('usfs', 'S_USA.AdministrativeForest'):
        if g.is_empty:
            continue
        name = rec['FORESTNAME']
        f = feature(g, 0.003, z=6.5)
        if f:
            feats.append(f)
        p = g.representative_point()
        labels.append([name.replace(' National Forests', ' NF').replace(' National Forest', ' NF'),
                       round(p.x, 3), round(p.y, 3), 6.5, 'park', round(g.area * 1000)])
    for g, rec in read('ne_10m_parks_and_protected_lands', '*_area'):
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
            # Big cities from the whole-Midwest view; a town of 2,000 from about town scale.
            z = 4.3 + (6.0 - math.log10(n)) / 0.55
            labels.append([name, round(lng, 3), round(lat, 3), round(max(0.0, z), 1),
                           'city' if n >= 100000 else 'town', n])
    return labels


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


def main():
    water, water_labels = lakes()
    green, green_labels = forests()
    layers = {'water': water, 'rivers': rivers(), 'roads': roads(), 'green': green}
    labels = states() + water_labels + green_labels + towns()
    OUT.mkdir(parents=True, exist_ok=True)
    for part, near in (('overview', False), ('detail', True)):
        keep = lambda z: (z >= DETAIL_ZOOM) == near  # noqa: E731
        out = {'version': 1}
        for k, feats in layers.items():
            out[k] = {'type': 'FeatureCollection', 'features': [f for f in feats if keep(f['properties']['z'])]}
        out['labels'] = [lab for lab in labels if keep(lab[3])]
        path = OUT / f'{part}.json'
        path.write_text(json.dumps(out, separators=(',', ':'), ensure_ascii=False))
        print(path, f'{path.stat().st_size / 1024:.0f} KB,',
              {k: len(v['features']) for k, v in out.items() if isinstance(v, dict)}, len(out['labels']), 'labels')


if __name__ == '__main__':
    main()
