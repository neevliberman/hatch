"""Build public/atlas/tree.json: the Atlas species placed on a real family tree (Open Tree of Life synthetic tree).

Steps: match each scientific name to an Open Tree taxon (TNRS), ask for the induced subtree of those taxa (the shared
branching pattern only: no branch lengths), collapse single-child links, then name the branches that are exactly one
order / family / genus. Species the tree lacks are grafted next to their closest relative in the species list (same
genus, else family, else order) and flagged in "g" so the app can say so.

Then each named family and genus gets iNaturalist's English group name where it has a short, real one ("Carabidae":
"Ground beetles"), in "c"; orders keep their hand-picked names (src/atlas/names.ts ORDER_NAMES).

tree.json: {"src": str, "g": [species index...], "c": {latin: common}, "t": node}; node = [label, rank, child, child, ...]
with rank one of "" (unnamed branch), "o", "f", "g"; a leaf is the species' index in species.json.
Analogy: ask a librarian for the shelf plan of just our 1,900 books, then label the shelves that hold one subject.
  python3 pipeline/atlas/build_tree.py           # the whole tree (network: Open Tree of Life, iNaturalist)
  python3 pipeline/atlas/build_tree.py --names   # only the group names, on the tree.json already there (iNaturalist)
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPECIES = ROOT / 'public' / 'atlas' / 'species.json'
OUT = ROOT / 'public' / 'atlas' / 'tree.json'
API = 'https://api.opentreeoflife.org/v3/'
INAT = 'https://api.inaturalist.org/v1/taxa/'
sys.path.insert(0, str(ROOT))
from pipeline.atlas.config import records_name  # noqa: E402

UA = {'User-Agent': 'hatch-atlas (github.com/neevliberman/hatch)'}
# iNaturalist's answers, kept between runs (notebooks/data is not in git): delete it to ask again.
CACHE = ROOT / 'notebooks' / 'data' / 'atlas' / 'tree_inat.json'
LONGEST = 26  # characters: a longer name crowds the wheel and the breadcrumb, so the group keeps its Latin one
# iNaturalist names that read oddly to a Midwest reader, by Latin name: a better one, or None to keep the Latin.
OVERRIDE = {
    'Colias': 'Sulphurs',  # iNaturalist's "Clouded Yellows" is the British name
    'Elaphria': None,  # "Midgets"
}
# Words that keep their capital in sentence case ("American cockroaches").
PROPER = {'american', 'asian', 'european', 'oriental', 'japanese', 'chinese', 'mexican', 'new', 'world'}

sys.setrecursionlimit(100000)


def post(path, body):
    req = urllib.request.Request(API + path, json.dumps(body).encode(), {'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=300))


def inat_get(url):
    """JSON results from iNaturalist: five tries (none after a refusal other than "too many"), then a second's rest
    (it asks for about one call a second)."""
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                out = json.load(r)['results']
            time.sleep(1)
            return out
        except urllib.error.HTTPError as e:
            if attempt == 4 or (400 <= e.code < 500 and e.code != 429):
                raise
        except Exception:
            if attempt == 4:
                raise
        time.sleep(2 ** attempt * 2)


def inat(ids, by_name=()):
    """The ranks, names and English names of each taxon's ancestors (taxa by id, 30 a call), and each (rank, name) in
    `by_name` looked up by name, cached in CACHE."""
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    todo = [i for i in dict.fromkeys(ids) if str(i) not in cache]
    for k in range(0, len(todo), 30):
        for t in inat_get(INAT + ','.join(map(str, todo[k:k + 30])) + '?locale=en&per_page=30'):
            cache[str(t['id'])] = [[a['rank'], a['name'], a.get('preferred_common_name')] for a in t.get('ancestors', [])]
        CACHE.write_text(json.dumps(cache))  # after each call: a run cut short keeps what it got
    for rank, latin in by_name:
        if f'{rank}:{latin}' not in cache:
            res = inat_get(INAT[:-1] + '?' + urllib.parse.urlencode({'q': latin, 'rank': rank, 'locale': 'en', 'per_page': 5}))
            hit = next((t for t in res if t['name'] == latin and t['rank'] == rank), None)
            cache[f'{rank}:{latin}'] = [[rank, latin, hit.get('preferred_common_name')]] if hit else []
            CACHE.write_text(json.dumps(cache))
    return cache


def group_name(name, latin):
    """A group's English name, short and in sentence case ("Ground Beetles" -> "Ground beetles"), or None: missing,
    the Latin name again ("Bombus Bees"), a catch-all ("... and Allies"), a list ("Bees, Wasps"), or longer than LONGEST. OVERRIDE has the last word."""
    if latin in OVERRIDE:
        return OVERRIDE[latin]
    if not name:
        return None
    name = ' '.join(name.split())
    words = name.split()
    low = name.lower()
    if len(name) > LONGEST or ',' in name or 'allies' in low or 'group' in low or 'unidentified' in low:
        return None
    if latin.lower() in low or low in latin.lower():
        return None
    # "Typical cicadas", "True weevils", "Common swallowtails": the qualifier only tells them from their relatives on
    # iNaturalist's lists.
    if len(words) > 1 and words[0].lower() in ('typical', 'true', 'common'):
        words = words[1:]
        words[0] = words[0][:1].upper() + words[0][1:]
    return ' '.join([words[0]] + [w if w.lower() in PROPER else w.lower() for w in words[1:]])


def common_names(tree, species):
    """{latin: English name} for every named family and genus in the tree that iNaturalist names well (group_name).
    Each group is looked up through one of its species' iNaturalist taxa (its ancestors carry the group's name)."""
    want = {}  # (rank, latin) -> species indices below it

    def walk(n):
        if isinstance(n, int):
            return [n]
        ls = [x for c in n[2:] for x in walk(c)]
        if n[1] in ('f', 'g'):
            want[({'f': 'family', 'g': 'genus'}[n[1]], n[0])] = ls
        return ls

    walk(tree)
    # One species per group is nearly always enough; the next two are asked only for a group the first did not reach,
    # and a group none of them reached (iNaturalist files them elsewhere) by its own name.
    found = {}
    for round_ in range(4):
        need = {k: v for k, v in want.items() if k not in found and (round_ == 3 or len(v) > round_)}
        keys = {k: str(species[v[round_]].get('taxon')) for k, v in need.items()} if round_ < 3 else {k: f'{k[0]}:{k[1]}' for k in need}
        cache = inat([i for i in keys.values() if i != 'None'] if round_ < 3 else [], need if round_ == 3 else ())
        for k, key in keys.items():
            for rank, latin, common in cache.get(key, []):
                if (rank, latin) == k:
                    found[k] = common
    out = {latin: g for (rank, latin), common in sorted(found.items()) if (g := group_name(common, latin))}
    for rank in ('family', 'genus'):
        mine = [latin for r, latin in want if r == rank]
        print(f'{rank}: {sum(latin in out for latin in mine)} of {len(mine)} named '
              f'({sum(bool(found.get((rank, latin))) for latin in mine)} with an iNaturalist name before the checks)')
    return out


def common_names_or_old(tree, species):
    """common_names, or (iNaturalist down or refusing) the names tree.json already has, with a warning: an outage
    never fails the tree."""
    try:
        return common_names(tree, species)
    except Exception as e:
        old = json.load(open(OUT)).get('c', {}) if OUT.exists() else {}
        print(f'WARNING: no group names from iNaturalist ({e}); keeping the {len(old)} tree.json has', file=sys.stderr)
        return old


def write(tree, grafted, names):
    json.dump({'src': 'Open Tree of Life synthetic tree', 'g': grafted, 'c': names, 't': tree}, open(OUT, 'w'), separators=(',', ':'))


def parse_newick(s):
    """Newick -> {'c': [children] | None, 'l': label}. Labels are Open Tree ids like ott123 or mrcaott1ott2."""
    stack, last = [[]], None
    for t in re.findall(r'\(|\)|,|[^(),;]+', s):
        if t == '(':
            stack.append([])
        elif t == ',':
            continue
        elif t == ')':
            node = {'c': stack.pop(), 'l': ''}
            stack[-1].append(node)
            last = node
        elif last is not None and stack[-1] and stack[-1][-1] is last and not last['l']:
            last['l'], last = t, None
        else:
            stack[-1].append({'c': None, 'l': t})
    return stack[0][0]


def collapse(n):
    if n['c'] is None:
        return n
    n['c'] = [collapse(c) for c in n['c']]
    return n['c'][0] if len(n['c']) == 1 else n


def main():
    species = json.load(open(SPECIES))
    if '--names' in sys.argv:
        old = json.load(open(OUT))
        write(old['t'], old['g'], common_names_or_old(old['t'], species))
        print(f'{OUT.stat().st_size / 1024:.1f} KB')
        return
    names = [records_name(s) for s in species]  # GBIF's names, which the Open Tree knows
    by_genus = {s['genus']: s for s in species if s.get('order') and s.get('genus')}
    for s in species:  # a few rows lack their order / family: borrow them from a species of the same genus
        mate = by_genus.get(s['name'].split()[0])
        for k in ('order', 'family', 'genus'):
            if not s.get(k) and mate:
                s[k] = mate[k]
    ott = {}
    for i in range(0, len(names), 250):
        r = post('tnrs/match_names', {'names': names[i:i + 250], 'do_approximate_matching': False})
        for m in r['results']:
            if m['matches']:
                ott[m['name']] = m['matches'][0]['taxon']['ott_id']
    ids = sorted(set(ott.values()))
    while True:  # the tree names ids it cannot place ("unknown"); drop them and ask again
        try:
            newick = post('tree_of_life/induced_subtree', {'ott_ids': ids, 'label_format': 'id'})['newick']
            break
        except urllib.error.HTTPError as e:
            bad = {int(x) for x in re.findall(r'ott(\d+)', e.read().decode())}
            if not bad or not (bad & set(ids)):
                raise
            ids = [i for i in ids if i not in bad]
    root = collapse(parse_newick(newick))

    by_ott = {}
    for i, s in enumerate(species):
        if records_name(s) in ott and 'into' not in s:  # a row shown under another (reconcile.py) has no leaf
            by_ott.setdefault(ott[records_name(s)], i)

    def to_node(n):
        if n['c'] is None:
            m = re.fullmatch(r'ott(\d+)', n['l'])
            i = by_ott.get(int(m.group(1))) if m else None
            return i
        kids = [k for k in (to_node(c) for c in n['c']) if k is not None]
        return None if not kids else kids[0] if len(kids) == 1 else ['', ''] + kids

    tree = to_node(root)

    def leaves(n):
        return [n] if isinstance(n, int) else [x for c in n[2:] for x in leaves(c)]

    placed = set(leaves(tree))
    grafted = []
    # Graft the rest beside the nearest relative: same genus, then family, then order.
    for rank in ('genus', 'family', 'order'):
        index = defaultdict(list)
        for i in placed:
            if species[i].get(rank):
                index[species[i][rank]].append(i)
        for i, s in enumerate(species):
            if i in placed or 'into' in s or not s.get(rank) or s[rank] not in index:
                continue
            target = set(index[s[rank]])

            def graft(n):
                """Add species i to the smallest branch holding every relative."""
                if isinstance(n, int):
                    return ['', '', n, i]
                inside = [k for k, c in enumerate(n[2:], 2) if target <= set(leaves(c))]
                if inside and not isinstance(n[inside[0]], int):
                    n[inside[0]] = graft(n[inside[0]])
                else:
                    n.append(i)
                return n

            tree = graft(tree)
            placed.add(i)
            grafted.append(i)
    for i, s in enumerate(species):  # no relative at all: hang from the top
        if i not in placed and 'into' not in s and not s['name'].startswith('('):
            tree = ['', '', tree, i]
            placed.add(i)
            grafted.append(i)

    # Name branches whose species are all one genus / family / order, at the highest such branch.
    def name(n, parent_label):
        if isinstance(n, int):
            return
        ls = leaves(n)
        for key, code in (('order', 'o'), ('family', 'f'), ('genus', 'g')):
            vals = {species[i].get(key) for i in ls}
            if len(vals) == 1 and None not in vals and len(ls) > 1 and code not in parent_label:
                n[0], n[1] = next(iter(vals)), code
                parent_label = {**parent_label, code: n[0]}
                break
        for c in n[2:]:
            name(c, parent_label)

    name(tree, {})
    write(tree, grafted, common_names_or_old(tree, species))
    print(f'{len(placed)} species placed, {len(grafted)} grafted, {OUT.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
