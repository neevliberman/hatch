"""Check every Atlas species against iNaturalist's current taxonomy, and against what GBIF filed under its name.

The Atlas's species are GBIF's (its backbone names the records), but each row's taxon id, common name and photo are
iNaturalist's: export.py takes the most common iNaturalist taxon among the row's records. Where the two taxonomies
disagree, a row can end up saying one thing and showing another. GBIF files Lethe appalachia (Appalachian Brown) as a
subspecies of Lethe eurydice (Eyed Brown), so the row "Lethe eurydice" held both, and the Appalachian Brown, the
majority, lent it its taxon, name and photo.

For each row this asks:
- iNaturalist's record for the row's taxon id (30 ids a call, about one call a second):
  inactive  the taxon is inactive (swapped, split or merged away), with what replaced it;
  name      the id's name is not the row's: "stale" when iNaturalist files the row's name under that same id (a genus
            move, a synonym), "other" when the row's name is a different iNaturalist taxon (the id belongs to another
            species: the serious one), "unknown" when iNaturalist knows no such name;
  rank      the taxon is not a species (a subspecies standing in for GBIF's species, a genus, a complex);
  common    iNaturalist's English name (no place preferred, as export.py asks) is not the row's; "common-us" only
            notes where iNaturalist's US name differs from that (Small White / Cabbage White);
- across rows: shared (two rows, one taxon) and nested (one row's taxon is an ancestor of another's);
- GBIF (one match and one facet call per row, records in the Atlas box 2015-2024): mixed, when the records under the
  row's name hold more than one iNaturalist species, each at 3% or more.

  python3 pipeline/atlas/check_taxa.py            # writes pipeline/atlas/results/taxa_check.csv and prints a summary
  python3 pipeline/atlas/check_taxa.py --no-gbif  # iNaturalist checks only (a few minutes)
Calls are cached in notebooks/data/atlas/taxa_check/, so a killed run resumes.
"""
import csv
import json
import sys
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas.config import BOX, DATA, records_name  # noqa: E402
from pipeline.atlas.names import GBIF, INAT, get  # noqa: E402

SPECIES = ROOT / "public/atlas/species.json"
REPORT = ROOT / "pipeline/atlas/results/taxa_check.csv"
CACHE = DATA / "taxa_check"
INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"
MIXED_SHARE = 0.03
# Flags printed one by one: the row may show one species and hold another. (name:stale, common and the informational
# group / into are only counted.)
SERIOUS = ("inactive", "name:other", "name:unknown", "rank", "shared", "nested", "mixed", "missing")


def cached(key, fetch):
    """fetch() once, kept as JSON under CACHE/key."""
    f = CACHE / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text())
    out = fetch()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(out))
    tmp.replace(f)  # atomic: a killed run never leaves half a file
    return out


def inat_records(ids):
    """{id: iNaturalist taxon} with the fields the checks use, 30 ids a call (the show endpoint keeps inactive taxa)."""
    out = {}
    ids = sorted(set(ids))
    for k in range(0, len(ids), 30):
        chunk = ids[k:k + 30]
        res = cached(f"inat_{chunk[0]}_{chunk[-1]}_{len(chunk)}", lambda: [
            {f: r.get(f) for f in ("id", "name", "rank", "is_active", "current_synonymous_taxon_ids", "ancestor_ids",
                                    "preferred_common_name", "parent_id")}
            for r in get(INAT + "taxa/" + ",".join(map(str, chunk)) + "?locale=en&preferred_place_id=1")["results"]])
        out.update({r["id"]: r for r in res})
    return out


def global_names(ids):
    """{id: iNaturalist's English name with no place preferred}: the one export.py ships (its taxa search asks for none)."""
    out = {}
    ids = sorted(set(ids))
    for k in range(0, len(ids), 30):
        chunk = ids[k:k + 30]
        res = cached(f"inatg_{chunk[0]}_{chunk[-1]}_{len(chunk)}", lambda: [
            [r["id"], r.get("preferred_common_name")] for r in get(INAT + "taxa/" + ",".join(map(str, chunk)) + "?locale=en")["results"]])
        out.update(dict(res))
    return out


def inat_by_name(name):
    """iNaturalist's active taxa answering to a scientific name, as [(id, name, rank, matched_term)]: the name itself
    or one of its synonyms."""
    res = cached("q_" + name.replace(" ", "_"), lambda: [
        {f: r.get(f) for f in ("id", "name", "rank", "is_active", "matched_term")}
        for r in get(INAT + "taxa?per_page=30&is_active=true&q=" + urllib.parse.quote(name))["results"]])
    return [r for r in res if (r.get("matched_term") or "").lower() == name.lower() or r["name"] == name]


def gbif_mix(name):
    """{iNaturalist name: records} under GBIF's species `name` in the Atlas box, 2015-2024, or None if GBIF has no
    such species."""
    def fetch():
        m = get(GBIF + "species/match?strict=true&rank=SPECIES&name=" + urllib.parse.quote(name), pause=0.1)
        key = m.get("speciesKey") if m.get("matchType") != "NONE" else None
        if not key:
            return None
        q = {"datasetKey": INAT_DATASET, "speciesKey": key, "decimalLatitude": f"{BOX['s']},{BOX['n']}",
             "decimalLongitude": f"{BOX['w']},{BOX['e']}", "year": "2015,2024", "limit": 0,
             "facet": "verbatimScientificName", "facetLimit": 30}
        r = get(GBIF + "occurrence/search?" + urllib.parse.urlencode(q), pause=0.1)
        return {c["name"]: c["count"] for f in r.get("facets", []) for c in f["counts"]}
    return cached("gbif_" + name.replace(" ", "_"), fetch)


def binomial(n):
    w = n.split()
    return " ".join(w[:2]).capitalize() if len(w) >= 2 else n.capitalize()


def mixed(counts):
    """The iNaturalist species (binomials) holding at least MIXED_SHARE of a GBIF species' records, biggest first,
    when there are two or more; else []."""
    if not counts:
        return []
    by = Counter()
    for n, c in counts.items():
        by[binomial(n)] += c
    total = sum(by.values())
    big = [(n, c / total) for n, c in by.most_common() if c / total >= MIXED_SHARE]
    return big if len(big) > 1 else []


def check(rows, gbif=True, log=print):
    """[{row fields, flags}] for every row (the last, "other", left out). A row reconcile.py made a group ("taxa") is
    checked species by species; a row shown under another ("into") only says so."""
    rows = [r for r in rows if r.get("name") != "(other)"]
    tax = inat_records([t for r in rows for t in [r.get("taxon"), *r.get("taxa", [])] if t])
    world = global_names([r["taxon"] for r in rows if r.get("taxon")])
    listed = [r for r in rows if "into" not in r]
    by_taxon = defaultdict(list)
    for r in listed:
        by_taxon[r.get("taxon")].append(r["name"])
    out = []
    for k, r in enumerate(rows):
        t = tax.get(r.get("taxon")) or {}
        flags = []
        group = [tax.get(x) or {"id": x, "name": "?", "rank": "?", "is_active": False} for x in r.get("taxa", [])]
        if "into" in r:
            flags.append(f"into:{rows[r['into']]['name']}")
        elif not t:
            flags.append("missing")
        else:
            for g in group or [t]:
                if not g["is_active"]:
                    flags.append(f"inactive:{g['id']}->" + ",".join(map(str, g.get("current_synonymous_taxon_ids") or [])))
            if group:
                flags.append("group:" + ";".join(g["name"] for g in group))
                if any(g["rank"] != "species" for g in group):
                    flags.append("rank:" + ";".join(g["rank"] for g in group))
            elif t["name"] != r["name"]:
                hits = inat_by_name(r["name"])
                ids = {h["id"] for h in hits}
                flags.append("name:stale" if t["id"] in ids else "name:other" if hits else "name:unknown")
                r_inat = [f"{h['name']} ({h['id']})" for h in hits if h["id"] != t["id"]]
                if r_inat:
                    flags.append("row-name-is:" + ";".join(r_inat))
            if not group and t["rank"] != "species":
                flags.append("rank:" + t["rank"])
            ic, us, rc = world.get(t["id"]), t.get("preferred_common_name"), (r.get("common") or "").lower()
            if not group and ic and rc != ic.lower():
                flags.append("common")
            elif not group and us and rc != us.lower():
                flags.append(f"common-us:{us}")  # iNaturalist's name in the US differs from its global English one
            if len(by_taxon[r.get("taxon")]) > 1:
                flags.append("shared:" + ";".join(n for n in by_taxon[r.get("taxon")] if n != r["name"]))
            anc = set(t.get("ancestor_ids") or []) - {t["id"]}
            up = [o["name"] for o in listed if o is not r and o.get("taxon") in anc]
            if up:
                flags.append("nested-in:" + ";".join(up))
            mix = mixed(gbif_mix(records_name(r))) if gbif else []
            if mix and {n for n, _ in mix} - {g["name"] for g in group}:
                flags.append("mixed:" + ";".join(f"{n} {s:.0%}" for n, s in mix))
        out.append({"i": r["i"], "name": r["name"], "gbif": records_name(r), "common": r.get("common"),
                    "taxon": r.get("taxon"), "inat_name": t.get("name"), "inat_rank": t.get("rank"),
                    "inat_common": t.get("preferred_common_name"), "active": t.get("is_active"), "n": r.get("n"),
                    "flags": " | ".join(flags)})
        if gbif and k % 200 == 0:
            log(f"  {k} of {len(rows)}")
    return out


def main():
    gbif = "--no-gbif" not in sys.argv
    out = check(json.loads(SPECIES.read_text()), gbif=gbif)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    with REPORT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(r for r in out if r["flags"])
    kinds = Counter(fl.split(":")[0].split("->")[0] for r in out for fl in r["flags"].split(" | ") if fl)
    print(f"{len(out)} species checked, {sum(bool(r['flags']) for r in out)} flagged: {dict(kinds)}")
    for r in out:
        if any(x in r["flags"] for x in SERIOUS):
            print(f"  {r['name']} [{r['common']}] taxon {r['taxon']} = {r['inat_name']} [{r['inat_common']}]: {r['flags']}")
    print(f"written {REPORT.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
