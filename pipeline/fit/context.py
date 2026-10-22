"""Load everything one P3 run needs into a Context (records, degree-days, effort)."""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import data
from hatch_p1.daymet import temperature_cube
from hatch_p1.degree_days import accumulate
from hatch_p1.prep import YEARS

BASE = 10.0


@dataclass
class Context:
    rec: pd.DataFrame        # cleaned, deduped luna records (all broods), indexed to the cube
    hexes: list
    years: np.ndarray
    cum: np.ndarray          # cumulative degree-days [hex, year, 365]
    inc: np.ndarray          # daily degree-days [hex, year, 365] (0 before 1 March)
    E: np.ndarray            # effort [state, year, 365]


def daily_from_cum(cum):
    return np.diff(cum, axis=-1, prepend=0).astype(np.float32)


def index_records(d, hexes, years):
    hi = {h: i for i, h in enumerate(hexes)}
    r = d[d.hex.isin(hi)].copy()
    r["h"] = r.hex.map(hi).astype(int)
    r["y"] = (r.year - years[0]).astype(int)
    r["t"] = (r.yday - 1).astype(int)
    r["band"] = r.band.astype(str)
    r["s"] = r.state.map({s: i for i, s in enumerate(data.STATES)}).astype(int)
    return r.reset_index(drop=True)


def load_context(extra_hexes=()):
    d = data.luna_records()
    d = d[d.doy <= 240]           # after day 240 is never first brood (frozen P1 rule)
    hexes = sorted(set(d.hex) | set(extra_hexes))
    hexes, years, tmin, tmax = temperature_cube(hexes, YEARS[0], YEARS[1], data.DATA / "daymet")
    cum = accumulate(tmin, tmax, BASE).astype(np.float32)
    E = data.effort_matrix(data.fetch_effort(), years)
    return Context(index_records(d, hexes, years), list(hexes), years, cum, daily_from_cum(cum), E)
