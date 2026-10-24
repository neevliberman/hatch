"""Radar replay pack: one evening of NEXRAD scans, gridded, quantised and packed for the map's radar view.

Run by hand when an event is added or changed, never in CI or at app build: it needs Py-ART (a large install) and
downloads raw radar volumes (~5 MB each). The app only ever reads what this writes into public/radar/<event>/.

    python3 -m venv /tmp/radar-venv && /tmp/radar-venv/bin/pip install arm-pyart==2.3.0
    /tmp/radar-venv/bin/python pipeline/radar/build_radar.py karx-2014-07-20 --cache /tmp/nexrad

Per scan: the lowest tilt (0.5 degrees), reflectivity and the dual-pol fields, gridded by Py-ART onto 160 x 160
cells centred on the radar (its default azimuthal equidistant projection, sphere R = 6370997 m; cell centres from
-reach to +reach, so a cell is 2 x reach / 159 wide). Kept: 8 km to the reach, 80 km unless the event says otherwise
(the blind centre and the far edge, where the beam is high, are blanked). Levels: 0 = nothing, 1..15 = 10 dBZ upwards in 2.5 dBZ steps. Rain-like cells
(20 dBZ or more with a correlation coefficient of 0.95 or more) are dropped. Output: frames.bin.gz (all frames, 4 bits
a cell, rows south to north, high nibble first) and meta.json (times, grid, levels, and the insect check below).

The insect check: for the cells of 25 dBZ or more, the median correlation coefficient (rain about 0.99, insects well
under 0.9) and differential reflectivity (rain 0 to 2 dB, long thin insects far higher). Printed per scan and kept
in meta.json, so whoever adds an event sees whether it is insects before it ships.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import urllib.request
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MIRROR = "https://unidata-nexrad-level2.s3.amazonaws.com"  # same archive as noaa-nexrad-level2, no account needed

# Each event: the radar, its site (from the volume header), the UTC window of scans, and the frame the replay starts
# on. The app's own list (src/radar/events.ts) carries the words; the ids must match.
EVENTS = {
    "karx-2014-07-20": {
        "site": "KARX",
        "lat": 43.8228,
        "lon": -91.1911,
        # Evening of Sunday 20 July 2014, CDT (UTC-5): 7:36 pm to midnight.
        "from": "2014-07-21T00:30:00Z",
        "to": "2014-07-21T05:05:00Z",
        # The first echo off the river shows at about 8:55 pm; before that the map is empty (or clutter).
        "start": "2014-07-21T01:50:00Z",
    },
    "kcle-2019-06-26": {
        "site": "KCLE",
        "lat": 41.4132,
        "lon": -81.8599,
        # Evening of Wednesday 26 June 2019, EDT (UTC-4): 9:45 pm to 1 am. Sunset at Cleveland 9:06 pm.
        "from": "2019-06-27T01:45:00Z",
        "to": "2019-06-27T05:00:00Z",
        # The plume rises over the islands at about 10:35 pm; the replay opens on the scan just before.
        "start": "2019-06-27T02:28:00Z",
        # The swarm leaves the western basin 60 to 120 km from the radar, so this one keeps 120 km (1.5 km cells).
        "reach_km": 120,
    },
}

N = 160
NEAR = 8.0  # km: the blind centre, blanked
REACH = 80.0  # km kept, unless an event says otherwise ("reach_km"); the grid's half-width is the same, so cells are
#               2 x reach / 159 wide (about 1 km at 80 km, 1.5 km at 120 km) and every pack is 160 x 160
DBZ0, STEP, LEVELS = 10.0, 2.5, 15
RAIN = (20.0, 0.95)  # dBZ, CC at or above which a cell reads as rain


def utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def list_scans(site: str, t0: datetime, t1: datetime) -> list[tuple[datetime, str]]:
    """Volume scans on the mirror between t0 and t1 (a window may cross midnight UTC)."""
    out = []
    day = t0.date()
    while day <= t1.date():
        prefix = f"{day:%Y/%m/%d}/{site}/"
        token = None
        while True:
            q = f"{MIRROR}/?list-type=2&prefix={prefix}" + (f"&continuation-token={urllib.request.quote(token)}" if token else "")
            xml = ElementTree.fromstring(urllib.request.urlopen(q, timeout=60).read())
            ns = {"s": xml.tag.split("}")[0].strip("{")}
            for k in xml.iterfind("s:Contents/s:Key", ns):
                m = re.search(rf"{site}(\d{{8}}_\d{{6}})_V0\d(\.gz)?$", k.text or "")
                if m:
                    t = datetime.strptime(m.group(1), "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
                    if t0 <= t <= t1:
                        out.append((t, k.text))
            token = xml.findtext("s:NextContinuationToken", None, ns)
            if not token:
                break
        day += timedelta(days=1)
    return sorted(out)


def fetch(key: str, cache: Path) -> Path:
    path = cache / key.rsplit("/", 1)[-1]
    if not path.exists():
        print(f"  downloading {key}", flush=True)
        tmp = path.with_suffix(".part")
        with urllib.request.urlopen(f"{MIRROR}/{key}", timeout=300) as r, open(tmp, "wb") as f:
            f.write(r.read())
        tmp.rename(path)
    return path


def grid(path: Path, lat: float, lon: float, half: float) -> dict[str, np.ndarray]:
    import pyart  # build-time only

    radar = pyart.io.read_nexrad_archive(str(path))
    # The app places the frames from the site in EVENTS; the grid is centred on the site in the volume's header.
    head = (float(radar.latitude["data"][0]), float(radar.longitude["data"][0]))
    if abs(head[0] - lat) > 1e-4 or abs(head[1] - lon) > 1e-4:
        sys.exit(f"{path.name}: the radar's header puts it at {head}, EVENTS says ({lat}, {lon})")
    g = pyart.map.grid_from_radars(
        radar.extract_sweeps([0]),
        grid_shape=(1, N, N),
        grid_limits=((0, 500), (-half, half), (-half, half)),
        fields=["reflectivity", "cross_correlation_ratio", "differential_reflectivity"],
    )
    return {k: np.ma.filled(g.fields[k]["data"][0].astype(float), np.nan) for k in g.fields}


def levels(d: dict[str, np.ndarray], rng: np.ndarray, kept: tuple[float, float]) -> np.ndarray:
    z, cc = d["reflectivity"], d["cross_correlation_ratio"]
    with np.errstate(invalid="ignore"):
        lvl = np.nan_to_num(np.clip(np.floor((z - DBZ0) / STEP) + 1, 0, LEVELS), nan=0)
        lvl[(rng < kept[0]) | (rng > kept[1])] = 0
        lvl[(z >= RAIN[0]) & (cc >= RAIN[1])] = 0
    return lvl.astype(np.uint8)


def check(d: dict[str, np.ndarray], rng: np.ndarray, kept: tuple[float, float]) -> dict | None:
    z, cc, zdr = d["reflectivity"], d["cross_correlation_ratio"], d["differential_reflectivity"]
    with np.errstate(invalid="ignore"):
        m = (z >= 25) & (rng > kept[0]) & (rng < kept[1]) & np.isfinite(cc)
    if m.sum() < 30:
        return None
    return {"cells": int(m.sum()), "cc": round(float(np.median(cc[m])), 2), "zdr": round(float(np.nanmedian(zdr[m])), 1),
            "rain_like": int(((z >= RAIN[0]) & (cc >= RAIN[1]) & (rng > kept[0]) & (rng < kept[1])).sum())}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("event", choices=sorted(EVENTS))
    ap.add_argument("--cache", type=Path, required=True, help="folder for the raw volume scans (downloaded if missing)")
    ap.add_argument("--offline", action="store_true", help="use only the files already in --cache, no listing or download")
    ap.add_argument("--out", type=Path, help="default: public/radar/<event>/")
    a = ap.parse_args()
    ev = EVENTS[a.event]
    out = a.out or ROOT / "public" / "radar" / a.event
    a.cache.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    warnings.filterwarnings("ignore")

    t0, t1 = utc(ev["from"]), utc(ev["to"])
    if a.offline:
        scans = []
        for p in sorted(a.cache.glob(f"{ev['site']}*_V0*")):
            if p.suffix == ".part":  # a download cut short
                continue
            m = re.search(r"(\d{8}_\d{6})", p.name)
            t = datetime.strptime(m.group(1), "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc) if m else None
            if t and t0 <= t <= t1:
                scans.append((t, p))
    else:
        scans = [(t, fetch(k, a.cache)) for t, k in list_scans(ev["site"], t0, t1)]
    if not scans:
        sys.exit("no scans found")

    kept = (NEAR, float(ev.get("reach_km", REACH)))
    half = kept[1] * 1000
    spacing = 2 * half / (N - 1)
    c = (np.arange(N) * spacing - half) / 1000  # cell centres, km
    y, x = np.meshgrid(c, c, indexing="ij")
    rng = np.hypot(x, y)
    frames, times, checks = [], [], []
    for t, p in scans:
        d = grid(p, ev["lat"], ev["lon"], half)
        frames.append(levels(d, rng, kept))
        times.append(t.strftime("%Y-%m-%dT%H:%M:%SZ"))
        ck = check(d, rng, kept)
        checks.append(ck)
        print(f"{t:%H:%M} UTC  cells>0 {int((frames[-1] > 0).sum()):5d}  " +
              (f"Z>=25: {ck['cells']:4d} cells, CC median {ck['cc']:.2f}, ZDR median {ck['zdr']:.1f} dB, rain-like {ck['rain_like']}" if ck else "Z>=25: too few cells"),
              flush=True)

    flat = np.stack(frames).reshape(len(frames), -1)
    packed = (flat[:, 0::2] << 4 | flat[:, 1::2]).astype(np.uint8)
    # mtime 0: the same scans give the same bytes, so a rebuild with no change shows no diff.
    (out / "frames.bin.gz").write_bytes(gzip.compress(packed.tobytes(), 9, mtime=0))
    start = next((i for i, t in enumerate(times) if utc(t) >= utc(ev["start"])), 0)
    busy = [ck for ck in checks if ck and ck["cells"] >= 100]
    meta = {
        "event": a.event,
        "site": ev["site"],
        "lat": ev["lat"],
        "lon": ev["lon"],
        "times": times,
        "start": start,
        "grid": {"n": N, "half_m": half, "spacing_m": round(spacing, 3), "rows": "south to north", "packing": "4 bits, high nibble first",
                 "projection": "azimuthal equidistant on a sphere, R 6370997 m, centred on the radar (Py-ART grid_from_radars)"},
        "levels": {"none": 0, "dbz_min": DBZ0, "dbz_step": STEP, "count": LEVELS},
        "kept": {"range_km": list(kept), "rain_dropped": f"{RAIN[0]:g} dBZ or more with CC {RAIN[1]} or more"},
        "insect_check": {
            "what": f"cells of 25 dBZ or more, {kept[0]:g} to {kept[1]:g} km out, in scans with 100 or more of them",
            "scans": len(busy),
            "cc_median": [min(ck["cc"] for ck in busy), max(ck["cc"] for ck in busy)] if busy else None,
            "zdr_median_db": [min(ck["zdr"] for ck in busy), max(ck["zdr"] for ck in busy)] if busy else None,
            "rain_like_cells": sum(ck["rain_like"] for ck in checks if ck),
        },
        "source": f"NOAA NEXRAD Level II, {ev['site']}, via {MIRROR}",
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(f"{len(frames)} frames, start {start} ({times[start]}), {(out / 'frames.bin.gz').stat().st_size:,} bytes -> {out}")
    print("insect check:", json.dumps(meta["insect_check"]))


if __name__ == "__main__":
    main()
