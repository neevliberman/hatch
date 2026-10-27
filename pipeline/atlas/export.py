"""Export the gate's run-2 network for the browser: public/atlas/.

- model.bin + model.json: every weight as float16, in the order model.json lists (offsets in values, not bytes).
- species.json: one row per output, in output order: scientific name, common name, order/family/genus, training
  records, iNaturalist taxon id, a credited square photo, its 2026 test result. The last row is "other".
- cells.json: the H3 res-4 warmth cells inside the box and each one's typical warmth by 30 June (a model input).
- ahead-YYYY.bin: "days ahead" for every cell and day of YEAR, int8 in quarter days ([cell][day], 365 days).
- season.bin: each species' expected photos through the season, every STEP days from SEASON[0], in a typical year and
  in YEAR, uint8 scaled to the species' own top ([species][2][steps]): its share averaged over the cells times the day's
  usual number of insect photos (season.json "volume"), so a spring day with few photos of anything doesn't look like a
  peak. The time slider's ribbon. species.json's "peak" is the species' top share in any cell on any of those days of
  a typical year (the map's colour scale).
Analogy: the network is a recipe; this writes the recipe card (weights) and the pantry list (species, places).
  python3 pipeline/atlas/export.py            # needs notebooks/data/atlas/model/run2/atlas.pt and warmth.npz
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

import duckdb
import h3
import numpy as np
import pandas as pd
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pipeline.atlas import data as D  # noqa: E402
from pipeline.atlas import model as M  # noqa: E402
from pipeline.atlas.config import BOX, DATA, FIRST_YEAR  # noqa: E402

OUT = ROOT / "public/atlas"
YEAR = 2026
SEASON = (60, 304)  # 1 Mar to 31 Oct (365-day calendar)
STEP = 4
INAT = "https://api.inaturalist.org/v1/taxa?per_page=30&id="


def weights(net):
    order, chunks, off = [], [], 0
    for name, t in net.state_dict().items():
        a = t.detach().float().numpy()
        order.append({"name": name, "shape": list(a.shape), "offset": off})
        chunks.append(a.ravel())
        off += a.size
    flat = np.concatenate(chunks).astype(np.float16)
    assert np.isfinite(flat).all(), "a weight overflows float16"
    return order, flat


def volume(days):
    """Insect photos on each day of a typical year, 2015-2025, averaged over a week, scaled to the top day (0-1)."""
    con = duckdb.connect()
    t = con.execute(f"""
        SELECT dayofyear(make_date(year, month, day)) AS doy, count(*) AS n
        FROM read_parquet('{DATA}/records/*/*.parquet', hive_partitioning=true)
        WHERE year BETWEEN {FIRST_YEAR} AND {YEAR - 1} AND day IS NOT NULL GROUP BY 1""").df()
    per = np.zeros(367)
    per[t.doy.to_numpy()] = t.n.to_numpy()
    week = np.convolve(np.r_[per[-3:], per, per[:3]], np.ones(7) / 7, "valid")
    v = week[days]
    return v / v.max()


def taxonomy(species):
    con = duckdb.connect()
    t = con.execute(f"""
        SELECT species, mode(inat_taxon) AS taxon, mode("order") AS ord, mode(family) AS family, mode(genus) AS genus
        FROM read_parquet('{DATA}/records/*/*.parquet', hive_partitioning=true)
        WHERE species IS NOT NULL AND rank = 'SPECIES' GROUP BY species""").df().set_index("species")
    return {s: t.loc[s].to_dict() for s in species if s in t.index}


def inat(ids):
    """{taxon id: (common name, photo url, attribution)} from iNaturalist, 30 per call, 1 s apart."""
    out = {}
    ids = [int(i) for i in ids if i]
    for k in range(0, len(ids), 30):
        url = INAT + ",".join(map(str, ids[k:k + 30]))
        req = urllib.request.Request(url, headers={"User-Agent": "hatch-atlas (github.com/neevliberman/hatch)"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    res = json.load(r)["results"]
                break
            except Exception:
                time.sleep(2 ** attempt)
        else:
            raise RuntimeError(f"iNaturalist kept failing: {url}")
        for r in res:
            ph = r.get("default_photo") or {}
            out[r["id"]] = (r.get("preferred_common_name"), ph.get("square_url"), ph.get("attribution"))
        time.sleep(1)
    return out


@torch.no_grad()
def seasons(net, w, keep, ahead):
    """[S, 2, steps] mean share over the cells, and [S] top cell share, in a typical year (ahead 0) and in YEAR."""
    net.eval()
    lat, lng = np.array([h3.cell_to_latlng(w.cells[i]) for i in keep]).T
    place = torch.from_numpy(M.place_features(lat, lng, w.typical_july()[keep]))
    days = np.arange(SEASON[0], SEASON[1] + 1, STEP)
    mean = np.zeros((net.head.out_features, 2, len(days)), np.float32)
    top = np.zeros(net.head.out_features, np.float32)
    for k, d in enumerate(days):
        for m, a in enumerate([np.zeros(len(keep), np.float32), ahead[:, d - 1].astype(np.float32)]):
            p = torch.softmax(net(place, torch.full((len(keep),), float(d)), torch.from_numpy(a)), -1).numpy()
            mean[:, m, k] = p.mean(0)
            if m == 0:
                top = np.maximum(top, p.max(0))
    return mean, top


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    ck = torch.load(DATA / "model/run2/atlas.pt")
    sp = ck["species"]
    net = M.Atlas(len(sp) + 1)
    net.load_state_dict(ck["state"])
    order, flat = weights(net)
    flat.tofile(OUT / "model.bin")
    meta = {"version": "atlas-run2", "n_out": len(sp) + 1, "hidden": net.head.in_features,
            "depth": len(net.blocks), "lambdas": net.lambdas.tolist(), "place_freqs": list(M.PLACE_FREQS),
            "time_harmonics": M.TIME_HARMONICS, "box": BOX, "norm_dd": {"center": 600.0, "scale": 200.0},
            "tensors": order}
    (OUT / "model.json").write_text(json.dumps(meta, indent=1))

    w = D.Warmth.load(np.arange(FIRST_YEAR, YEAR))
    keep = [i for i, c in enumerate(w.cells) if BOX["s"] - 0.3 <= h3.cell_to_latlng(c)[0] <= BOX["n"] + 0.3
            and BOX["w"] - 0.3 <= h3.cell_to_latlng(c)[1] <= BOX["e"] + 0.3]
    a = w.days_ahead()[keep, list(w.years).index(YEAR)]
    a = np.where(np.isfinite(a), a, a[:, [int(np.load(DATA / "warmth.npz")["last_day_2026"]) - 1]])  # hold newest
    np.clip(np.round(a * 4), -127, 127).astype(np.int8).tofile(OUT / f"ahead-{YEAR}.bin")
    cells = [{"h": str(w.cells[i]), "dd": round(float(w.typical_july()[i]), 1)} for i in keep]
    (OUT / "cells.json").write_text(json.dumps(cells, separators=(",", ":")))
    mean, top = seasons(net, w, keep, np.clip(np.round(a * 4), -127, 127) / 4)
    vol = volume(np.arange(SEASON[0], SEASON[1] + 1, STEP))
    (OUT / "season.json").write_text(json.dumps({"start": SEASON[0], "step": STEP, "volume": [round(float(x), 4) for x in vol]}))
    mean = mean * vol[None, None, :]
    scale = mean.max((1, 2), keepdims=True)
    np.round(255 * mean / np.where(scale > 0, scale, 1)).astype(np.uint8).tofile(OUT / "season.bin")

    tax = taxonomy(sp)
    names = inat([tax[s]["taxon"] for s in sp if s in tax])
    res = pd.read_csv(ROOT / "pipeline/atlas/results/run2/per_species.csv").set_index("species")
    n = res.n_train
    # 2026's test (gate test C): 1 if the network beat the species' own calendar, 0 if not, None if too few records
    scored = res[(res.n_train >= 400) & (res.n_c >= 20)]
    test = {s: int(g > 0) for s, g in scored.gain_c.items()}
    rows = []
    for i, s in enumerate(sp):
        t = tax.get(s, {})
        common, photo, credit = names.get(int(t["taxon"]) if t.get("taxon") else -1, (None, None, None))
        rows.append({"i": i, "name": s, "common": common, "order": t.get("ord"), "family": t.get("family"),
                     "genus": t.get("genus"), "n": int(n.get(s, 0)), "taxon": int(t["taxon"]) if t.get("taxon") else None,
                     "photo": photo, "credit": credit, "peak": float(f"{top[i]:.4g}"), "test": test.get(s)})
    rows.append({"i": len(sp), "name": "(other)", "common": "Other insects", "peak": float(f"{top[-1]:.4g}")})
    (OUT / "species.json").write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(sp)} species, {flat.size:,} weights ({flat.nbytes / 1e6:.1f} MB), {len(cells)} cells")


if __name__ == "__main__":
    main()
