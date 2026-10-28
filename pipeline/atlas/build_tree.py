"""Build public/atlas/tree.json: the Atlas species placed on a real family tree (Open Tree of Life synthetic tree).

Steps: match each scientific name to an Open Tree taxon (TNRS), ask for the induced subtree of those taxa (the shared
branching pattern only: no branch lengths), collapse single-child links, then name the branches that are exactly one
order / family / genus. Species the tree lacks are grafted next to their closest relative in the species list (same
genus, else family, else order) and flagged in "g" so the app can say so.

tree.json: {"src": str, "g": [species index...], "t": node}; node = [label, rank, child, child, ...] with rank one of
"" (unnamed branch), "o", "f", "g"; a leaf is the species' index in species.json.
Analogy: ask a librarian for the shelf plan of just our 1,900 books, then label the shelves that hold one subject.
  python3 pipeline/atlas/build_tree.py
"""
import json
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPECIES = ROOT / 'public' / 'atlas' / 'species.json'
OUT = ROOT / 'public' / 'atlas' / 'tree.json'
API = 'https://api.opentreeoflife.org/v3/'

sys.setrecursionlimit(100000)


def post(path, body):
    req = urllib.request.Request(API + path, json.dumps(body).encode(), {'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=300))


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
    names = [s['name'] for s in species]
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
        if s['name'] in ott:
            by_ott.setdefault(ott[s['name']], i)

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
            if i in placed or not s.get(rank) or s[rank] not in index:
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
        if i not in placed and not s['name'].startswith('('):
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
    json.dump({'src': 'Open Tree of Life synthetic tree', 'g': grafted, 't': tree}, open(OUT, 'w'), separators=(',', ':'))
    print(f'{len(placed)} species placed, {len(grafted)} grafted, {OUT.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
