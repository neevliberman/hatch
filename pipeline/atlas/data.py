"""Atlas data: records from the Parquet store, the warmth clock, splits and species list (FROZEN_ATLAS.md).

Analogy: the records are a giant box of receipts, one per insect photo. This module sorts them (dedupe bursts, tag each
with its warmth cell and clock), and splits them into the piles the frozen rules name.
"""
from dataclasses import dataclass

import duckdb
import h3
import numpy as np
import pandas as pd

from pipeline.atlas.config import BOX, DATA, FIRST_YEAR, HELD_OUT_STATES, LAST_YEAR, TEST_YEAR, WARMTH_RES

MIN_SPECIES = 100      # records in the training split to get an output of its own
CLIP_DAYS = 30.0       # "days ahead" never goes past ±30
HOLD_RATE = 2.0        # DD/day: after midsummer, once the typical curve gains less than this, Δ holds
LAMBDAS = (0.0, 0.5, 1.0)  # the three clocks: calendar, half warmth, full warmth


def load_records(path=DATA / "records", last_year=LAST_YEAR):
    """All records, one per observer × species × warmth cell × day (the burst filter)."""
    con = duckdb.connect()
    df = con.execute(f"""
        SELECT inat_id, inat_taxon, rank, species, genus, family, "order", lat, lng, year, month, day, observer, state
        FROM read_parquet('{path}/*/*.parquet', hive_partitioning=true)
        WHERE lat BETWEEN {BOX['s']} AND {BOX['n']} AND lng BETWEEN {BOX['w']} AND {BOX['e']}
          AND year BETWEEN {FIRST_YEAR} AND {last_year}
    """).df()
    df["cell"] = [h3.latlng_to_cell(a, b, WARMTH_RES) for a, b in zip(df.lat.to_numpy(), df.lng.to_numpy())]
    date = pd.to_datetime(dict(year=df.year, month=df.month, day=df.day), errors="coerce")
    df = df[date.notna()].copy()
    date = date[date.notna()]
    doy = date.dt.dayofyear.to_numpy()
    leap = date.dt.is_leap_year.to_numpy()
    df["doy"] = np.where(leap & (doy == 366), 365, doy)  # Daymet's 365-day calendar keeps 29 Feb, drops 31 Dec
    df["taxon"] = df.species.where(df.species.notna() & (df["rank"].isin(["SPECIES", "SUBSPECIES", "VARIETY",
                                                                           "FORM"])), None)
    key = df.taxon.fillna("~" + df.genus.fillna(df.family.fillna(df["order"].fillna("?"))))
    df = df.assign(_k=key).sort_values("inat_id", kind="stable").drop_duplicates(["observer", "_k", "cell", "year", "doy"]).drop(columns="_k")
    df["held_state"] = df.state.isin(HELD_OUT_STATES)
    return df.reset_index(drop=True)


@dataclass
class Warmth:
    cells: np.ndarray       # [C] H3 ids
    years: np.ndarray       # [Y]
    dd: np.ndarray          # [C, Y, 365] degree-days since 1 Mar
    clim: np.ndarray        # [C, 365] typical curve, from the climatology years only
    index: dict

    @classmethod
    def load(cls, clim_years):
        z = np.load(DATA / "warmth.npz")
        years = z["years"]
        sel = np.isin(years, clim_years)
        dd = z["dd10"]
        return cls(z["cells"], years, dd, dd[:, sel].mean(1), {c: i for i, c in enumerate(z["cells"])})

    def days_ahead(self):
        """Δ [C, Y, 365]: the day this place usually reaches today's degree-days, minus today. Clipped, then held."""
        C, Y, D = self.dd.shape
        days = np.arange(1, D + 1, dtype=np.float32)
        out = np.zeros((C, Y, D), np.float32)
        for c in range(C):
            curve = self.clim[c] + days * 1e-4  # strictly increasing, so the inverse exists
            rate = np.gradient(self.clim[c])
            hold = np.argmax((days > 182) & (rate < HOLD_RATE)) or D
            for y in range(Y):
                t_usual = np.interp(self.dd[c, y] + days * 1e-4, curve, days)
                d = np.clip(t_usual - days, -CLIP_DAYS, CLIP_DAYS)
                d[self.dd[c, y] + self.clim[c] < 1] = 0  # before any warmth this year or usually
                d[hold:] = d[hold - 1]
                out[c, y] = d
        return out

    def typical_july(self):
        return self.clim[:, 180]  # degree-days usually banked by 30 June


def attach_clock(df, w: Warmth, ahead):
    ci = np.array([w.index.get(c, -1) for c in df.cell])
    assert (ci >= 0).all(), "a record falls outside the warmth grid"
    yi = df.year.to_numpy() - w.years[0]
    df = df.assign(ci=ci, delta=ahead[ci, yi, df.doy.to_numpy() - 1], norm_dd=w.typical_july()[ci])
    return df[np.isfinite(df.delta.to_numpy())]  # 2026 days past the newest weather have no clock yet


def splits(df, tuning=False, run2=False):
    """(train, test_a, test_b) by FROZEN_ATLAS.md. tuning=True: train 2015-2023, score 2024 (training states).
    run2=True (amendment 1): train 2015-2025, test C = 2026 training states, test D = WI/MN 2026."""
    home = ~df.held_state
    if run2:
        return df[home & (df.year <= TEST_YEAR)], df[home & (df.year == TEST_YEAR + 1)], \
            df[df.held_state & (df.year == TEST_YEAR + 1)]
    if tuning:
        return df[home & (df.year < TEST_YEAR - 1)], df[home & (df.year == TEST_YEAR - 1)], None
    return df[home & (df.year < TEST_YEAR)], df[home & (df.year == TEST_YEAR)], df[df.held_state]


def species_list(train):
    n = train.taxon.value_counts()
    return n[n >= MIN_SPECIES].index.tolist()


def labels(df, species):
    idx = {s: i for i, s in enumerate(species)}
    return np.array([idx.get(t, len(species)) for t in df.taxon])  # last = "other"
