"""Weather columns the model reads. No statsmodels here, so the nightly job can import it."""
import numpy as np

GROUPS = {
    # name: (count column, weather terms, doy knots handled by the formula)
    "moth": ("moth", ["tmin", "tmin2", "rh", "wind", "rain", "cloud", "moon", "moon_cloud"]),
    "firefly": ("firefly", ["tmin", "tmin2", "rh", "wind", "rain", "cloud", "moon", "moon_cloud"]),
    "butterfly": ("butterfly", ["temp", "temp2", "wind", "sun", "rain"]),
}


def add_terms(df):
    """Scaled weather columns. Fixed constants (not fitted per fold), so a shipped model needs only these."""
    out = df.copy()
    out["tmin"] = (df.n_tmin - 14) / 6
    out["tmin2"] = out.tmin ** 2
    out["rh"] = (df.n_rh - 75) / 15
    out["wind"] = (np.minimum(df.n_wind, 12) - 2.5) / 2
    out["rain"] = np.log1p(df.n_rain + df.e_rain) - 0.3
    out["cloud"] = (df.n_cloud - 50) / 35
    out["moon"] = df.moon - 0.5
    out["moon_cloud"] = out.moon * out.cloud
    out["temp"] = (df.d_temp - 22) / 6
    out["temp2"] = out.temp ** 2
    out["sun"] = (df.d_sun - 450) / 200
    out["wind_d"] = (np.minimum(df.d_wind, 12) - 4) / 2
    out["rain_d"] = np.log1p(df.d_rain) - 0.2
    return out


def terms_for(group):
    cols = GROUPS[group][1]
    if group == "butterfly":
        cols = [{"wind": "wind_d", "rain": "rain_d"}.get(c, c) for c in cols]
    return cols



def lift_from(coef, df):
    """exp(weather part): how much more than a no-weather night the sightings run."""
    return np.exp(sum(coef[t] * df[t] for t in coef))
