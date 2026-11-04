"""Make each Atlas row's name, taxon, common name and photo say what its records are (species.json).

The network's outputs are GBIF's species: GBIF's backbone names the records. Each row's taxon, common name and photo
are iNaturalist's, from the commonest iNaturalist taxon among its records (export.py taxonomy()). Where the two
taxonomies part, a row can say one species and show another (check_taxa.py finds them):
- GROUPS: one GBIF species holding two of iNaturalist's. GBIF files Lethe appalachia (Appalachian Brown) under Lethe
  eurydice (Eyed Brown), so the row "Lethe eurydice" was 62% Appalachian Browns, and took that taxon, name and photo.
  The network learned the two as one, so the row is named for both: one iNaturalist taxon that holds exactly the two
  when there is one (the subgenus Satyrodes), and "taxa" lists both, so this year's photos of either count for it.
- INTO: one iNaturalist species that GBIF splits into two. iNaturalist ranks the Red-spotted Purple as a subspecies of
  Limenitis arthemis; GBIF keeps it a species, so the rest (White Admirals and every photo named only to the species,
  Red-spotted Purples among them) was a second row, "Red-spotted Admiral". Merging the two needs the network
  retrained; until then the second row is not listed ("into" the first), and a link to it opens the first.
- every other row whose records are all one iNaturalist taxon but whose name is GBIF's older one ("Polites coras" is
  iNaturalist's Polites peckius): renamed to iNaturalist's name.
A renamed row keeps GBIF's name in "gbif" (config.records_name), which joins it to its records, per_species.csv and the
Ohio tables, and keeps old ?species= links working.
Anything else check_taxa.py flags is left as it is, and listed (AMBIGUOUS, and the run's printout).

  python3 pipeline/atlas/reconcile.py   # fixes public/atlas/species.json and tree.json in place (network: iNaturalist,
                                        # GBIF; cached by check_taxa.py), then: python3 pipeline/atlas/spread.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import check_taxa as C  # noqa: E402
from pipeline.atlas.config import OUT, records_name  # noqa: E402
from pipeline.atlas.names import INAT, get  # noqa: E402

# GBIF's name -> what the row shows. "taxon": the iNaturalist taxon for its photo and page (one holding exactly the
# group when iNaturalist has one, else the commonest species); "taxa": every iNaturalist species in the records.
GROUPS = {
    "Lethe eurydice": {"name": "Lethe (Satyrodes)", "common": "Eyed and Appalachian Browns", "taxon": 1265201,
                       "taxa": [141531, 132227]},  # 731 Eyed, 1,219 Appalachian (GBIF, the box, 2015-2024)
    "Polistes carolina": {"name": "Polistes carolina / rubiginosus", "common": "Fine- and Coarse-backed Red Paper Wasps",
                          "taxon": 370906, "taxa": [121792, 370906]},  # 109 P. carolina, 202 P. rubiginosus
    "Meganola minuscula": {"name": "Meganola minuscula / phylla", "common": "Confused and Coastal Plain Meganola Moths",
                           "taxon": 332250, "taxa": [224526, 332250]},  # 34 M. minuscula, 65 M. phylla
}
# GBIF's name -> GBIF's name of the row shown in its place.
INTO = {"Limenitis arthemis": "Limenitis astyanax"}


def photo(taxon):
    """(square photo url, attribution) of an iNaturalist taxon's default photo."""
    ph = get(INAT + f"taxa/{taxon}")["results"][0].get("default_photo") or {}
    return ph.get("square_url"), ph.get("attribution")


def same_taxon(t, counts):
    """Whether GBIF's records under a row (counts: {iNaturalist name: records}) are all iNaturalist's taxon t: its
    species (and its subspecies), or for a subspecies, that subspecies."""
    if not counts:
        return False
    if t["rank"] == "species":
        return {C.binomial(n) for n in counts} == {t["name"]}
    return {n.lower() for n in counts} == {t["name"].lower()}


def reconcile(rows, log=print):
    """Fix rows in place (see the module notes). -> [(GBIF name, what was done)]."""
    real = [r for r in rows if r.get("name") != "(other)"]
    by_gbif = {records_name(r): r for r in real}
    tax = C.inat_records([r["taxon"] for r in real if r.get("taxon")])
    done = []
    for gname, fix in GROUPS.items():
        r = by_gbif.get(gname)
        if not r:
            continue
        new = {"name": fix["name"], "common": fix["common"], "taxon": fix["taxon"], "taxa": fix["taxa"]}
        if r.get("taxon") != fix["taxon"]:
            new["photo"], new["credit"] = photo(fix["taxon"])
        if any(r.get(k) != v for k, v in new.items()):
            r.update(new, gbif=gname)
            done.append((gname, f"group of {len(fix['taxa'])} iNaturalist species: {fix['name']} ({fix['common']})"))
    for gname, keep in INTO.items():
        r, k = by_gbif.get(gname), by_gbif.get(keep)
        if r and k and r.get("into") != k["i"]:
            r["into"] = k["i"]
            done.append((gname, f"shown under {keep} (row {k['i']}), not listed"))
    for r in real:
        gname = records_name(r)
        t = tax.get(r.get("taxon"))
        if gname in GROUPS or gname in INTO or not t or not t["is_active"] or t["name"] == r["name"]:
            continue
        if not same_taxon(t, C.gbif_mix(gname)):
            continue  # left for check_taxa.py's list
        r.update(name=t["name"], genus=t["name"].split()[0], gbif=gname)
        done.append((gname, f"renamed {t['name']} (iNaturalist {t['id']}, {t['rank']})"))
    for g, what in done:
        log(f"  {g}: {what}")
    return done


def prune_tree(tree, drop):
    """tree.json without the leaves in `drop` (rows not listed): a branch left with one child becomes that child."""
    def walk(n):
        if isinstance(n, int):
            return None if n in drop else n
        kids = [k for k in (walk(c) for c in n[2:]) if k is not None]
        if not kids:
            return None
        if len(kids) == 1 and not n[0]:
            return kids[0]
        return [n[0], n[1], *kids]
    return {**tree, "t": walk(tree["t"]), "g": [i for i in tree["g"] if i not in drop]}


def main():
    path = OUT / "species.json"
    rows = json.loads(path.read_text())
    done = reconcile(rows)
    path.write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False))
    drop = {r["i"] for r in rows if "into" in r}
    tp = OUT / "tree.json"
    tp.write_text(json.dumps(prune_tree(json.loads(tp.read_text()), drop), separators=(",", ":")))  # as build_tree.py
    print(f"{len(done)} rows changed; tree.json without rows {sorted(drop)}")


if __name__ == "__main__":
    sys.exit(main())
