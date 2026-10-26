"""Weather feeds for the live season, one function per source, all returning daily Tmin/Tmax in deg C by ISO date.

The "weather day" rule (one rule for every source): a day is the local calendar date at the hex centre.
- PRISM (via RCC-ACIS, grid 21): PRISM's day runs 12:00 UTC to 12:00 UTC (7 am to 7 am Central), the usual
  co-op observer day, and ACIS files it under the date it *ends* on. So the low filed on date D is the early morning
  of D (right as filed), but the high filed on D is the afternoon of D - 1. `prism_point` therefore takes each day's
  low from its own ACIS date and its high from the next ACIS date (`weather_days`), which lines PRISM up with Daymet,
  the model's own weather (2023-2025 daily highs: 0.6 C apart this way, 3.0 C as filed). A day's high is known only
  once the next ACIS date is posted, so the newest weather day is one day behind PRISM's newest date.
  Missing days come back as -999 and become NaN.
- Open-Meteo: daily max/min over the local calendar date (timezone=auto).
- Daymet: (year, yday) -> calendar date, yday 1 = 1 Jan; leap years keep 29 Feb and drop 31 Dec.
"""
import datetime as dt
import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np

UA = {"User-Agent": "hatch-live/0.1 (github.com/neevliberman/hatch)", "Content-Type": "application/json"}
ACIS = "https://data.rcc-acis.org/GridData"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"


def _request(url, body=None, timeout=120, tries=5):
    data = None if body is None else json.dumps(body).encode()
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=UA), timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, json.JSONDecodeError):
            time.sleep(2 ** attempt)                  # an empty or cut-off body (ACIS does this now and then) retries too
    raise RuntimeError(f"failed after {tries} tries: {url}")


def dates(start: dt.date, end: dt.date):
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def prism_acis(lat, lng, start: dt.date, end: dt.date):
    """PRISM daily Tmin/Tmax (deg C, 2 decimals; ACIS rounds to whole degrees without "prec") at one point via ACIS,
    exactly as ACIS files them: (tmin, tmax) arrays over ACIS dates start..end, NaN = missing."""
    js = _request(ACIS, {"loc": f"{lng:.4f},{lat:.4f}", "sdate": start.isoformat(), "edate": end.isoformat(),
                         "grid": "21", "elems": [{"name": "maxt", "units": "degreeC", "prec": 2}, {"name": "mint", "units": "degreeC", "prec": 2}]})
    want = {d.isoformat(): i for i, d in enumerate(dates(start, end))}
    tmin = np.full(len(want), np.nan)
    tmax = tmin.copy()
    for day, mx, mn in js.get("data", []):
        i = want.get(day)
        if i is None:
            continue
        if mx is not None and mx > -900:
            tmax[i] = mx
        if mn is not None and mn > -900:
            tmin[i] = mn
    return tmin, tmax


def weather_days(tmin_acis, tmax_acis):
    """ACIS-dated PRISM over start..end + 1 (last axis) -> weather days start..end: each day's low as filed, its high
    from the next ACIS date (PRISM's day ends at 7 am, so the high filed on D + 1 happened on D)."""
    return np.asarray(tmin_acis)[..., :-1], np.asarray(tmax_acis)[..., 1:]


def prism_point(lat, lng, start: dt.date, end: dt.date):
    """PRISM daily Tmin/Tmax at one point by weather day (the rule above): (tmin, tmax) over start..end, NaN = missing.
    Fetches one ACIS date past `end`, so the newest day's high is NaN until PRISM posts the day after."""
    return weather_days(*prism_acis(lat, lng, start, end + dt.timedelta(days=1)))


def open_meteo(lats, lngs, start: dt.date, end: dt.date, chunk=100):
    """Open-Meteo daily forecast Tmin/Tmax (deg C) for many points: arrays [point, day] over start..end.

    Many points go in one request (comma-separated), `chunk` at a time. Days the API does not return stay NaN.
    """
    n, days = len(lats), dates(start, end)
    tmin = np.full((n, len(days)), np.nan)
    tmax = tmin.copy()
    want = {d.isoformat(): i for i, d in enumerate(days)}
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        q = urllib.parse.urlencode({
            "latitude": ",".join(f"{x:.4f}" for x in lats[a:b]), "longitude": ",".join(f"{x:.4f}" for x in lngs[a:b]),
            "daily": "temperature_2m_max,temperature_2m_min", "timezone": "auto",
            "start_date": start.isoformat(), "end_date": end.isoformat()})
        js = _request(f"{OPEN_METEO}?{q}")
        js = js if isinstance(js, list) else [js]
        if len(js) != b - a:
            raise RuntimeError(f"Open-Meteo returned {len(js)} locations for {b - a}")
        for k, loc in enumerate(js):
            d = loc["daily"]
            for day, mx, mn in zip(d["time"], d["temperature_2m_max"], d["temperature_2m_min"]):
                i = want.get(day)
                if i is not None:
                    tmax[a + k, i] = np.nan if mx is None else mx
                    tmin[a + k, i] = np.nan if mn is None else mn
        time.sleep(1)
    return tmin, tmax
