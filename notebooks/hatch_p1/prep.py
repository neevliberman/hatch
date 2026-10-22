"""Apply the frozen record filters (see FROZEN_CHOICES.md)."""
import h3
import pandas as pd

RES = 4
YEARS = (2015, 2025)
BANDS = [37, 39, 41, 43, 45, 49]
BAND_LABELS = ["37-39", "39-41", "41-43", "43-45", "45-49"]


def clean(df, years=YEARS):
    d = df.copy()
    d["date"] = pd.to_datetime(d["observed_on"], errors="coerce")
    d = d.dropna(subset=["date", "lat", "lng"])
    d["year"] = d["date"].dt.year
    d["doy"] = d["date"].dt.dayofyear
    # Daymet keeps 29 Feb and drops 31 Dec in leap years, so its yday equals the
    # calendar day of year for every day we use (we stop at day 240).
    d["yday"] = d["doy"]
    d["hex"] = [h3.latlng_to_cell(a, b, RES) for a, b in zip(d["lat"], d["lng"])]
    d["band"] = pd.cut(d["lat"], BANDS, labels=BAND_LABELS, right=False)
    keep = (
        (d["quality_grade"] == "research")
        & ~d["captive"].fillna(False)
        & ~d["obscured"].fillna(False)
        & (d["accuracy_m"].isna() | (d["accuracy_m"] <= 5000))
        & (d["life_stage"].isna() | (d["life_stage"] == "adult"))
        & d["year"].between(*years)
        & d["band"].notna()
    )
    d = d[keep]
    return d.drop_duplicates(["user_id", "hex", "date"])
