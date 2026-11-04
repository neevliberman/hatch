#!/usr/bin/env python3
"""Weekly rebuild of the Atlas's "this year" files from fresh data, with no torch: everything the app shows for the
current year (the 2027 option of the season menu, its time bar, the surprises / off schedule / fewer photos strips,
the year's photo dots).

What one run does (analogy: a teacher re-marking this term's exams as new papers come in):
1. Warmth: this year's PRISM (RCC-ACIS, as the live job reads it: live/sources.prism_point) at every map cell, then
   the 7-day Open-Meteo forecast, against the typical year in weekly_static.npz -> "days ahead" (data.days_ahead,
   the network's own clock) -> ahead-YEAR.bin. After the forecast the year runs as typical (0), not held.
2. Photos: this year's research-grade iNaturalist insect photos in the Atlas box (CC0 / CC BY / CC BY-NC only, both
   the observation and the photo), pulled incrementally into a local cache: what changed since the last run, whatever
   its grade or licence now, so photos that stopped qualifying leave; all of it again every FULL_EVERY days (the only
   way deleted or moved photos leave), or when the cache is gone. About one request a second, backing off on 429.
3. Expected vs seen (seen.py's rules, unchanged): the network (net_reference.NumpyAtlas, plain numpy on the CPU)
   says how likely each photo is of each species; summed, that is each species' expected photos, set against the
   photos there were -> seen-YEAR.bin / seen-YEAR.json (with "so_far" while the year is still filling in).
4. season.bin (the time bar's typical and this-year curves, export.py's), dots-year/<i>.bin (this year's photos only,
   dots.py's format) and year.json (which year; where real warmth ends; the species, cells and model it was built for;
   every file's sha256). The app reads year.json to pick its year.

Before FLIP (15 April), or with too few photos (MIN_PHOTOS), it writes nothing and exits 0: the site keeps the last
year it had. The outputs go to --out; the workflow packs them into the `atlas-data` release, and deploy-pages lays
them over main's public/atlas (scripts/atlas-overlay.mjs: checks the manifest and that they were built for the same
species, cells and model, swaps this year's dots into main's, and restamps the service worker so visitors refetch).

  python3 pipeline/atlas/weekly.py --out /tmp/atlas                      # this year, incremental
  python3 pipeline/atlas/weekly.py --out /tmp/atlas --year 2026 --compare public/atlas
  python3 pipeline/atlas/weekly.py --out /tmp/a --year 2026 --taxa 47226 48662 --no-dots   # dry run on a few species
"""
import argparse
import datetime as dt
import hashlib
import http.client
import json
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import h3
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))
from pipeline.atlas import config as C  # noqa: E402
from pipeline.atlas import data as D  # noqa: E402  (its warmth clock; no records store needed)
from pipeline.atlas import dots as DOTS  # noqa: E402
from pipeline.atlas import seen as SEEN  # noqa: E402
from pipeline.atlas.config import BOX, DATA, OUT, SEASON, STEP, WARMTH_RES  # noqa: E402
from pipeline.atlas.net_reference import NumpyAtlas  # noqa: E402
from pipeline.atlas.weekly_static import START_DOY, STATIC, daily_dd  # noqa: E402

API = "https://api.inaturalist.org/v2/observations"
UA = {"User-Agent": "hatch-atlas-weekly/0.1 (github.com/neevliberman/hatch)"}
INSECTA = 47158
LICENCES = "cc0,cc-by,cc-by-nc"
OPEN = frozenset(LICENCES.split(","))
FIELDS = ("id,observed_on,location,quality_grade,license_code,photos.license_code,user.id,taxon.id,taxon.rank_level,"
          "taxon.min_species_taxon_id")
PAGE = 200                  # iNaturalist's largest page
INTERVAL = 1.0              # seconds between request starts, across all threads (iNat asks for about 1 a second)
WORKERS = 4                 # requests in flight (each takes 2-4 s server-side, so 4 keep about 1 a second going)
FULL_EVERY = 14             # days: pull the whole year again. Only a full pull sees photos that were deleted, moved out
                            # of the box or re-identified as something other than an insect (an update query can't).
FULL_SLACK_HOURS = 12       # a run a few hours earlier in the week than the last full pull still counts as 14 days on
OVERLAP = dt.timedelta(days=1)  # each incremental pull reaches back this far past the last one
MAX_DROP = 0.2              # the cached year shrinking by more than this since the last run: stop, publish nothing
MIN_PHOTOS = 1000           # fewer photos than this (after the burst filter): write nothing, the site keeps its year
FLIP = (4, 15)              # (month, day): the new year never takes over before this. 2026 had 3.3k photos by 1 March,
                            # but too few weeks of them to say anything about the year.
PRISM_LAG_DAYS = 3          # as live/build_live.py
FORECAST_DAYS, MIN_FORECAST_DAYS = 7, 5
MAX_BAD_CELLS = 0.02
CACHE = DATA / "weekly"


# ---------------------------------------------------------------- iNaturalist
class Limiter:
    """At most one request start per `interval` seconds, shared by every thread. pause() (a 429) pushes every start
    back, including those already promised a slot: a thread whose slot was reserved before the pause asks again."""

    def __init__(self, interval=INTERVAL, clock=time.monotonic, sleep=time.sleep):
        self.interval, self.clock, self.sleep = interval, clock, sleep
        self.lock = threading.Lock()
        self.next = 0.0
        self.paused = 0           # bumped by every pause, so reserved slots know they were cancelled

    def wait(self):
        while True:
            with self.lock:
                now = self.clock()
                at = max(now, self.next)
                self.next = at + self.interval
                gen = self.paused
            if at > now:
                self.sleep(at - now)
            with self.lock:
                if self.paused == gen:
                    return

    def pause(self, seconds):
        """Everyone waits (a 429: the server asked us to slow down)."""
        with self.lock:
            self.paused += 1
            self.next = max(self.next, self.clock()) + seconds


def get(params, limiter, opener=urllib.request.urlopen, tries=8, sleep=time.sleep):
    """One iNaturalist page as JSON. A 429 or 5xx pauses every thread (Retry-After if given, else doubling from 5 s)
    and tries again; a cut-off or empty body tries again too."""
    url = f"{API}?{urllib.parse.urlencode(params)}"
    for attempt in range(tries):
        limiter.wait()
        try:
            with opener(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            ra = (e.headers or {}).get("Retry-After") if hasattr(e, "headers") else None
            wait = float(ra) if ra and str(ra).isdigit() else min(5 * 2 ** attempt, 300)
            print(f"  iNat {e.code}: waiting {wait:.0f} s", flush=True)
            limiter.pause(wait)
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, json.JSONDecodeError):
            sleep(min(2 ** attempt, 60))
    raise RuntimeError(f"iNaturalist kept failing: {url}")


def query(year, taxa=None):
    """The full pull's query: research-grade insect photos in the box, openly licensed (observation and photo)."""
    return {"taxon_id": ",".join(map(str, taxa)) if taxa else INSECTA, "quality_grade": "research",
            "license": LICENCES, "photo_license": LICENCES, "photos": "true",
            "swlat": BOX["s"], "swlng": BOX["w"], "nelat": BOX["n"], "nelng": BOX["e"],
            "d1": f"{year}-01-01", "d2": f"{year}-12-31", "per_page": PAGE, "order_by": "id", "order": "asc"}


def changes(year, taxa=None):
    """The incremental query: every insect observation of the year in the box, whatever its grade, licence or photos,
    so one that stopped qualifying (lost research grade, licence or photo licence changed, photos deleted) comes back
    too, and rows_of() decides. The caller adds updated_since. An observation whose location was made private (or
    obscured) probably does not: the box filter can't match hidden coordinates. Those, like deletions, leave the cache
    at the next full pull, within 14 days."""
    q = query(year, taxa)
    for k in ("quality_grade", "license", "photo_license", "photos"):
        del q[k]
    return q


def usable(o, year=None):
    """True for an observation the Atlas may count and show: research grade, openly licensed, at least one openly
    licensed photo, a public location, a day (in `year`, if given) and a taxon."""
    t = o.get("taxon") or {}
    day = str(o.get("observed_on") or "")
    return bool(
        o.get("quality_grade") == "research" and (o.get("license_code") or "").lower() in OPEN
        and any((p.get("license_code") or "").lower() in OPEN for p in o.get("photos") or [])
        and o.get("location") and day and t.get("id") and (year is None or day[:4] == str(year)))


def rows_of(results, year=None):
    """API results -> (rows of the usable ones, ids of the rest)."""
    out, gone = [], []
    for o in results:
        if not usable(o, year):
            gone.append(int(o["id"]))
            continue
        t = o["taxon"]
        lat, lng = (float(v) for v in o["location"].split(","))
        rank = t.get("rank_level") or 100
        sp = t.get("min_species_taxon_id") if rank <= 10 else None
        out.append((int(o["id"]), str(o["observed_on"])[:10], lat, lng, int((o.get("user") or {}).get("id") or 0),
                    int(t["id"]), float(rank), int(sp) if sp else 0))
    return out, gone


COLUMNS = ["id", "day", "lat", "lng", "user", "taxon", "rank", "species"]


SLACK = 3


class Incomplete(RuntimeError):
    """A query returned fewer observations than it said it had."""


def stream(params, limiter, max_pages=None, getter=get, year=None):
    """stream_once(), tried a second time from the start if it comes up short (an index catching up mid-pull);
    a second shortfall fails the run. -> (usable rows, ids that no longer qualify, pages over both tries)."""
    try:
        return stream_once(params, limiter, max_pages, getter, year)
    except Incomplete as e:
        print(f"  {e}; trying that stream once more", flush=True)
    return stream_once(params, limiter, max_pages, getter, year)


def stream_once(params, limiter, max_pages=None, getter=get, year=None):
    """Every page of one query, by id (id_above), so no deep-offset limit. A page shorter than asked for does not end it;
    only an empty one does, and then the count must match the first page's total_results (observations added during
    the pull may push it over, never under). -> (usable rows, ids that no longer qualify, pages)."""
    rows, gone, last, pages, seen, total = [], [], 0, 0, 0, None
    while max_pages is None or pages < max_pages:
        js = getter({**params, "id_above": last, "fields": FIELDS}, limiter)
        if total is None:
            total = int(js.get("total_results", 0))
        res = js.get("results") or []
        pages += 1
        if not res:
            if seen < total - SLACK - total // 2000:   # a few may lose research grade or be deleted mid-pull
                raise Incomplete(f"iNaturalist listed {total} observations but returned {seen}: {params}")
            break
        seen += len(res)
        r, g = rows_of(res, year)
        rows += r
        gone += g
        last = max(int(o["id"]) for o in res)
    return rows, gone, pages


def months(year, through):
    """(d1, d2) for each month of `year` up to `through`: the full pull's streams, run side by side."""
    out = []
    for m in range(1, 13):
        a = dt.date(year, m, 1)
        if a > through:
            break
        b = dt.date(year + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)
        out.append((a.isoformat(), min(b, through).isoformat()))
    return out


def merge(cache, fresh, gone=()):
    """Cache rows updated by fresh ones (same id: the fresh row wins), minus ids that no longer qualify."""
    df = pd.concat([cache, fresh], ignore_index=True)
    df = df.drop_duplicates("id", keep="last")
    if len(gone):
        df = df[~df.id.isin(set(gone))]
    return df.sort_values("id", kind="stable").reset_index(drop=True)


def update_photos(year, today, cache_dir, taxa=None, full=False, max_pages=None, workers=WORKERS, limiter=None,
                  getter=get, now=None):
    """This year's photos, from the cache plus what changed since the last run. `now`: the run's start (UTC), which
    becomes the next run's updated_since and decides whether a full pull is due. -> (DataFrame, stats)."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    tag = f"{year}" + (f"-taxa-{'-'.join(map(str, taxa))}" if taxa else "")
    f_rows, f_meta = cache_dir / f"obs-{tag}.parquet", cache_dir / f"meta-{tag}.json"
    now = now or dt.datetime.now(dt.timezone.utc)
    limiter = limiter or Limiter()
    meta = json.loads(f_meta.read_text()) if f_meta.exists() else {}
    have = f_rows.exists() and meta.get("columns") == COLUMNS and meta.get("fields") == FIELDS
    age = (now - dt.datetime.fromisoformat(meta["full_at"])).total_seconds() / 3600 if have else None
    stale = not have or full or age >= FULL_EVERY * 24 - FULL_SLACK_HOURS
    t0 = time.time()
    if stale:
        through = min(today, dt.date(year, 12, 31))
        parts = [{**query(year, taxa), "d1": a, "d2": b} for a, b in months(year, through)]
        with ThreadPoolExecutor(workers) as ex:
            got = list(ex.map(lambda p: stream(p, limiter, max_pages, getter, year), parts))
        df = pd.DataFrame([r for rows, _, _ in got for r in rows], columns=COLUMNS).drop_duplicates("id")
        pages, gone, kind = sum(p for *_, p in got), [g for _, gs, _ in got for g in gs], "full"
        meta = {"full_at": now.isoformat()}
    else:
        since = (dt.datetime.fromisoformat(meta["updated_since"]) - OVERLAP).isoformat(timespec="seconds")
        old = pd.read_parquet(f_rows)
        rows, gone, pages = stream({**changes(year, taxa), "updated_since": since}, limiter, max_pages, getter, year)
        df = merge(old, pd.DataFrame(rows, columns=COLUMNS), gone)
        kind = "incremental"
        prev = meta.get("photos")
        if prev and len(df) < (1 - MAX_DROP) * prev:
            raise SystemExit(f"iNat: the cached year shrank from {prev:,} to {len(df):,} photos (more than "
                             f"{MAX_DROP:.0%}); not trusting it. Rerun with --full.")
    df = df.astype({"id": "int64", "user": "int64", "taxon": "int64", "species": "int64", "lat": "float64",
                    "lng": "float64", "rank": "float64"})
    if max_pages is None:  # a capped dry run never becomes the cache the next run builds on
        tmp = f_rows.with_suffix(".tmp")
        df.to_parquet(tmp, index=False)
        tmp.replace(f_rows)
        f_meta.write_text(json.dumps({**meta, "updated_since": now.isoformat(), "columns": COLUMNS, "fields": FIELDS,
                                      "photos": len(df)}))
    stats = {"kind": kind, "pages": pages, "photos": len(df), "removed": len(gone), "seconds": round(time.time() - t0)}
    print(f"iNat: {kind} pull, {pages} pages in {stats['seconds']} s -> {len(df):,} photos cached"
          + (f" ({len(gone)} no longer qualify)" if kind == "incremental" else ""), flush=True)
    return df, stats


# ---------------------------------------------------------------- warmth
def load_static(cells):
    z = np.load(STATIC)
    if list(z["cells"]) != list(cells):
        raise SystemExit("weekly_static.npz was built for another cell list; rerun pipeline/atlas/weekly_static.py")
    return np.cumsum(z["inc"] / 100.0, 1), z["src"].astype(int)


def calendar_index(d: dt.date):
    """0-based day on the 365-day calendar the network's clock uses (a leap year's 31 Dec folds onto 30 Dec)."""
    return min(d.timetuple().tm_yday, 365) - 1


def observed(year, as_of, cells, src, fetch=None):
    """PRISM by weather day from 28 Feb to as_of for every cell (cells PRISM misses read their src cell's). ->
    (tmin, tmax) [cell, 365], NaN after the newest day every cell has, and that day."""
    from live.build_live import check_temps, fill_gaps
    from live.sources import prism_point
    fetch = fetch or prism_point
    start = dt.date(year, 2, 28)
    i0, i1 = calendar_index(start), calendar_index(as_of) + 1
    need = sorted(set(src.tolist()))
    ll = {i: h3.cell_to_latlng(cells[i]) for i in need}
    with ThreadPoolExecutor(6) as ex:
        got = dict(zip(need, ex.map(lambda i: fetch(*ll[i], start, as_of), need)))
    raw_min = np.array([got[s][0][:i1 - i0] for s in src], float)
    raw_max = np.array([got[s][1][:i1 - i0] for s in src], float)
    raw_min, raw_max = fill_gaps(raw_min), fill_gaps(raw_max)
    ok = ~(np.isnan(raw_min) | np.isnan(raw_max))
    good_days = np.where(ok.mean(0) >= 1 - MAX_BAD_CELLS)[0]
    if not len(good_days):
        return None, None, None
    k = int(good_days.max()) + 1                       # PRISM can post a day for some cells before others
    bad = ~ok[:, :k].all(1)
    for i in np.where(bad)[0]:                         # a rare cell with a hole borrows its nearest whole neighbour
        good = np.where(~bad)[0]
        j = good[np.argmin([h3.great_circle_distance(h3.cell_to_latlng(cells[i]), h3.cell_to_latlng(cells[g])) for g in good])]
        raw_min[i], raw_max[i] = raw_min[j], raw_max[j]
    tmin = np.full((len(cells), 365), np.nan)
    tmax = tmin.copy()
    tmin[:, i0:i0 + k], tmax[:, i0:i0 + k] = raw_min[:, :k], raw_max[:, :k]
    check_temps("PRISM", tmin[:, i0:i0 + k], tmax[:, i0:i0 + k])
    last = start + dt.timedelta(days=k - 1)
    return tmin, tmax, last


def forecast(cells, after, tmin, tmax, fetch=None):
    """The next days from Open-Meteo written in after `after` (in place). -> the last day written, or `after` if the
    forecast was unusable (the year then runs as typical from the day after). A forecast failure never fails the run."""
    from live.sources import open_meteo
    fetch = fetch or open_meteo
    lat, lng = np.array([h3.cell_to_latlng(c) for c in cells]).T
    a, b = after + dt.timedelta(days=1), after + dt.timedelta(days=FORECAST_DAYS)
    try:
        f_min, f_max = fetch(lat, lng, a, b)
    except Exception as e:  # noqa: BLE001
        print(f"  Open-Meteo failed ({e!r}); typical after the newest real day", flush=True)
        return after
    keep = ~(np.isnan(f_min).any(0) | np.isnan(f_max).any(0))
    n = int(np.argmin(keep)) if not keep.all() else len(keep)
    n = min(n, 365 - calendar_index(a))
    if n < MIN_FORECAST_DAYS or (np.nanmin(f_min[:, :n]) < -45 or np.nanmax(f_max[:, :n]) > 50):
        print(f"  Open-Meteo: only {n} usable days; typical after the newest real day", flush=True)
        return after
    i = calendar_index(a)
    tmin[:, i:i + n], tmax[:, i:i + n] = f_min[:, :n], f_max[:, :n]
    return after + dt.timedelta(days=n)


def days_ahead(clim, tmin, tmax):
    """[cell, 365] days ahead of the typical year (data.days_ahead, the network's clock) from this year's daily
    weather (NaN after the newest known day: real weather, then the forecast). After that day the year runs as a typical
    one (0), not as its newest day held all season: one warm March week must not slide the whole summer. (After
    midsummer the clock holds its own last value, as it did in training, data.HOLD_RATE.) Days before 28 February are
    never fetched: no warmth counts before 1 March, so they stand in as 0 °C."""
    tmin, tmax = tmin.copy(), tmax.copy()
    early = slice(0, START_DOY - 2)
    tmin[:, early] = np.nan_to_num(tmin[:, early])
    tmax[:, early] = np.nan_to_num(tmax[:, early])
    known = ~(np.isnan(tmin) | np.isnan(tmax)).any(0)
    n = int(np.argmin(known)) if not known.all() else 365
    dd = np.full(tmin.shape, np.nan)
    if n:
        dd[:, :n] = np.cumsum(daily_dd(np.nan_to_num(tmin[:, :n]), np.nan_to_num(tmax[:, :n])), 1)
    out = np.stack([D.days_ahead(clim[c].astype(np.float32), dd[c]) for c in range(len(clim))])
    return np.where(np.isfinite(out), out, 0.0)


def quarter_days(a):
    return np.clip(np.round(a * 4), -127, 127).astype(np.int8)


# ---------------------------------------------------------------- photos -> expected vs seen
def row_taxa(species):
    """{iNaturalist taxon id: species.json row} for labelling photos: each row's taxon, and every species in its "taxa"
    when GBIF's one species is several of iNaturalist's (reconcile.py: the Eyed and the Appalachian Brown)."""
    out = {}
    for i, s in enumerate(species):
        for t in [s.get("taxon"), *s.get("taxa", [])]:
            if t:
                out[int(t)] = i
    return out


def label_photos(df, year, last_day, species, cells):
    """Cached rows -> the photos seen.py counts: this year's, through `last_day`, inside a map cell, one per observer x
    taxon x cell x day (data.load_records' burst filter). Adds doy, ci (cell index) and label (species index; the last,
    len(species), is "other")."""
    if not len(df):
        return df.assign(doy=[], ci=[], label=[])
    day = pd.to_datetime(df.day, errors="coerce")
    df = df[day.notna() & (day.dt.year == year)].copy()
    day = day[day.notna() & (day.dt.year == year)]
    df["doy"] = np.minimum(day.dt.dayofyear.to_numpy(), 365)  # as data.py: the 365-day calendar
    df = df[(df.doy <= last_day) & df.lat.between(BOX["s"], BOX["n"]) & df.lng.between(BOX["w"], BOX["e"])]
    at = {c: i for i, c in enumerate(cells)}
    df["ci"] = [at.get(h3.latlng_to_cell(a, b, WARMTH_RES), -1) for a, b in zip(df.lat.to_numpy(), df.lng.to_numpy())]
    df = df[df.ci >= 0]
    taxa = row_taxa(species)
    sp = df.species.to_numpy()
    own = df.taxon.map(taxa)
    # A photo of a taxon with a row of its own (a subspecies GBIF keeps as a species: the Red-spotted Purple) goes to
    # that row, as GBIF files it; any other photo named to a species goes to its species' row.
    df["label"] = np.where(sp > 0, own.fillna(pd.Series(sp, index=df.index).map(taxa)).fillna(len(species)),
                           len(species)).astype(int)
    # the burst filter's key: the species if named to one, else whatever it was named to (data.py: genus, family, ...)
    df["key"] = np.where(sp > 0, sp, -df.taxon.to_numpy())
    df = df.sort_values("id", kind="stable").drop_duplicates(["user", "key", "ci", "doy"]).drop(columns="key")
    return df.reset_index(drop=True)


def expected_seen(net, photos, ahead, cells_dd, cell_ll, batch=8192):
    """[n_out, 365] photos seen, and expected: every photo's shares added to its own day (seen.py main)."""
    n_out = net.n_out
    seen = np.zeros((n_out, 365))
    np.add.at(seen, (photos.label.to_numpy(), photos.doy.to_numpy() - 1), 1)
    expected = np.zeros((n_out, 365))
    p = photos.sort_values("doy", kind="stable")
    ci, doy = p.ci.to_numpy(), p.doy.to_numpy()
    place = net.place_features(p.lat.to_numpy(), p.lng.to_numpy(), cells_dd[ci])
    delta = ahead[ci, doy - 1]
    for a in range(0, len(p), batch):
        sl = slice(a, a + batch)
        s = net.shares(place[sl], doy[sl], delta[sl]).astype(np.float64)
        d = doy[sl]
        starts = np.r_[0, np.where(np.diff(d))[0] + 1]
        expected[:, d[starts] - 1] += np.add.reduceat(s, starts, 0).T
    return seen, expected


def judge_all(seen, expected):
    """seen.py's verdict for every species: [seen, expected, ratio or None, days or None]."""
    ok = expected.sum(1) >= 5
    phi = SEEN.dispersion(seen.sum(1), expected.sum(1)) if ok.any() else 1.0
    timed = seen.sum(1) >= SEEN.MIN_TIMING
    phi_t = SEEN.timing_dispersion(seen, expected) if timed.any() else 1.0
    rows = []
    for s in range(len(seen)):
        ratio, shift = SEEN.judge(seen[s], expected[s], phi, phi_t)
        rows.append([int(seen[s].sum()), round(float(expected[s].sum()), 1), ratio, shift])
    return rows, phi, phi_t


def seen_bin(seen, expected, last_day):
    o, e = SEEN.ribbon(seen, last_day), SEEN.ribbon(expected, last_day)
    top = np.maximum(o.max(1), e.max(1))[:, None]
    scaled = np.stack([e, o], 1) / np.where(top > 0, top, 1)[:, None]
    return np.round(255 * scaled).astype(np.uint8)


def season_bin(net, cell_ll, cells_dd, ahead_q, volume):
    """export.py's season.bin on the numpy network: each species' mean share over the cells every STEP days, in a
    typical year and in this one (its quarter-day ahead, as the app reads it), times the day's usual photo volume,
    scaled to the species' own top over both."""
    days = np.arange(SEASON[0], SEASON[1] + 1, STEP)
    place = net.place_features(cell_ll[:, 0], cell_ll[:, 1], cells_dd)
    n = len(cell_ll)
    mean = np.zeros((net.n_out, 2, len(days)), np.float32)
    for k, d in enumerate(days):
        both = net.shares(np.concatenate([place, place]), np.full(2 * n, float(d)),
                          np.r_[np.zeros(n, np.float32), ahead_q[:, d - 1] / 4.0])
        mean[:, 0, k], mean[:, 1, k] = both[:n].mean(0), both[n:].mean(0)
    vol = np.asarray(volume, np.float32)[(days - SEASON[0]) // C.STEP]  # season.json: one per config.STEP
    mean = mean * vol[None, None, :]
    scale = mean.max((1, 2), keepdims=True)
    return np.round(255 * mean / np.where(scale > 0, scale, 1)).astype(np.uint8)


def in_states(lat, lng):
    """True inside the seven states the map shows (dots.py's STATES), by the same outlines the fits use."""
    from fit import data as fdata
    pts = np.column_stack([np.asarray(lng, float), np.asarray(lat, float)])
    inside = np.zeros(len(pts), bool)
    for paths in fdata._state_paths().values():
        for p in paths:
            inside |= p.contains_points(pts)
    return inside


def year_dots(photos, year, n_files):
    """{i: bytes}: each species' photos of this year alone, in dots.py's format (at most CAP, a fixed-seed sample, the
    seven states only). Only these go in the release: at deploy, scripts/atlas-overlay.mjs swaps them into main's own
    dots/<i>.bin in place of that year's rows, so the release never brings back older years' dots."""
    p = photos[photos.label < n_files - 1]
    p = p[in_states(p.lat.to_numpy(), p.lng.to_numpy())]
    by = {i: g for i, g in p.groupby("label")}
    out = {}
    for i in range(n_files):
        g = by.get(i)
        if g is None:
            out[i] = b""
            continue
        g = g.sample(DOTS.CAP, random_state=i) if len(g) > DOTS.CAP else g
        out[i] = DOTS.pack(pd.DataFrame({"inat_id": g.id.to_numpy(), "doy": g.doy.to_numpy(), "lat": g.lat.to_numpy(),
                                         "lng": g.lng.to_numpy(), "year": year}))
    return out


def species_hash(names):
    """FNV-1a (32 bit) of the species names joined by newlines, as the app hashes them (atlas.ts spread)."""
    h = 0x811C9DC5
    for unit in np.frombuffer("\n".join(names).encode("utf-16-le"), "<u2").tolist():  # JS charCodeAt: UTF-16 units
        h = ((h ^ unit) * 0x01000193) & 0xFFFFFFFF
    return h


# ---------------------------------------------------------------- the run
def flips(year):
    """The first day `year` may take over the site (FLIP)."""
    return dt.date(year, *FLIP)


def default_year(today):
    """The year a scheduled run rebuilds: this one from FLIP (15 April) on, else last year, whose late identifications
    keep coming in through the winter and spring (so until mid-April the site refines the year it already shows; the
    new year takes over from FLIP once it has MIN_PHOTOS photos)."""
    return today.year if today >= flips(today.year) else today.year - 1


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(year, today, out, cache_dir=CACHE, taxa=None, full=False, max_pages=None, use_forecast=True, dots=True,
          workers=WORKERS, weather=None, photos=None, atlas=OUT, now=None):
    """Everything for `year` into `out`. -> summary dict, or None when there is nothing to publish yet. A run limited
    in any way (a few taxa, capped pages, no dots) is marked dry_run in year.json, and the overlay never publishes it."""
    t0 = time.time()
    now = now or dt.datetime.now(dt.timezone.utc)
    atlas = Path(atlas)
    species = json.loads((atlas / "species.json").read_text())
    cells_rows = json.loads((atlas / "cells.json").read_text())
    cells = [c["h"] for c in cells_rows]
    cells_dd = np.array([c["dd"] for c in cells_rows], np.float32)
    cell_ll = np.array([h3.cell_to_latlng(c) for c in cells])
    dry = bool(taxa or max_pages or not dots)
    if year > today.year or today < dt.date(year, 3, 1) + dt.timedelta(days=PRISM_LAG_DAYS):
        print(f"{year}: no data yet ({today}); nothing written, the site keeps its last year.")
        return None
    if today < flips(year) and not dry:
        print(f"{year}: too early in the season ({today}; it takes over from {flips(year)}); nothing written.")
        return None

    # 1. warmth
    clim, src = load_static(cells)
    if weather is None:
        from live.build_live import last_prism_day
        as_of = min(last_prism_day(today), dt.date(year, 12, 31))
        tmin, tmax, as_of = observed(year, as_of, cells, src)
    else:
        tmin, tmax, as_of = weather(year, cells, src)
    if as_of is None or as_of < dt.date(year, 3, 1):
        print(f"{year}: no warmth since 1 March yet; nothing written.")
        return None
    through = as_of
    if use_forecast and as_of >= today - dt.timedelta(days=PRISM_LAG_DAYS + 3) and calendar_index(as_of) < 364:
        through = forecast(cells, as_of, tmin, tmax)
    ahead = days_ahead(clim, tmin, tmax)
    ahead_q = quarter_days(ahead)
    t_weather = time.time() - t0
    print(f"warmth: PRISM through {as_of}, forecast through {through}; median days ahead on {as_of}: "
          f"{np.median(ahead[:, calendar_index(as_of)]):+.1f} ({t_weather:.0f} s)", flush=True)

    # 2. photos
    if photos is None:
        photos, pull = update_photos(year, min(today, dt.date(year, 12, 31)), cache_dir, taxa, full, max_pages, workers,
                                     now=now)
    else:
        pull = {"kind": "given", "pages": 0, "photos": len(photos), "removed": 0, "seconds": 0}
    last_day = calendar_index(as_of) + 1
    p = label_photos(photos, year, last_day, species[:-1], cells)
    if not len(p):
        print(f"{year}: no photos yet; nothing written.")
        return None
    last_day = min(last_day, int(p.doy.max()))
    p = p[p.doy <= last_day]
    if len(p) < MIN_PHOTOS and not dry:
        print(f"{year}: only {len(p)} photos so far (fewer than {MIN_PHOTOS}); nothing written, the site keeps its last year.")
        return None

    # 3. expected vs seen
    t1 = time.time()
    net = NumpyAtlas(atlas)
    assert net.n_out == len(species), "species.json and model.json disagree"
    seen, expected = expected_seen(net, p, ahead, cells_dd, cell_ll)
    rows, phi, phi_t = judge_all(seen, expected)
    names = [s["name"] for s in species[:-1]]
    picks = SEEN.surprises(rows[:-1], skip=SEEN.periodicals(names) | SEEN.unlisted(species[:-1]))
    t_net = time.time() - t1
    print(f"network: {len(p):,} photos through day {last_day} in {t_net:.0f} s; dispersion counts {phi:.1f}, "
          f"timing {phi_t:.1f}; {sum(r[2] is not None for r in rows)} species off in numbers, "
          f"{sum(r[3] is not None for r in rows)} in timing", flush=True)

    # 4. files
    t2 = time.time()
    vol = json.loads((atlas / "season.json").read_text())["volume"]
    season = season_bin(net, cell_ll, cells_dd, ahead_q, vol)
    dot_files = year_dots(p, year, len(species)) if dots else {}
    t_files = time.time() - t2
    so_far = year >= today.year
    head = {"year": year, "last_day": last_day, "photos": len(p), "so_far": so_far}
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    ahead_q.tofile(out / f"ahead-{year}.bin")
    seen_bin(seen, expected, last_day).tofile(out / f"seen-{year}.bin")
    (out / f"seen-{year}.json").write_text(json.dumps({**head, "species": rows, "surprises": picks}, separators=(",", ":")))
    season.tofile(out / "season.bin")
    if dot_files:
        (out / "dots-year").mkdir(exist_ok=True)
        for i, b in dot_files.items():
            (out / "dots-year" / f"{i}.bin").write_bytes(b)
    files = sorted(str(f.relative_to(out)) for f in out.rglob("*") if f.is_file())
    summary = {
        **head, "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        # real warmth through weather_through, the forecast through warm_through (day of year); typical after that
        "weather_through": as_of.isoformat(), "forecast_through": through.isoformat() if through > as_of else None,
        "warm_through": calendar_index(through) + 1,
        "species": len(names), "species_hash": species_hash(names),
        "model": sha(atlas / "model.bin")[:12], "cells": sha(atlas / "cells.json")[:12],
        "dry_run": dry, **({"subset": list(taxa)} if taxa else {}),
        "files": {f: sha(out / f) for f in files},
        "sources": {"photos": "iNaturalist research grade, CC0 / CC BY / CC BY-NC (observation and photo)",
                    "warmth": "PRISM daily via RCC-ACIS; Open-Meteo forecast (CC BY 4.0)"},
        "checks": {"pull": pull, "cached_photos": len(photos), "seconds": {"weather": round(t_weather), "network": round(t_net),
                                                                         "files": round(t_files), "total": round(time.time() - t0)}},
    }
    (out / "year.json").write_text(json.dumps(summary, indent=1))
    print(f"wrote {out}: {json.dumps(summary['checks'])}")
    for i in picks:
        print(f"  surprise: {names[i]} {rows[i]}")
    return summary


def compare(out, ref, year):
    """Print how close a rebuild is to shipped files of the same year (the dry run's proof)."""
    out, ref = Path(out), Path(ref)
    msg = []
    if (ref / f"ahead-{year}.bin").exists():
        a = np.fromfile(out / f"ahead-{year}.bin", np.int8).reshape(-1, 365) / 4
        b = np.fromfile(ref / f"ahead-{year}.bin", np.int8).reshape(-1, 365) / 4
        d = np.abs(a - b)[:, SEASON[0] - 1:SEASON[1]]
        msg.append(f"ahead-{year}: |rebuilt - shipped| median {np.median(d):.2f} d, 95th pct {np.percentile(d, 95):.2f} d, "
                   f"median signed {np.median((a - b)[:, SEASON[0] - 1:SEASON[1]]):+.2f} d")
    s1 = np.fromfile(out / "season.bin", np.uint8).astype(int)
    s0 = np.fromfile(ref / "season.bin", np.uint8).astype(int)
    if len(s1) == len(s0):
        d = np.abs(s1 - s0).reshape(-1, 2, s1.size // len(json.loads((ref / 'species.json').read_text())) // 2)
        msg.append(f"season.bin: typical half |diff| max {d[:, 0].max()}, mean {d[:, 0].mean():.2f}; year half mean "
                   f"{d[:, 1].mean():.2f}, 99th pct {np.percentile(d[:, 1], 99):.0f} (of 255)")
    if (ref / f"seen-{year}.json").exists():
        n = json.loads((out / f"seen-{year}.json").read_text())
        o = json.loads((ref / f"seen-{year}.json").read_text())
        a = np.array([r[0] for r in n["species"]], float)
        b = np.array([r[0] for r in o["species"]], float)
        ea = np.array([r[1] for r in n["species"]], float)
        eb = np.array([r[1] for r in o["species"]], float)
        ok = (b >= 20) & (a >= 20)
        msg.append(f"seen-{year}: {n['photos']:,} photos through day {n['last_day']} (shipped {o['photos']:,} through "
                   f"{o['last_day']}); per-species seen correlation {np.corrcoef(np.log(a[ok]), np.log(b[ok]))[0, 1]:.3f}, "
                   f"expected {np.corrcoef(np.log(ea[ok] + 1), np.log(eb[ok] + 1))[0, 1]:.3f}; surprises shared "
                   f"{len(set(n['surprises']) & set(o['surprises']))}/{len(o['surprises'])}")
    for m in msg:
        print("compare:", m)
    return msg


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, required=True, help="folder for the files (only written when there is a year to show)")
    ap.add_argument("--year", type=int, help="default: this year from 15 April, last year before (default_year)")
    ap.add_argument("--cache", type=Path, default=CACHE, help="iNaturalist cache folder, kept between runs")
    ap.add_argument("--full", action="store_true", help="pull the whole year again, not just what changed")
    ap.add_argument("--no-forecast", action="store_true")
    ap.add_argument("--no-dots", action="store_true", help="skip the dots files (dry runs)")
    ap.add_argument("--taxa", type=int, nargs="+", help="dry run: only these iNaturalist taxa (never published)")
    ap.add_argument("--max-pages", type=int, help="dry run: at most this many pages per stream (not cached)")
    ap.add_argument("--workers", type=int, default=WORKERS)
    ap.add_argument("--compare", type=Path, help="print how the rebuild compares with these files of the same year")
    a = ap.parse_args(argv)
    today = dt.datetime.now(dt.timezone.utc).date()
    year = a.year or default_year(today)
    if not 2026 <= year <= today.year:
        raise SystemExit(f"--year {year}: must be 2026 or later, and not in the future")
    tmp = a.out.with_name(a.out.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    now = dt.datetime.now(dt.timezone.utc)  # the run's start: the next updated_since, and the full pull's clock
    res = build(year, now.date(), tmp, a.cache, a.taxa, a.full, a.max_pages, not a.no_forecast, not a.no_dots, a.workers,
                now=now)
    if res is None:
        return 0
    shutil.rmtree(a.out, ignore_errors=True)
    tmp.replace(a.out)  # all or nothing: a failed run never leaves half a year
    if a.compare:
        compare(a.out, a.compare, year)
    return 0


if __name__ == "__main__":
    sys.exit(main())
