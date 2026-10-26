"""Does the weather lift still work when the weather is a forecast, not hindsight?

Open-Meteo's historical-forecast archive keeps what its models predicted (the newest model run for each hour, so
a day-ahead-or-closer forecast). Train on 2017-2023 with archive weather, then score 2024-2025 twice: with archive
weather and with forecast weather. Run: python3 -m pipeline.activity.forecastcheck
"""
import json
import os
import time
import urllib.parse

from .evaluate import lift, WINDOWS
from .features import build
from .fetch import CACHE, HOURLY, _wx_get
from .model import Fit
from .regions import END, REGIONS, START
from .terms import add_terms

TEST = [2024, 2025]


def forecast_weather(region, year):
    f = CACHE / f"wxf_{region}_{year}.json"
    if not f.exists():
        lat, lng = REGIONS[region]
        q = dict(latitude=lat, longitude=lng, start_date=f"{year}-{START}", end_date=f"{year}-{END}", hourly=HOURLY,
                 timezone="auto", wind_speed_unit="ms")
        f.write_text(json.dumps(_wx_get("https://historical-forecast-api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q))["hourly"]))
        time.sleep(1)
    return json.loads(f.read_text())


def main():
    arch = add_terms(build())
    fc = add_terms(build(years=TEST, wx_fn=forecast_weather))
    lo, hi = WINDOWS["moth"]
    arch = arch[(arch.doy >= lo) & (arch.doy <= hi)]
    fc = fc[(fc.doy >= lo) & (fc.doy <= hi)]
    train = arch[~arch.year.isin(TEST)]
    base, full = Fit(train, "moth", False), Fit(train, "moth", True)
    out = {}
    for name, te in (("archive_weather", arch[arch.year.isin(TEST)].copy()), ("forecast_weather", fc.copy())):
        te["mu_base"], te["mu_full"] = base.mean(te), full.mean(te)
        te["ll_gain"] = full.loglik(te) - base.loglik(te)
        out[name] = dict(loglik_gain_per_day=float(te.ll_gain.mean()), **lift(te, "moth"))
        print(name, json.dumps(out[name]))
    (os.path.dirname(__file__) and open(os.path.join(os.path.dirname(__file__), "results", "forecastcheck.json"), "w")).write(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
