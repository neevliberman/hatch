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
    # Daymet uses a 365-day year that drops 31 Dec; before that, leap years
    # shift by one day after 28 Feb. Key everything by Daymet's yday.
    leap = d["date"].dt.is_leap_year & (d["doy"] > 59)
    d["yday"] = d["doy"] - leap.astype(int)
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
