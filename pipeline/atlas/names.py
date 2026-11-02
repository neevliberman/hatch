"""English common names for the Atlas species that iNaturalist's preferred name leaves without one (species.json).

export.py takes each species' name, photo and credit from its iNaturalist taxon (preferred_common_name). That misses:
- a species GBIF keeps that iNaturalist ranks as a subspecies, so the records carry no iNaturalist taxon (Limenitis
  astyanax is iNaturalist's Limenitis arthemis astyanax, the Red-spotted Purple): looked up by name, it gets the taxon,
  its name, photo, credit and order / family / genus;
- a taxon whose preferred name (chosen by place) is missing but which lists an English name among all its names;
- a taxon iNaturalist names in no English at all: GBIF's English vernacular names (checklists such as Vermont's or the
  Catalogue of Life), the name most sources agree on, never a one-word or "species group" name ("Wasp").
iNaturalist first, as for every other species. Whatever has no English name anywhere keeps its Latin one.
Analogy: a second and third dictionary, opened only for the words the first one lacked.
  python3 pipeline/atlas/names.py      # fills public/atlas/species.json in place (network: iNaturalist, GBIF)
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPECIES = ROOT / "public/atlas/species.json"
INAT = "https://api.inaturalist.org/v1/"
GBIF = "https://api.gbif.org/v1/"
UA = {"User-Agent": "hatch-atlas (github.com/neevliberman/hatch)"}
# GBIF names from these come first on a tie (a curated checklist over a regional one).
TRUSTED = ("Catalogue of Life",)


def get(url, pause=1.0):
    """JSON from url, five tries, then `pause` seconds' rest (iNaturalist asks for about one call a second)."""
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                out = json.load(r)
            time.sleep(pause)
            return out
        except Exception:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"kept failing: {url}")


def tidy(name):
    """iNaturalist's casing: each word capitalised, lower case after a hyphen ("Northern Leaf-footed Bug")."""
    words = []
    for w in name.strip().split():
        parts = w.split("-")
        words.append("-".join([parts[0][:1].upper() + parts[0][1:]] + [p.lower() for p in parts[1:]]))
    return " ".join(words)


def pick_english(names):
    """The English name most sources agree on, from [(name, source)], or None. Never a one-word name ("Wasp",
    "Cranefly": a group, not a species) or a "species group"; a tie goes to a TRUSTED source, then the first listed."""
    ok = [(tidy(n), s or "") for n, s in names if n and len(n.split()) >= 2 and "group" not in n.lower()]
    if not ok:
        return None
    votes = Counter(n.lower() for n, _ in ok)
    trusted = {n.lower() for n, s in ok if s in TRUSTED}
    first = {}
    for k, (n, _) in enumerate(ok):
        first.setdefault(n.lower(), (k, n))
    best = max(votes, key=lambda n: (votes[n], n in trusted, -first[n][0]))
    return first[best][1]


def match_inat(name, results):
    """The active iNaturalist taxon for a scientific name, from a taxa search: the same name, else (GBIF's species that
    iNaturalist splits lower) a subspecies of the same genus and epithet ("Limenitis astyanax" is "Limenitis arthemis
    astyanax"). None when neither, or when more than one subspecies fits."""
    genus, epithet = name.split()[0], name.split()[-1]
    same = [r for r in results if r.get("is_active", True) and r.get("name") == name]
    if same:
        return same[0]
    sub = [r for r in results if r.get("is_active", True) and r.get("rank") in ("subspecies", "variety")
           and r["name"].split()[0] == genus and r["name"].split()[-1] == epithet]
    return sub[0] if len(sub) == 1 else None


def inat_lookup(row):
    """Fill a row with no iNaturalist taxon from a search by its name: taxon, common name, photo, credit, ranks."""
    res = get(INAT + "taxa?per_page=30&q=" + urllib.parse.quote(row["name"]))["results"]
    hit = match_inat(row["name"], res)
    if not hit:
        return
    full = get(INAT + f"taxa/{hit['id']}")["results"][0]
    ranks = {a["rank"]: a["name"] for a in full.get("ancestors", [])}
    ph = full.get("default_photo") or {}
    row.update({"taxon": full["id"], "common": full.get("preferred_common_name") or row.get("common"),
                "order": row.get("order") or ranks.get("order"), "family": row.get("family") or ranks.get("family"),
                "genus": row.get("genus") or ranks.get("genus"), "photo": row.get("photo") or ph.get("square_url"),
                "credit": row.get("credit") or ph.get("attribution")})


def inat_english(ids):
    """{taxon id: English name} for taxa that list one among all their names, 30 per call."""
    out = {}
    for k in range(0, len(ids), 30):
        res = get(INAT + "taxa?per_page=30&all_names=true&id=" + ",".join(map(str, ids[k:k + 30])))["results"]
        for r in res:
            en = [n["name"] for n in r.get("names", []) if n.get("locale") == "en" and n.get("is_valid", True)]
            if en:
                out[r["id"]] = tidy(en[0])
    return out


def gbif_english(name):
    """GBIF's English vernacular name for a scientific name (pick_english), or None."""
    m = get(GBIF + "species/match?strict=true&name=" + urllib.parse.quote(name), pause=0.2)
    if not m.get("usageKey") or m.get("matchType") == "NONE":
        return None
    v = get(GBIF + f"species/{m['usageKey']}/vernacularNames?limit=200", pause=0.2)["results"]
    return pick_english([(x.get("vernacularName"), x.get("source")) for x in v if x.get("language") == "eng"])


def fill(rows, log=print):
    """Give every row without a common name one where a source has it (see the module notes). In place."""
    todo = [r for r in rows if not r.get("common") and r.get("name") != "(other)"]
    for r in todo:
        if not r.get("taxon"):
            inat_lookup(r)
    en = inat_english([r["taxon"] for r in todo if not r.get("common") and r.get("taxon")])
    for r in todo:
        if not r.get("common") and r.get("taxon") in en:
            r["common"] = en[r["taxon"]]
    for r in todo:
        if not r.get("common"):
            r["common"] = gbif_english(r["name"])
    named = [r for r in todo if r.get("common")]
    for r in named:
        log(f"  {r['name']}: {r['common']}")
    log(f"{len(named)} of {len(todo)} species without a common name now have one; {len(todo) - len(named)} keep their Latin name")
    return rows


def main():
    rows = json.loads(SPECIES.read_text())
    fill(rows)
    SPECIES.write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
