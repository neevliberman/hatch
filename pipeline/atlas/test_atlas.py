"""No-network checks for the Atlas pieces: the warmth clock, the shares, the scorer."""
import numpy as np
import pandas as pd
import torch

from pipeline.atlas import data as D
from pipeline.atlas import model as M
from pipeline.atlas.score import AtlasModel, Calendar, score


def _warmth(shift_days):
    """Two years at one cell: a typical year, and the same year `shift_days` earlier."""
    days = np.arange(1, 366, dtype=np.float32)
    typical = np.clip(days - 60, 0, None) ** 1.5 / 10
    early = np.clip(days + shift_days - 60, 0, None) ** 1.5 / 10
    dd = np.stack([typical, early])[None]
    return D.Warmth(np.array(["c"]), np.array([2020, 2021]), dd, typical[None], {"c": 0})


def test_days_ahead_reads_a_shifted_spring():
    a = _warmth(10).days_ahead()
    assert np.allclose(a[0, 0, 80:200], 0, atol=0.5)        # the typical year is never ahead
    assert np.allclose(a[0, 1, 80:200], 10, atol=0.5)       # the early year is 10 days ahead all spring


def test_days_ahead_clips_and_holds():
    a = _warmth(60).days_ahead()
    assert a.max() <= D.CLIP_DAYS and a.min() >= -D.CLIP_DAYS
    assert (a[0, 0, :59] == 0).all()                          # nothing before any warmth


def test_shares_sum_to_one_and_clock_mix_starts_even():
    net = M.Atlas(5)
    p = torch.as_tensor(M.place_features([40.0, 45.0], [-90.0, -85.0], [600.0, 500.0]))
    z = net(p, torch.tensor([150.0, 200.0]), torch.tensor([5.0, -5.0]))
    assert torch.allclose(torch.softmax(z, -1).sum(-1), torch.ones(2))
    assert np.allclose(net.clock_weights(), 1 / 3)


def test_calendar_shares_and_scorer():
    rng = np.random.default_rng(0)
    df = pd.DataFrame({"lat": rng.uniform(37, 49, 2000), "doy": rng.integers(60, 300, 2000)})
    y = (df.doy.to_numpy() > 180).astype(int)  # species 0 early, species 1 late
    cal = Calendar(df, y, 2, alpha=1.0)
    assert np.allclose(cal.p.sum(-1), 1)
    per, total = score(cal, df, y, 2)
    assert total < 0 and (per < 0).all()
    flat = Calendar(df, y, 2, alpha=1e9)  # all smoothing: knows nothing about the season
    per_flat, total_flat = score(flat, df, y, 2)
    assert total > total_flat and (per > per_flat).all()


def test_atlas_learns_a_season():
    rng = np.random.default_rng(1)
    n = 4000
    df = pd.DataFrame({"lat": rng.uniform(37, 49, n), "lng": rng.uniform(-97, -81, n), "norm_dd": 600.0,
                       "doy": rng.integers(60, 300, n).astype(float), "delta": 0.0})
    y = (df.doy.to_numpy() > 180).astype(int)
    net = M.Atlas(2, hidden=32, depth=1)
    M.fit(net, M.place_features(df.lat, df.lng, df.norm_dd), df.doy.to_numpy(), df.delta.to_numpy(), y, 5,
          lr=1e-2, batch=256, log=lambda *a: None)
    _, total = score(AtlasModel(net), df, y, 2)
    assert total / n > -0.35  # a coin flip is -0.69


def test_browser_fixture_matches_the_shipped_weights():
    """scripts/atlas-net.fixture.json (what the page's network is checked against) is torch on public/atlas/model.bin."""
    import json
    import subprocess
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    out = subprocess.run([sys.executable, str(root / "pipeline/atlas/net_reference.py")], capture_output=True, text=True,
                         check=True, cwd=root).stdout
    now = json.loads(out)
    saved = json.loads((root / "scripts/atlas-net.fixture.json").read_text())
    for a, b in zip(now, saved):
        assert [i for i, _ in a["top"][:10]] == [i for i, _ in b["top"][:10]]
        assert np.allclose([v for _, v in a["top"]], [v for _, v in b["top"]], atol=1e-4)


def test_tree_holds_every_species_once_and_names_whole_groups():
    """public/atlas/tree.json (build_tree.py): each species one tip, and a named branch is exactly its group."""
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / "public" / "atlas"
    species = json.loads((root / "species.json").read_text())[:-1]  # the last row is "other"
    tree = json.loads((root / "tree.json").read_text())["t"]

    def tips(n):
        return [n] if isinstance(n, int) else [i for c in n[2:] for i in tips(c)]

    got = tips(tree)
    assert sorted(got) == [i for i, s in enumerate(species) if "into" not in s]  # a row shown under another: no tip
    key = {"o": "order", "f": "family", "g": "genus"}

    def check(n):
        if isinstance(n, int):
            return
        label, rank = n[0], n[1]
        if rank:
            below = {species[i].get(key[rank]) for i in tips(n)} - {None}
            assert below == {label}, (label, below)
        for c in n[2:]:
            check(c)

    check(tree)


def test_tree_group_names_are_short_plain_english():
    """build_tree.py's group names: iNaturalist's, in sentence case, never the Latin again, a catch-all or too long; and
    tree.json names only groups it has."""
    import json
    from pathlib import Path
    from pipeline.atlas.build_tree import LONGEST, group_name
    assert group_name("Ground Beetles", "Carabidae") == "Ground beetles"
    assert group_name("Typical Cicadas", "Cicadidae") == "Cicadas"
    assert group_name("Common Tiger Beetles", "Cicindela") == "Tiger beetles"
    assert group_name("Brush-footed Butterflies", "Nymphalidae") == "Brush-footed butterflies"
    assert group_name("Clouded Yellows", "Colias") == "Sulphurs" and group_name("Midgets", "Elaphria") is None
    assert group_name("Olethreutes Moths", "Olethreutes") is None
    assert group_name("House Flies and Allies", "Muscidae") is None
    assert group_name("Whites, Yellows, and Sulphurs", "Pieridae") is None
    assert group_name("Ants, Bees, Wasps, and Sawflies", "Hymenoptera") is None
    assert group_name("North American Spur-throated Grasshoppers", "Melanoplus") is None  # over LONGEST
    assert group_name(None, "Acleris") is None
    data = json.loads((Path(__file__).resolve().parents[2] / "public" / "atlas" / "tree.json").read_text())
    labels = set()

    def walk(n):
        if not isinstance(n, int):
            labels.add(n[0])
            for c in n[2:]:
                walk(c)

    walk(data["t"])
    assert set(data["c"]) <= labels
    assert all(0 < len(v) <= LONGEST and v[0].isupper() for v in data["c"].values())


def test_warm_table_moves_spring_the_right_way():
    """warm.bin (warm.py): 3 °F cooler runs every cell behind its typical spring, 3 °F warmer ahead, by days not weeks."""
    import json
    from pathlib import Path
    out = Path(__file__).resolve().parents[2] / "public/atlas"
    n = len(json.loads((out / "cells.json").read_text()))
    w = np.fromfile(out / "warm.bin", np.int8).reshape(2, n, -1) / 4
    june = (152 - 60) // 4  # 1 June, every 4 days from 1 March
    assert (w[0, :, june] <= 0).all() and (w[1, :, june] >= 0).all()
    assert 3 < np.median(w[1, :, june]) < 15 and -15 < np.median(w[0, :, june]) < -3


def test_expected_vs_seen_reads_a_slide_and_a_surplus():
    from pipeline.atlas.seen import best_shift, judge
    days = np.arange(1, 366)
    # Two broods, the second bigger; seen this year 6 days early and twice as often.
    e = 40 * np.exp(-((days - 140) / 8) ** 2) + 80 * np.exp(-((days - 220) / 10) ** 2)
    o = np.round(2 * (40 * np.exp(-((days - 134) / 8) ** 2) + 80 * np.exp(-((days - 214) / 10) ** 2)))
    d, gain = best_shift(o, e)
    assert d == 6 and gain > 0
    assert judge(o, e, phi=1, phi_t=1) == (round(o.sum() / e.sum(), 2), 6)
    # The same season as expected, in the same numbers: nothing to say.
    assert judge(np.round(e), e, phi=1, phi_t=1) == (None, None)


def test_surprises_pick_the_biggest_gaps_with_enough_photos():
    from pipeline.atlas.seen import surprises
    rows = [[500, 100, 5.0, None], [50, 5, 10.0, None], [100, 400, 0.25, None], [900, 800, None, -9], [300, 280, None, None]]
    assert surprises(rows) == [0, 2, 3]  # 10x on 50 photos is too few to list


def test_surprises_leave_out_periodical_cicadas():
    """A periodical cicada's brood off-year (1% of expected) is not a surprise; the next real shortfall takes its place."""
    import json
    from pathlib import Path
    from pipeline.atlas.seen import periodical, periodicals, surprises
    assert periodical("Magicicada cassini") and periodical("Magicicada septendecim")
    assert not periodical("Neotibicen tibicen") and not periodical("Danaus plexippus")
    names = ["Danaus plexippus", "Magicicada cassini", "Neotibicen tibicen"]
    rows = [[500, 100, 5.0, None], [40, 400, 0.1, None], [100, 400, 0.25, None]]
    assert surprises(rows) == [0, 1, 2]
    assert surprises(rows, skip=periodicals(names)) == [0, 2]
    # The shipped list (seen.py --repick) has none.
    out = Path(__file__).resolve().parents[2] / "public/atlas"
    species = json.loads((out / "species.json").read_text())
    picks = json.loads((out / "seen-2026.json").read_text())["surprises"]
    assert picks and not [species[i]["name"] for i in picks if periodical(species[i]["name"])]


def test_surprises_leave_out_near_zero_shortfalls():
    """Under 5% of expected (any species: a brood's off-year or a gap in the records) is never a surprise, as in the
    quiet strip; 5% itself still is. The shipped list has none."""
    import json
    from pathlib import Path
    from pipeline.atlas.seen import surprises
    rows = [[500, 100, 5.0, None], [4, 400, 0.01, None], [19, 400, 0.05, None], [20, 400, 0.05, None], [100, 400, 0.25, None]]
    assert surprises(rows) == [0, 3, 4]
    out = Path(__file__).resolve().parents[2] / "public/atlas"
    f = json.loads((out / "seen-2026.json").read_text())
    assert not [i for i in f["surprises"] if f["species"][i][0] < 0.05 * f["species"][i][1]]


def test_track_record_matches_the_gate_and_ships():
    """track_record.py: beat, tied or lost per test, untested below the gate's thresholds, and species.json holds
    exactly what per_species.csv says. The gate's 753 wins of 798 in 2026 are 743 beats and 10 of the 22 ties."""
    import json
    from pathlib import Path
    from pipeline.atlas.config import records_name
    from pipeline.atlas.track_record import outcome, track_record
    assert [outcome(g, 50, 500) for g in (10, 2.9, -2.9, -10)] == [1, 0, 0, -1]
    assert outcome(500, 19, 500) is None and outcome(500, 50, 399) is None
    rec = track_record()
    c = [r[0] for r in rec.values()]
    assert (c.count(1), c.count(0), c.count(-1)) == (743, 22, 33)  # 798 tested, as the gate scored them
    assert rec["Bombus impatiens"] == [1, 5660, 1, 3234] and rec["Spilosoma virginica"] == [0, 1000, -1, 231]
    assert "Magicicada septendecim" not in rec  # no brood in 2026: too few photos to test
    species = json.loads((Path(__file__).resolve().parents[2] / "public/atlas/species.json").read_text())[:-1]
    assert {records_name(s): s["rec"] for s in species if "rec" in s} == rec and not any("test" in s for s in species)


def test_names_fill_in_english_from_the_other_sources():
    """names.py: iNaturalist's subspecies stands in for GBIF's species; a GBIF name needs North American backing (an
    authority, or two regional checklists) and must say something of its own: not the Latin name or its genus, not the
    family's or genus's name, not one word or a "species group". The shipped list names the Red-spotted Purple and none
    of the names the first run let through."""
    import json
    from pathlib import Path
    from pipeline.atlas.names import match_inat, pick_english, plausible, singular, tidy, usable
    found = [{"id": 490118, "name": "Limenitis arthemis arthemis × astyanax", "rank": "infrahybrid", "is_active": True},
             {"id": 58585, "name": "Limenitis arthemis astyanax", "rank": "subspecies", "is_active": True}]
    assert match_inat("Limenitis astyanax", found)["id"] == 58585
    assert match_inat("Limenitis astyanax", found[:1]) is None
    assert match_inat("Actias luna", [{"id": 1, "name": "Actias luna", "rank": "species"}])["id"] == 1
    assert tidy("Northern Leaf-Footed Bug") == "Northern Leaf-footed Bug"
    assert singular("Pleasing Fungus Beetles") == "pleasing fungus beetle" and singular("Flower Flies") == "flower fly"
    # Says something of its own.
    assert not plausible("Valgus Hemipterus", "Valgus hemipterus") and not plausible("Gerdana Moth", "Gerdana caritella")
    assert not plausible("Pleasing Fungus Beetle", "Megalodacne heros", ["Pleasing Fungus Beetles", None])
    assert not plausible("Flower moth", "Scythris sinensis", ["Flower Moths"])
    assert not plausible("Wasp", "Leucospis affinis") and not plausible("Aethes angustana species group", "Aethes angustana")
    assert plausible("Golden-eyed Lacewing", "Chrysopa oculata", ["Green Lacewings", "Common Green Lacewings"])
    # Backed in North America.
    vt, mv, col = ("Checklist of Vermont Species", None), ("Martha's Vineyard species checklist", None), ("Catalogue of Life", None)
    assert not usable([vt]) and not usable([col, ("Catalogue of the Lepidoptera of Belgium", None)]) and not usable([col, vt])
    assert usable([vt, mv]) and usable([("Coreoidea Species File", None)])
    vt3 = lambda n: (n, vt[0], None)  # noqa: E731
    assert pick_english([vt3("Hunchback Bee Fly"), vt3("Hunchbacked Bee Fly")], "Lepidophora lutea") is None
    assert pick_english([("Kentish Owlet", "Catalogue of Life", None), ("Kentish owlet", "Catalogue of the Lepidoptera of Belgium", None),
                         ("Flower moth", "Global Register of Introduced and Invasive Species - United States (Contiguous)", "US"),
                         ("Kentish owlet", vt[0], None), ("Flower moth", vt[0], None)], "Scythris sinensis", ["Flower Moths"]) is None
    assert pick_english([("Golden-eyed Lacewing", *vt), ("Golden-eyed Lacewing", *mv)], "Chrysopa oculata") == "Golden-eyed Lacewing"
    species = json.loads((Path(__file__).resolve().parents[2] / "public/atlas/species.json").read_text())[:-1]
    purple = next(s for s in species if s.get("gbif") == "Limenitis astyanax")
    assert purple["common"] == "Red-spotted Purple" and purple["taxon"] == 58585 and purple["family"] == "Nymphalidae"
    bad = {"Pleasing Fungus Beetle", "Hunchback Bee Fly", "Gerdana Moth", "Kentish Owlet", "Valgus Hemipterus"}
    assert not [s["common"] for s in species if s.get("common") in bad]
    assert sum(not s.get("common") for s in species) <= 138  # no backed English name in iNaturalist or GBIF (names.py run)



# spread.py: the time bar's band. Each case is a few runs of a simulated species; a "null" never moves between years,
# so it should almost never get a band.
YEARS = np.arange(2015, 2026)


def _band_rate(gen, reps=6, seed=0):
    from pipeline.atlas.spread import spread
    rng = np.random.default_rng(seed)
    bands = []
    for _ in range(reps):
        doy, lat, year, lng = gen(rng)
        bands.append(spread(doy, lat, year, rng, lng)[0] or 0)
    return np.mean(np.array(bands) > 0), float(np.median(bands))


def _season(rng, slides, n, lat=None):
    doy = np.concatenate([np.round(rng.normal(170 - s, 10, n)) for s in slides])
    la = rng.uniform(37, 48, doy.size) if lat is None else lat
    return doy, la, np.repeat(YEARS[:len(slides)], n), rng.uniform(-95, -82, doy.size)


def test_spread_finds_a_real_year_to_year_slide():
    from pipeline.atlas.spread import spread
    rng = np.random.default_rng(1)
    moving = rng.choice([-12, -8, -4, 0, 4, 8, 12], len(YEARS))  # slides with sd ~ 7-9 days
    half, slides, _, _ = spread(*_season(rng, moving, 200)[:3], rng)
    assert 6 <= half <= 20 and np.corrcoef(list(slides.values()), moving)[0, 1] > 0.9
    assert spread(*_season(rng, moving, 30)[:3], rng)[0] is None  # too few photos a year


def test_spread_gives_no_band_to_chance_alone():
    rate, _ = _band_rate(lambda r: _season(r, np.zeros(len(YEARS)), 200))
    assert rate <= 1 / 6


def test_spread_sees_through_clumped_photos():
    def outings(r, n=120, k=8):  # each year's photos from k outings, each at one place over a few days
        doy, lat, lng = [], [], []
        for _ in YEARS:
            day, la, lo = r.normal(170, 10, k), r.uniform(38, 47, k), r.uniform(-95, -82, k)
            j = r.integers(0, k, n)
            doy.append(np.round(day[j] + r.normal(0, 1.5, n)))
            lat.append(la[j] + r.normal(0, 0.1, n))
            lng.append(lo[j] + r.normal(0, 0.1, n))
        return np.concatenate(doy), np.concatenate(lat), np.repeat(YEARS, n), np.concatenate(lng)
    assert _band_rate(outings)[0] <= 1 / 6
    assert _band_rate(lambda r: outings(r, 120, 20))[0] <= 1 / 6


def test_spread_with_uneven_years():
    ns = (40 * 1.5 ** np.arange(len(YEARS))).astype(int)  # 40 photos the first year, 2,300 the last

    def uneven(r):
        doy = np.concatenate([np.round(r.normal(170, 10, n)) for n in ns])
        return doy, r.uniform(37, 48, doy.size), np.repeat(YEARS, ns), r.uniform(-95, -82, doy.size)
    assert _band_rate(uneven)[0] <= 1 / 6


def test_spread_moves_two_broods_together():
    def two(r, sd):
        doy = []
        for s in r.normal(0, sd, len(YEARS)):
            k = r.random(300) < r.uniform(0.2, 0.6)  # the second brood's size changes from year to year too
            doy.append(np.round(np.where(k, r.normal(220, 9, 300), r.normal(150, 9, 300)) - s))
        doy = np.concatenate(doy)
        return doy, r.uniform(37, 48, doy.size), np.repeat(YEARS, 300), r.uniform(-95, -82, doy.size)
    rate, half = _band_rate(lambda r: two(r, 5))
    assert rate == 1 and 4 <= half <= 11  # truth: an 80% interval of +-6.4 days
    assert _band_rate(lambda r: two(r, 0))[0] <= 1 / 6


def test_spread_reads_latitude_and_is_not_fooled_by_it():
    from pipeline.atlas.spread import lat_slope

    def leaning(r):  # never moves in time; 4 days later a degree north; each year's photos lean north or south
        doy, lat = [], []
        for _ in YEARS:
            la = np.clip(r.normal(r.uniform(39, 46), 2, 300), 36.6, 49.4)
            doy.append(np.round(170 + 4 * (la - 42) + r.normal(0, 8, 300)))
            lat.append(la)
        return np.concatenate(doy), np.concatenate(lat), np.repeat(YEARS, 300), r.uniform(-95, -82, 300 * len(YEARS))
    doy, lat, _, _ = leaning(np.random.default_rng(2))
    assert 3 <= lat_slope(doy, lat) <= 5
    assert _band_rate(leaning)[0] <= 1 / 6


def test_spread_sees_through_a_map_wide_event_weekend():
    def event(r, n=150, frac=0.3):  # each year a bioblitz weekend, at a random date, holds 30% of the photos
        doy = []
        for _ in YEARS:
            ev = r.normal(170, 12)
            doy.append(np.round(np.where(r.random(n) < frac, ev + r.integers(0, 2, n), r.normal(170, 12, n))))
        doy = np.concatenate(doy)
        return doy, r.uniform(37, 48, doy.size), np.repeat(YEARS, n), r.uniform(-97, -81, doy.size)
    assert _band_rate(event)[0] <= 1 / 6


def test_spread_never_bands_identical_years():
    from pipeline.atlas.spread import spread
    rng = np.random.default_rng(4)
    one = np.round(rng.normal(170, 10, 200))  # the very same photos every year: every slide 0, no noise at all
    doy = np.tile(one, len(YEARS))
    assert spread(doy, rng.uniform(37, 48, doy.size), np.repeat(YEARS, 200), rng, rng.uniform(-95, -82, doy.size))[0] is None


def test_reconcile_names_rows_as_their_records():
    """reconcile.py: a GBIF species holding two of iNaturalist's is named for both (the Eyed and Appalachian Browns,
    which GBIF files as one); the Red-spotted Purple, a subspecies to iNaturalist, is named so, and the rest of its
    species is not listed beside it; a row whose records are one iNaturalist taxon goes by iNaturalist's name. No two
    listed rows share a taxon, and every renamed row keeps GBIF's name, which joins it to its records."""
    import json
    from pathlib import Path
    from pipeline.atlas.config import records_name
    from pipeline.atlas.reconcile import GROUPS, INTO, prune_tree, same_taxon
    assert same_taxon({"name": "Polites peckius", "rank": "species"}, {"polites peckius": 9})
    assert same_taxon({"name": "Callophrys augustinus", "rank": "species"}, {"callophrys augustinus": 9, "callophrys augustinus augustinus": 1})
    assert not same_taxon({"name": "Lethe appalachia", "rank": "species"}, {"lethe appalachia": 9, "lethe eurydice": 5})
    assert same_taxon({"name": "Limenitis arthemis astyanax", "rank": "subspecies"}, {"limenitis arthemis astyanax": 9})
    assert not same_taxon({"name": "Limenitis arthemis astyanax", "rank": "subspecies"}, {"limenitis arthemis": 9})
    assert not same_taxon({"name": "Actias luna", "rank": "species"}, None)
    tree = {"g": [3, 4], "t": ["Insecta", "", ["", "", 1, 4], ["Lethe", "g", 2, 3]]}
    assert prune_tree(tree, {4}) == {"g": [3], "t": ["Insecta", "", 1, ["Lethe", "g", 2, 3]]}
    assert prune_tree(tree, {2, 3}) == {"g": [4], "t": ["Insecta", "", ["", "", 1, 4]]}
    moved = {"g": [], "c": {"Lethe": "Pearly-eyes"}, "t": ["Insecta", "", 1, ["Lethe", "g", ["", "", 2, 3], 4]]}
    assert prune_tree(moved, set(), {1: "Danaus", 2: "Lethe", 3: "Lethe", 4: "Enodia"}) == {
        "g": [], "c": {"Lethe": "Pearly-eyes"}, "t": ["Insecta", "", 1, ["", "", ["Lethe", "g", ["", "", 2, 3]], 4]]}
    assert prune_tree(moved, set(), {1: "Danaus", 2: "Enodia", 3: "Enodia", 4: "Enodia"})["c"] == {}

    species = json.loads((Path(__file__).resolve().parents[2] / "public/atlas/species.json").read_text())[:-1]
    by = {records_name(s): s for s in species}
    browns = by["Lethe eurydice"]
    assert browns["name"] == "Lethe eurydice / appalachia" and browns["taxon"] == 1265201 and set(browns["taxa"]) == {141531, 132227}
    assert browns["common"] == "Eyed Browns" and "Satyrodes eurydice" in browns["aka"]
    groups = [s for s in species if "taxa" in s]  # one Latin form, and a short common name for the header
    assert len(groups) == 4 and all(" / " in s["name"] and s["common"] and len(s["common"]) <= 20 for s in groups)
    assert by["Limenitis astyanax"]["name"] == "Limenitis arthemis astyanax"
    assert by["Limenitis arthemis"]["into"] == by["Limenitis astyanax"]["i"]
    assert all(by[g]["name"] == f["name"] for g, f in GROUPS.items()) and all("into" in by[g] for g in INTO)
    listed = [s for s in species if "into" not in s]
    assert len({s["taxon"] for s in listed}) == len(listed)
    assert len({s["name"] for s in species}) == len(species) and all(s["gbif"] != s["name"] for s in species if "gbif" in s)
    assert by["Polites coras"]["name"] == "Polites peckius" and by["Polites coras"]["taxon"] == 133631
    tree = json.loads((Path(__file__).resolve().parents[2] / "public/atlas/tree.json").read_text())

    def leaves(n):
        return [n] if isinstance(n, int) else [x for c in n[2:] for x in leaves(c)]
    assert by["Limenitis arthemis"]["i"] not in leaves(tree["t"]) and browns["i"] in leaves(tree["t"])

