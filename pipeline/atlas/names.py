"""English common names for the Atlas species that iNaturalist's preferred name leaves without one (species.json).

export.py takes each species' name, photo and credit from its iNaturalist taxon (preferred_common_name). That misses:
- a species GBIF keeps that iNaturalist ranks as a subspecies, so the records carry no iNaturalist taxon (Limenitis
  astyanax is iNaturalist's Limenitis arthemis astyanax, the Red-spotted Purple): looked up by name, it gets the taxon,
  its name, photo, credit and order / family / genus;
- a taxon whose preferred name (chosen by place) is missing but which lists an English name among all its names;
- a taxon iNaturalist names in no English at all: GBIF's English vernacular names, only where North American sources
  back them (usable()): an authority (ITIS, a Species File, the US or Canadian invasive-species register), or two regional
  checklists. One regional checklist alone is not enough (Vermont's lists "Gerdana Moth", "Kentish Owlet"); nor is a
  global catalogue that copies other continents' names, or a name used elsewhere.
Every name, from either source, must say something of its own (plausible()): never the Latin name or its genus
("Valgus Hemipterus", "Gerdana Moth"), never the family's or genus's own common name ("Pleasing Fungus Beetle" is any
of the Erotylidae, "Flower Moth" any of the Scythrididae), never one word ("Wasp") or a "species group".
Whatever has no such name keeps its Latin one.
Analogy: a second and third dictionary, opened only for the words the first one lacked, and only trusted when it is
the local dictionary.
  python3 pipeline/atlas/names.py      # fills public/atlas/species.json in place (network: iNaturalist, GBIF)
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPECIES = ROOT / "public/atlas/species.json"
INAT = "https://api.inaturalist.org/v1/"
GBIF = "https://api.gbif.org/v1/"
UA = {"User-Agent": "hatch-atlas (github.com/neevliberman/hatch)"}
# A source whose word alone is enough: a taxonomic authority, or a national register for the US or Canada.
AUTHORITY = re.compile(r"Integrated Taxonomic Information System|\bITIS\b|Species File|Register of Introduced and Invasive Species - (United States|Canada)")
# A North American regional checklist: two different ones are enough.
NA_REGIONAL = re.compile(r"Vermont|Vineyard|United States|Canada|America|Ontario|Quebec|Maine|New York|Massachusetts|Michigan|Wisconsin|"
                         r"Minnesota|Ohio|Illinois|Indiana|Iowa|Missouri|Kentucky|Pennsylvania")


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


def singular(name):
    """"Pleasing Fungus Beetles" -> "pleasing fungus beetle", "Flower Flies" -> "flower fly" (lower case)."""
    n = name.strip().lower()
    if n.endswith("ies"):
        return n[:-3] + "y"
    if re.search(r"(x|ch|sh)es$", n):
        return n[:-2]
    return n[:-1] if n.endswith("s") and not n.endswith("ss") else n


def plausible(name, sci, groups=()):
    """A name that says something of its own about the species `sci`: two words or more, no "species group", not the
    Latin name or any word of it ("Valgus Hemipterus", "Gerdana Moth"), and not the common name of its family or genus
    (`groups`, as iNaturalist writes them, plural: "Pleasing Fungus Beetles")."""
    if not name or len(name.split()) < 2 or "group" in name.lower():
        return False
    words = set(re.findall(r"[a-z]+", name.lower()))
    if words & set(sci.lower().split()):
        return False
    return singular(name) not in {singular(g) for g in groups if g}


def usable(sources):
    """Whether a name's sources [(source, country)] are North American enough: an AUTHORITY, or two different
    North American regional checklists. A global catalogue or another continent's list adds nothing."""
    regional = set()
    for src, country in sources:
        src = src or ""
        if AUTHORITY.search(src):
            return True
        if NA_REGIONAL.search(src) or country in ("US", "CA"):
            regional.add(src)
    return len(regional) >= 2


def pick_english(names, sci, groups=()):
    """GBIF's English name for `sci` from [(name, source, country)], or None: the plausible, usable name with the most
    North American sources (first listed on a tie)."""
    by = defaultdict(list)
    first = {}
    for k, (n, src, country) in enumerate(names):
        if not plausible(n, sci, groups):
            continue
        key = tidy(n).lower()
        by[key].append((src, country))
        first.setdefault(key, (k, tidy(n)))
    ok = [key for key, srcs in by.items() if usable(srcs)]
    if not ok:
        return None
    best = max(ok, key=lambda key: (len({s for s, _ in by[key]}), -first[key][0]))
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


def inat_taxon(i):
    return get(INAT + f"taxa/{i}")["results"][0]


def groups_of(full):
    """The family's and genus's common names from an iNaturalist taxon's ancestors."""
    return [a.get("preferred_common_name") for a in full.get("ancestors", []) if a.get("rank") in ("family", "subfamily", "tribe", "genus")]


def inat_lookup(row):
    """Fill a row with no iNaturalist taxon from a search by its name: taxon, common name, photo, credit, ranks."""
    res = get(INAT + "taxa?per_page=30&q=" + urllib.parse.quote(row["name"]))["results"]
    hit = match_inat(row["name"], res)
    if not hit:
        return
    full = inat_taxon(hit["id"])
    ranks = {a["rank"]: a["name"] for a in full.get("ancestors", [])}
    ph = full.get("default_photo") or {}
    common = full.get("preferred_common_name")
    row.update({"taxon": full["id"], "common": common if plausible(common, row["name"], groups_of(full)) else row.get("common"),
                "order": row.get("order") or ranks.get("order"), "family": row.get("family") or ranks.get("family"),
                "genus": row.get("genus") or ranks.get("genus"), "photo": row.get("photo") or ph.get("square_url"),
                "credit": row.get("credit") or ph.get("attribution")})


def inat_english(ids):
    """{taxon id: [English names]} for taxa that list one among all their names, 30 per call."""
    out = {}
    for k in range(0, len(ids), 30):
        res = get(INAT + "taxa?per_page=30&all_names=true&id=" + ",".join(map(str, ids[k:k + 30])))["results"]
        for r in res:
            en = [tidy(n["name"]) for n in r.get("names", []) if n.get("locale") == "en" and n.get("is_valid", True)]
            if en:
                out[r["id"]] = en
    return out


def gbif_english(name, groups=()):
    """GBIF's English vernacular name for a scientific name (pick_english), or None."""
    m = get(GBIF + "species/match?strict=true&name=" + urllib.parse.quote(name), pause=0.2)
    if not m.get("usageKey") or m.get("matchType") == "NONE":
        return None
    v = get(GBIF + f"species/{m['usageKey']}/vernacularNames?limit=200", pause=0.2)["results"]
    return pick_english([(x.get("vernacularName"), x.get("source"), x.get("country")) for x in v if x.get("language") == "eng"], name, groups)


def fill(rows, log=print):
    """Give every row without a common name one where a source has it (see the module notes). In place."""
    todo = [r for r in rows if not r.get("common") and r.get("name") != "(other)"]
    for r in todo:
        if not r.get("taxon"):
            inat_lookup(r)
    en = inat_english([r["taxon"] for r in todo if not r.get("common") and r.get("taxon")])
    for r in todo:
        if r.get("common"):
            continue
        g = groups_of(inat_taxon(r["taxon"])) if r.get("taxon") else []
        r["common"] = next((n for n in en.get(r.get("taxon"), []) if plausible(n, r["name"], g)), None) or gbif_english(r["name"], g)
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
