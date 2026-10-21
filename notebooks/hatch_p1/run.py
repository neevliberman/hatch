"""Glue: records + temperatures -> scored baselines. Used by the notebook."""
from pathlib import Path

import numpy as np
import pandas as pd

from . import model
from .brood import brood_cutoff
from .daymet import temperature_cube
from .prep import YEARS, clean

DATA = Path(__file__).resolve().parent.parent / "data"
BASES = np.arange(0, 15.01, 0.5)


def load(species_file, split_broods=True, frac=0.8):
    d = clean(pd.read_parquet(DATA / species_file))
    cut = {}
    if split_broods:
        for b, g in d.groupby("band", observed=True):
            cut[b] = brood_cutoff(g.doy, frac=frac)
        d = d[[(t <= (cut[b] or 240)) for b, t in zip(d.band, d.doy)]]
    else:
        d = d[d.doy <= 240]
    return d, cut


def temps(rec):
    hexes, years, tmin, tmax = temperature_cube(sorted(rec.hex.unique()), YEARS[0], YEARS[1], DATA / "daymet")
    return hexes, years, tmin, tmax


def index(rec, hexes, years):
    hi = {h: i for i, h in enumerate(hexes)}
    r = rec[rec.hex.isin(hi)].copy()
    r["h"] = r.hex.map(hi)
    r["y"] = r.year - years[0]
    r["t"] = r.yday - 1
    r["band"] = r.band.astype(str)
    return r
