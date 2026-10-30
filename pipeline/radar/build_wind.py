"""Wind for each radar replay night, from the Open-Meteo archive (ERA5 reanalysis): public/radar/<id>/wind.json.

The night view (src/radar/night.ts) drifts its simulated insects with this. Hourly 100 m wind at the radar, the
highest level the archive offers; insects fly lower and higher than that, so it is a stand-in, said so on the card.
Run: python3 pipeline/radar/build_wind.py   (needs only the standard library and the network)
"""
import json, sys, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "public" / "radar"
for d in sorted(ROOT.iterdir()):
    meta = json.loads((d / "meta.json").read_text())
    t0 = datetime.fromisoformat(meta["times"][0].replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(meta["times"][-1].replace("Z", "+00:00"))
    a, b = (t0 - timedelta(hours=1)).date(), (t1 + timedelta(hours=1)).date()
    url = ("https://archive-api.open-meteo.com/v1/archive?latitude=%s&longitude=%s&start_date=%s&end_date=%s"
           "&hourly=wind_speed_100m,wind_direction_100m&wind_speed_unit=ms&timezone=UTC" % (meta["lat"], meta["lon"], a, b))
    for attempt in range(5):
        try:
            h = json.load(urllib.request.urlopen(url, timeout=30))["hourly"]
            break
        except Exception as e:  # rate limit: wait and retry
            print(d.name, "retry", e, file=sys.stderr)
            time.sleep(8 * (attempt + 1))
    else:
        raise SystemExit("no wind for " + d.name)
    out = {
        "source": "Open-Meteo archive (ERA5), 100 m wind at the radar",
        "times": [datetime.fromisoformat(t).replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") for t in h["time"]],
        "speed": h["wind_speed_100m"],  # m/s
        "from": h["wind_direction_100m"],  # degrees the wind blows FROM, clockwise from north
    }
    (d / "wind.json").write_text(json.dumps(out, separators=(",", ":")))
    print(d.name, len(out["times"]), "hours")
    time.sleep(3)
