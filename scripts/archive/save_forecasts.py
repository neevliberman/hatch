#!/usr/bin/env python3
"""Save raw NWS gridded forecast JSON for ~20 Midwest points (stdlib only).

Usage: save_forecasts.py OUT_DIR
Writes OUT_DIR/<point>.json. Exit 0 if at least one point saved, 1 if all failed.
NWS keeps no old forecasts, so every night not saved is a backtest lost for good.
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path

UA = "hatch-forecast-archive (https://github.com/neevliberman/hatch/issues)"  # NWS wants a contact; a URL, not an email, since the repo is public
POINTS = {  # name: (lat, lon), spread over WI IL MN IA MI IN OH
    "wi-milwaukee": (43.04, -87.91), "wi-madison": (43.07, -89.40), "wi-eauclaire": (44.81, -91.50), "wi-rhinelander": (45.64, -89.41),
    "il-chicago": (41.88, -87.63), "il-peoria": (40.69, -89.59), "il-carbondale": (37.73, -89.22),
    "mn-minneapolis": (44.98, -93.27), "mn-duluth": (46.79, -92.10), "mn-rochester": (44.02, -92.47), "mn-bemidji": (47.47, -94.88),
    "ia-desmoines": (41.59, -93.62), "ia-cedarrapids": (41.98, -91.67), "ia-sioux-city": (42.50, -96.40),
    "mi-detroit": (42.33, -83.05), "mi-grandrapids": (42.96, -85.67), "mi-marquette": (46.54, -87.40),
    "in-indianapolis": (39.77, -86.16), "in-southbend": (41.68, -86.25), "oh-columbus": (39.96, -83.00), "oh-cleveland": (41.50, -81.69),
}


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print(f"  retry {i + 1}/{tries} {url}: {e}", file=sys.stderr)
            time.sleep(2 ** i * 2)
    raise RuntimeError(f"gave up on {url}")


def main(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    ok = 0
    for name, (lat, lon) in POINTS.items():
        try:
            meta = get(f"https://api.weather.gov/points/{lat},{lon}")
            grid = get(meta["properties"]["forecastGridData"])
            (out / f"{name}.json").write_text(json.dumps(grid, separators=(",", ":")))
            ok += 1
            print(f"saved {name}")
        except Exception as e:  # keep going: one bad point must not lose the other 19
            print(f"FAILED {name}: {e}", file=sys.stderr)
        time.sleep(1)
    print(f"{ok}/{len(POINTS)} points saved")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
