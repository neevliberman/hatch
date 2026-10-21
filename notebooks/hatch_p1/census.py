"""Data census (plan P1 step 2): how much data, how clustered, how late."""
import pandas as pd

from .prep import clean


def census(raw):
    d = raw.copy()
    obs = pd.to_datetime(d.observed_on, errors="coerce")
    created = pd.to_datetime(d.created_at, errors="coerce", utc=True).dt.tz_localize(None)
    lag = (created - obs).dt.days
    c = clean(raw)
    top_hex = c.hex.value_counts().index[0]
    th = c[c.hex == top_hex]
    return pd.Series({
        "all records (7 states)": len(d),
        "research grade share": (d.quality_grade == "research").mean(),
        "needs-ID share": (d.quality_grade == "needs_id").mean(),
        "captive share": d.captive.fillna(False).mean(),
        "obscured share": d.obscured.fillna(False).mean(),
        "annotated adult share": (d.life_stage == "adult").mean(),
        "annotated non-adult share": d.life_stage.fillna("").str.startswith("other").mean(),
        "no life-stage annotation share": d.life_stage.isna().mean(),
        "uploaded >30 days late": (lag > 30).mean(),
        "uploaded >1 year late": (lag > 365).mean(),
        "clean records 2015-2025 (deduped)": len(c),
        "distinct observers (clean)": c.user_id.nunique(),
        "hexes with records (clean)": c.hex.nunique(),
        "top hex: records": len(th),
        "top hex: share by its top observer": th.user_id.value_counts().iloc[0] / len(th),
        "top 10 observers' share of clean records": c.user_id.value_counts().iloc[:10].sum() / len(c),
    })
