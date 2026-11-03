"""No-network checks for the weekly Atlas rebuild (weekly.py): the numpy network, the polite iNaturalist client and
its cache, the warmth clock, and a whole small run end to end on fixtures. No torch needed."""
import datetime as dt
import io
import json
import shutil
import struct
import subprocess
import urllib.error
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pipeline.atlas import dots as DOTS
from pipeline.atlas import weekly as W
from pipeline.atlas.config import OUT
from pipeline.atlas.net_reference import FIXTURE, NumpyAtlas

ROOT = Path(__file__).resolve().parents[2]
SPECIES = json.loads((OUT / "species.json").read_text())
CELLS = json.loads((OUT / "cells.json").read_text())


@pytest.fixture(scope="module")
def net():
    return NumpyAtlas()


# ---------------------------------------------------------------- the network
def test_numpy_network_matches_torch(net):
    """The same log-shares torch gave for the fixture's places (scripts/atlas-net.fixture.json, as the browser checks)."""
    cases = json.loads(FIXTURE.read_text())
    place = net.place_features([c["lat"] for c in cases], [c["lng"] for c in cases], [c["dd"] for c in cases])
    lp = net.log_shares(place, [c["day"] for c in cases], [c["ahead"] for c in cases])
    gap = max(abs(lp[k][i] - want) for k, c in enumerate(cases) for i, want in c["top"])
    assert gap < 1e-4
    assert all(int(np.argmax(lp[k])) == c["top"][0][0] for k, c in enumerate(cases))
    assert np.allclose(np.exp(lp).sum(1), 1, atol=1e-6)


def test_place_features_match_the_model():
    torch = pytest.importorskip("torch")  # noqa: F841 -- model.py needs it; CI has it, a lean install skips this
    from pipeline.atlas import model as M
    lat, lng, dd = np.array([37.0, 44.5, 49.0]), np.array([-96.0, -89.5, -81.0]), np.array([400.0, 600.0, 900.0])
    assert np.allclose(NumpyAtlas().place_features(lat, lng, dd), M.place_features(lat, lng, dd), atol=1e-6)


# ---------------------------------------------------------------- iNaturalist, politely
class Clock:
    def __init__(self):
        self.t, self.slept = 0.0, []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(round(s, 3))
        self.t += s


def test_limiter_spaces_requests_and_pauses_everyone():
    c = Clock()
    lim = W.Limiter(1.0, clock=c, sleep=c.sleep)
    for _ in range(3):
        lim.wait()
    assert c.slept == [1.0, 1.0]           # the first goes at once, then one a second
    lim.pause(30)
    lim.wait()
    assert c.slept[-1] == pytest.approx(31, abs=1)


def test_a_pause_cancels_slots_already_promised():
    """A thread promised the next slot before a 429 must not go at that slot: it asks again, after the pause."""
    c = Clock()
    lim = W.Limiter(1.0, clock=c, sleep=None)
    lim.wait()                                       # t=0: someone goes
    starts = []

    def sleep(s):                                    # while this thread sleeps toward its slot, another thread hits a 429
        if not starts:
            lim.pause(60)
        starts.append(s)
        c.t += s
    lim.sleep = sleep
    lim.wait()
    assert c.t >= 60                                 # it went only after the pause, not at t=1


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_get_backs_off_on_429_then_succeeds():
    c = Clock()
    lim = W.Limiter(1.0, clock=c, sleep=c.sleep)
    calls = []

    def opener(req, timeout):
        calls.append(req.full_url)
        if len(calls) < 3:
            raise urllib.error.HTTPError(req.full_url, 429, "slow down", {"Retry-After": "7"}, None)
        return Reply(json.dumps({"results": [{"id": 1}]}).encode())

    assert W.get({"a": 1}, lim, opener=opener, sleep=c.sleep) == {"results": [{"id": 1}]}
    assert len(calls) == 3 and c.t >= 14                # it waited as asked, twice, every thread with it


def test_get_gives_up_on_a_plain_error():
    def opener(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 422, "bad", {}, None)
    with pytest.raises(urllib.error.HTTPError):
        W.get({}, W.Limiter(0), opener=opener)


def obs(i, day="2026-06-01", lat=41.9, lng=-88.0, user=1, taxon=48662, rank=10, sp=None, grade="research",
        lic="cc-by", photo="cc-by-nc", where=True):
    return {"id": i, "observed_on": day, "location": f"{lat},{lng}" if where else None, "user": {"id": user},
            "quality_grade": grade, "license_code": lic, "photos": [{"license_code": photo}] if photo else [],
            "taxon": {"id": taxon, "rank_level": rank, "min_species_taxon_id": sp or taxon}}


def test_rows_of_names_the_species_and_sorts_out_the_unusable():
    rows, gone = W.rows_of([obs(1), obs(2, taxon=999, rank=5, sp=48662), obs(3, taxon=47224, rank=20),
                            obs(4, day=None), obs(5, grade="needs_id"), obs(6, lic=None), obs(7, lic="cc-by-sa"),
                            obs(8, photo="cc-by-nd"), obs(9, photo=None), obs(10, where=False),
                            obs(11, day="2025-12-31"), obs(12, lic="CC-BY")], year=2026)
    assert [r[0] for r in rows] == [1, 2, 3, 12]
    assert rows[1][7] == 48662                 # a subspecies counts as its species
    assert rows[2][7] == 0                     # named only to genus: no species
    assert gone == [4, 5, 6, 7, 8, 9, 10, 11]  # not research grade, all rights reserved, no open photo, private, ...


def pager(pages_by_query, log=None, total=None):
    """A fake getter serving fixed observations per query (keyed by d1 / updated_since / quality_grade), by id_above,
    with total_results counted from id_above 0 as iNaturalist does (or `total` to fake a lie)."""
    def getter(params, limiter):
        if log is not None:
            log.append(dict(params))
        key = (params.get("d1"), params.get("updated_since"), params.get("quality_grade"))
        data = sorted(pages_by_query.get(key, []), key=lambda o: o["id"])
        res = [o for o in data if o["id"] > params["id_above"]][:params["per_page"]]
        return {"total_results": len(data) if total is None else total, "results": res}
    return getter


def test_stream_pages_by_id_until_an_empty_page():
    data = {("2026-01-01", None, "research"): [obs(i) for i in range(1, 451)]}
    rows, gone, pages = W.stream(W.query(2026), W.Limiter(0), getter=pager(data))
    assert len(rows) == 450 and pages == 4 and rows[-1][0] == 450 and not gone
    rows, gone, pages = W.stream(W.query(2026), W.Limiter(0), max_pages=1, getter=pager(data))
    assert len(rows) == 200 and pages == 1


def test_a_short_page_does_not_end_the_stream():
    """A page shorter than asked for (the server's choice) is followed up; only an empty page ends it."""
    data = [obs(i) for i in range(1, 301)]

    def getter(params, limiter):
        res = [o for o in data if o["id"] > params["id_above"]][:150]      # never a full 200
        return {"total_results": 300, "results": res}
    rows, _, pages = W.stream(W.query(2026), W.Limiter(0), getter=getter)
    assert len(rows) == 300 and pages == 3


def test_a_stream_that_comes_up_short_fails():
    data = {("2026-01-01", None, "research"): [obs(i) for i in range(1, 101)]}
    log = []
    with pytest.raises(W.Incomplete):
        W.stream(W.query(2026), W.Limiter(0), getter=pager(data, log, total=200))
    assert [p["id_above"] for p in log] == [0, 100, 0, 100]       # tried twice from the start, then failed


def test_a_stream_short_once_is_tried_again():
    data = [obs(i) for i in range(1, 101)]
    calls = []

    def getter(params, limiter):
        calls.append(params["id_above"])
        lie = len(calls) <= 2                                       # the first try's count is off; the second's is not
        return {"total_results": 200 if lie else 100, "results": [o for o in data if o["id"] > params["id_above"]][:200]}
    rows, _, _ = W.stream(W.query(2026), W.Limiter(0), getter=getter)
    assert len(rows) == 100 and calls == [0, 100, 0, 100]


def test_months_split_the_year_to_date():
    assert W.months(2027, dt.date(2027, 3, 10)) == [("2027-01-01", "2027-01-31"), ("2027-02-01", "2027-02-28"),
                                                    ("2027-03-01", "2027-03-10")]


def test_cache_full_then_incremental_then_full_again(tmp_path):
    now = dt.datetime(2026, 7, 6, 15, tzinfo=dt.timezone.utc)
    full = {(f"2026-{m:02d}-01", None, "research"): [] for m in range(1, 8)}
    full[("2026-06-01", None, "research")] = [obs(1), obs(2), obs(3, day="2026-06-20"), obs(6), obs(7), obs(8), obs(9)]
    full[("2026-06-01", None, "research")] += [obs(i) for i in range(20, 40)]   # enough that losing 4 is no shrink
    full[("2026-07-01", None, "research")] = [obs(4, day="2026-07-02")]
    log = []
    df, st = W.update_photos(2026, dt.date(2026, 7, 6), tmp_path, getter=pager(full, log), limiter=W.Limiter(0), now=now)
    assert st["kind"] == "full" and sorted(df.id) == [1, 2, 3, 4, 6, 7, 8, 9, *range(20, 40)]
    assert {p["d1"] for p in log} == {f"2026-{m:02d}-01" for m in range(1, 8)}      # one stream a month, to date
    assert all(p["license"] == p["photo_license"] == "cc0,cc-by,cc-by-nc" for p in log)

    later = now + dt.timedelta(days=7)
    since = (now - W.OVERLAP).isoformat(timespec="seconds")
    log = []
    # one query of everything that changed, whatever its grade or licence now: rows_of sorts it out
    inc = {("2026-01-01", since, None): [obs(2, taxon=67760), obs(5, day="2026-07-10"), obs(3, grade="needs_id"),
                                         obs(6, lic="cc-by-nd"), obs(7, photo="cc-by-sa"), obs(8, where=False)]}
    df, st = W.update_photos(2026, dt.date(2026, 7, 13), tmp_path, getter=pager(inc, log), limiter=W.Limiter(0), now=later)
    assert st["kind"] == "incremental" and st["removed"] == 4
    assert "license" not in log[0] and "photo_license" not in log[0] and "quality_grade" not in log[0]
    assert sorted(df.id) == [1, 2, 4, 5, 9, *range(20, 40)]               # 3 lost research grade, 6-8 licence or privacy; 5 is new
    assert int(df.set_index("id").taxon[2]) == 67760         # 2's identification changed

    # two weeks on (a few hours early by the clock still counts), the whole year again: deletions only leave this way
    df, st = W.update_photos(2026, dt.date(2026, 7, 20), tmp_path, getter=pager(full), limiter=W.Limiter(0),
                             now=now + dt.timedelta(days=W.FULL_EVERY, hours=-6))
    assert st["kind"] == "full"


def test_a_shrinking_year_is_not_trusted(tmp_path):
    now = dt.datetime(2026, 7, 6, 15, tzinfo=dt.timezone.utc)
    full = {("2026-06-01", None, "research"): [obs(i) for i in range(1, 11)]}
    W.update_photos(2026, dt.date(2026, 6, 30), tmp_path, getter=pager(full), limiter=W.Limiter(0), now=now)
    since = (now - W.OVERLAP).isoformat(timespec="seconds")
    inc = {("2026-01-01", since, None): [obs(i, grade="casual") for i in range(1, 4)]}
    with pytest.raises(SystemExit, match="shrank"):
        W.update_photos(2026, dt.date(2026, 7, 13), tmp_path, getter=pager(inc), limiter=W.Limiter(0),
                        now=now + dt.timedelta(days=7))


def test_a_capped_dry_run_never_becomes_the_cache(tmp_path):
    full = {("2026-01-01", None, "research"): [obs(i, day="2026-01-05") for i in range(1, 300)]}
    W.update_photos(2026, dt.date(2026, 1, 31), tmp_path, getter=pager(full), limiter=W.Limiter(0), max_pages=1)
    assert not list(tmp_path.glob("obs-*"))


# ---------------------------------------------------------------- warmth
def test_days_ahead_reads_an_early_spring_then_runs_typical():
    days = np.arange(365)
    t = 10 + 15 * np.sin((days - 105) / 365 * 2 * np.pi)
    tmin, tmax = np.tile(t - 6, (2, 1)), np.tile(t + 6, (2, 1))
    clim = np.cumsum(W.daily_dd(tmin, tmax), 1)
    warm_min, warm_max = tmin + [[0], [3]], tmax + [[0], [3]]
    warm_min[:, 150:] = np.nan
    warm_max[:, 150:] = np.nan
    a = W.days_ahead(clim, warm_min, warm_max)
    assert np.allclose(a[0, 60:149], 0, atol=0.3)            # the typical year runs on time
    assert (a[1, 100:150] > 2).all()                          # 3 °C warmer runs days ahead
    assert (a[:, :59] == 0).all()                             # nothing before 1 March
    assert (a[1, 150:] == 0).all()                            # after the newest day (index 149): a typical year, not held
    q = W.quarter_days(a)
    assert q.dtype == np.int8 and np.allclose(q / 4, np.clip(a, -31.75, 31.75), atol=0.13)


def test_days_ahead_ignores_the_unfetched_winter():
    """observed() fetches from 28 February only: the NaN January must not blank the whole year (it once did)."""
    days = np.arange(365)
    t = 10 + 15 * np.sin((days - 105) / 365 * 2 * np.pi)
    tmin, tmax = np.tile(t - 6, (1, 1)), np.tile(t + 6, (1, 1))
    clim = np.cumsum(W.daily_dd(tmin, tmax), 1)
    wmin, wmax = tmin + 3, tmax + 3
    wmin[:, :58], wmax[:, :58] = np.nan, np.nan
    wmin[:, 200:], wmax[:, 200:] = np.nan, np.nan
    a = W.days_ahead(clim, wmin, wmax)
    assert (a[0, 100:200] > 2).all()


def test_default_year_waits_for_mid_april():
    assert W.default_year(dt.date(2027, 2, 20)) == 2026
    assert W.default_year(dt.date(2027, 4, 14)) == 2026       # 2026 had 3.3k photos by 1 March: too soon to say
    assert W.default_year(dt.date(2027, 4, 15)) == 2027


def test_static_matches_the_cell_list():
    clim, src = W.load_static([c["h"] for c in CELLS])
    assert clim.shape == (len(CELLS), 365) and (np.diff(clim, axis=1) >= 0).all()
    assert (clim[:, :58] == 0).all() and clim[:, 180].min() > 100
    assert ((src >= 0) & (src < len(CELLS))).all()
    # PRISM's typical warmth by 30 June sits close to the network's own (Daymet) place input
    gap = clim[:, 180] - np.array([c["dd"] for c in CELLS])
    assert abs(np.median(gap)) < 60


# ---------------------------------------------------------------- photos -> files
def photo_rows(n=2400, seed=0, year=2026):
    """Cached rows as update_photos keeps them: a few known species and other insects around Illinois, some bursts."""
    rng = np.random.default_rng(seed)
    taxa = [SPECIES[i]["taxon"] for i in (0, 22, 60, 155, 177)] + [47224, 52381]  # + a genus and a family
    t = rng.choice(taxa, n)
    day = pd.to_datetime(f"{year}-01-01") + pd.to_timedelta(rng.integers(120, 240, n), "D")
    df = pd.DataFrame({"id": np.arange(1, n + 1), "day": day.strftime("%Y-%m-%d"), "lat": rng.uniform(38, 44, n),
                       "lng": rng.uniform(-91, -86, n), "user": rng.integers(1, 300, n), "taxon": t,
                       "rank": np.where(np.isin(t, [47224, 52381]), 20.0, 10.0),
                       "species": np.where(np.isin(t, [47224, 52381]), 0, t)})
    burst = df.iloc[:50].assign(id=lambda d: d.id + 100_000)                     # the same observer again that day
    off = df.iloc[:5].assign(id=lambda d: d.id + 200_000, lat=20.0)              # outside the box
    return pd.concat([df, burst, off], ignore_index=True)


def test_label_photos_filters_bursts_and_labels():
    p = W.label_photos(photo_rows(), 2026, 300, SPECIES[:-1], [c["h"] for c in CELLS])
    assert len(p) == 2400                                     # the burst copies and the photos off the map are gone
    assert set(p.label) <= {0, 22, 60, 155, 177, len(SPECIES) - 1}
    assert (p.label == len(SPECIES) - 1).sum() > 500          # named only to genus or family: "other"
    early = W.label_photos(photo_rows(), 2026, 150, SPECIES[:-1], [c["h"] for c in CELLS])
    assert early.doy.max() <= 150


def fake_weather(as_of):
    def weather(year, cells, src):
        days = np.arange(365)
        t = 10 + 15 * np.sin((days - 105) / 365 * 2 * np.pi) + 1.0
        tmin, tmax = np.tile(t - 6, (len(cells), 1)), np.tile(t + 6, (len(cells), 1))
        k = W.calendar_index(as_of) + 1
        tmin[:, k:], tmax[:, k:] = np.nan, np.nan
        return tmin, tmax, as_of
    return weather


@pytest.fixture(scope="module")
def run_2026(tmp_path_factory):
    """One whole run on fixtures (season.bin at 7 steps, not 62: the same code, a tenth of the network runs)."""
    out = tmp_path_factory.mktemp("run") / "atlas"
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(W, "STEP", 40)
        mp.setattr(W, "MIN_PHOTOS", 500)
        res = W.build(2026, dt.date(2026, 9, 1), out, weather=fake_weather(dt.date(2026, 6, 28)), photos=photo_rows(),
                      use_forecast=False)
    return res, out


def test_a_whole_run_on_fixtures(run_2026):
    res, out = run_2026
    assert res["year"] == 2026 and res["so_far"] and not res["dry_run"]
    assert res["weather_through"] == "2026-06-28" and res["warm_through"] == 179 and res["last_day"] == 179
    n, steps = len(SPECIES), (304 - 60) // 4 + 1
    a = np.fromfile(out / "ahead-2026.bin", np.int8).reshape(len(CELLS), 365)
    assert (a[:, 179:] == 0).all() and (a[:, 120:179] != 0).any()     # real warmth to 28 June, then a typical year
    assert (out / "seen-2026.bin").stat().st_size == n * 2 * steps
    assert (out / "season.bin").stat().st_size == n * 2 * 7
    f = json.loads((out / "seen-2026.json").read_text())
    assert f["so_far"] is True and f["photos"] == res["photos"] and len(f["species"]) == n
    assert sum(r[0] for r in f["species"]) == res["photos"]
    assert sum(r[1] for r in f["species"]) == pytest.approx(res["photos"], rel=0.01)   # each photo's shares add to one
    y = json.loads((out / "year.json").read_text())
    head = struct.unpack("<4sII", (OUT / "spread.bin").read_bytes()[:12])
    assert (y["species"], y["species_hash"]) == (head[1], head[2])            # the same hash the app checks
    on_disk = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file() and p.name != "year.json")
    assert sorted(y["files"]) == on_disk and len(on_disk) == 4 + n            # the manifest lists every file
    assert not (out / "dots").exists() and (out / "dots-year" / "0.bin").exists()


def test_nothing_too_early_or_with_too_few_photos(tmp_path):
    out = tmp_path / "atlas"
    assert W.build(2027, dt.date(2027, 2, 10), out, weather=fake_weather(dt.date(2027, 2, 7)), photos=photo_rows()) is None
    # mid-April is the earliest a new year takes over, however many photos it has
    assert W.build(2026, dt.date(2026, 4, 10), out, weather=fake_weather(dt.date(2026, 4, 7)), photos=photo_rows()) is None
    assert W.build(2026, dt.date(2026, 6, 1), out, weather=fake_weather(dt.date(2026, 5, 28)),
                   photos=photo_rows(n=300), use_forecast=False) is None
    assert W.build(2026, dt.date(2026, 6, 1), out, weather=fake_weather(dt.date(2026, 5, 28)),
                   photos=photo_rows().iloc[:0], use_forecast=False) is None
    assert not out.exists()


def test_a_limited_run_is_marked_dry(tmp_path, monkeypatch):
    monkeypatch.setattr(W, "STEP", 40)
    res = W.build(2026, dt.date(2026, 9, 1), tmp_path / "a", weather=fake_weather(dt.date(2026, 8, 28)),
                  photos=photo_rows(n=300), use_forecast=False, dots=False)
    assert res["dry_run"] is True                               # --no-dots: never published (and not held to MIN_PHOTOS)


def test_judging_a_thin_year_never_crashes():
    seen, expected = np.zeros((4, 365)), np.zeros((4, 365))
    seen[0, 100], expected[0, 100] = 2, 1.5
    rows, phi, phi_t = W.judge_all(seen, expected)
    assert phi == phi_t == 1.0 and rows[0] == [2, 1.5, None, None]


def test_year_dots_hold_this_years_photos_only():
    p = W.label_photos(photo_rows(), 2026, 300, SPECIES[:-1], [c["h"] for c in CELLS])
    got = W.year_dots(p, 2026, 3)
    d0 = DOTS.unpack(got[0])
    assert (d0.year == 2026).all()
    assert set(d0.inat_id) == set(p[(p.label == 0) & W.in_states(p.lat, p.lng)].id)
    assert DOTS.pack(d0) == got[0] and got[2] == b""              # "other" (last) gets none


# ---------------------------------------------------------------- the overlay at deploy (scripts/atlas-overlay.mjs)
def node_or_skip():
    node = shutil.which("node")
    if not node:
        pytest.skip("no node")
    return node


def site_copy(tmp_path):
    """A built site's atlas folder (the files the overlay reads), a few dots files, and a dist/sw.js."""
    dist = tmp_path / "dist"
    site = dist / "atlas"
    (site / "dots").mkdir(parents=True)
    for f in ("species.json", "model.bin", "cells.json", "year.json", "seen-2026.json"):
        shutil.copy(OUT / f, site / f)
    for i in range(3):
        shutil.copy(OUT / "dots" / f"{i}.bin", site / "dots" / f"{i}.bin")
    (dist / "sw.js").write_text("const VERSION = 'abcdef012345';\nconst CACHE = `hatch-${VERSION}`;\n")
    return dist, site


def overlay(node, src, site):
    r = subprocess.run([node, str(ROOT / "scripts/atlas-overlay.mjs"), str(src), str(site)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout


def edited(run, tmp_path, name, change):
    """A copy of the run's output with year.json changed by `change` (a function of the dict and the folder)."""
    o = tmp_path / name
    shutil.copytree(run, o)
    y = json.loads((o / "year.json").read_text())
    change(y, o)
    (o / "year.json").write_text(json.dumps(y))
    return o


def test_overlay_refuses_what_does_not_fit(run_2026, tmp_path):
    node = node_or_skip()
    _, out = run_2026
    dist, site = site_copy(tmp_path)
    before = {p: p.read_bytes() for p in site.rglob("*") if p.is_file()}

    def tamper(y, o):
        (o / "seen-2026.bin").write_bytes(b"x")
    cases = {
        "dry": lambda y, o: y.update(dry_run=True),
        "older": lambda y, o: y.update(year=2025),
        "species": lambda y, o: y.update(species=3),
        "model": lambda y, o: y.update(model="000000000000"),
        "cells": lambda y, o: y.update(cells="000000000000"),
        "tampered": tamper,
        "extra": lambda y, o: (o / "stale-2025.json").write_text("{}"),
        "no-manifest": lambda y, o: y.pop("files"),
    }
    for name, change in cases.items():
        assert "skipped" in overlay(node, edited(out, tmp_path, name, change), site), name
    assert {p: p.read_bytes() for p in site.rglob("*") if p.is_file()} == before
    assert "abcdef012345" in (dist / "sw.js").read_text()


def test_overlay_swaps_this_years_dots_and_restamps_the_worker(run_2026, tmp_path):
    node = node_or_skip()
    _, out = run_2026
    dist, site = site_copy(tmp_path)
    main0 = DOTS.unpack((site / "dots" / "0.bin").read_bytes())
    said = overlay(node, out, site)
    assert "atlas overlay: 2026 so far" in said
    assert json.loads((site / "year.json").read_text())["year"] == 2026 and (site / "seen-2026.bin").exists()
    assert not (site / "dots-year").exists()
    now0 = (site / "dots" / "0.bin").read_bytes()
    d = DOTS.unpack(now0)
    year0 = DOTS.unpack((out / "dots-year" / "0.bin").read_bytes())
    # main's older years untouched, its 2026 rows replaced by the release's, in dots.py's order
    want = pd.concat([main0[main0.year != 2026], year0], ignore_index=True).sort_values(["year", "doy"], kind="stable")
    assert now0 == DOTS.pack(want)
    assert (d[d.year < 2026].reset_index(drop=True) == main0[main0.year < 2026].reset_index(drop=True)).all().all()
    v = (dist / "sw.js").read_text()
    assert "abcdef012345" not in v and "const VERSION = '" in v       # returning visitors get the new files
    # the same overlay again changes nothing but proves it is repeatable (dots swapped, not appended)
    overlay(node, out, site)
    assert (site / "dots" / "0.bin").read_bytes() == now0


def test_overlay_skips_a_release_it_cannot_read(run_2026, tmp_path):
    """A bad release keeps main's files and lets the deploy go on (exit 0); only a broken sw.js fails it."""
    node = node_or_skip()
    _, out = run_2026
    dist, site = site_copy(tmp_path)
    before = {p: p.read_bytes() for p in site.rglob("*") if p.is_file()}
    bad_json = tmp_path / "bad-json"
    shutil.copytree(out, bad_json)
    (bad_json / "year.json").write_text('{"year": 2026, "files": {')            # cut off mid-write

    def folder(y, o):                                                            # a manifest entry that is a folder
        (o / "dots-year" / "odd").mkdir()
        y["files"]["dots-year/odd"] = "0" * 64
    for src in (bad_json, edited(out, tmp_path, "folder", folder)):
        said = overlay(node, src, site)
        assert "::warning::atlas overlay skipped" in said, said
    assert {p: p.read_bytes() for p in site.rglob("*") if p.is_file()} == before

    (dist / "sw.js").write_text("self.addEventListener('fetch', () => {});\n")   # no VERSION to restamp
    r = subprocess.run([node, str(ROOT / "scripts/atlas-overlay.mjs"), str(out), str(site)], capture_output=True, text=True)
    assert r.returncode == 1 and "no VERSION" in r.stderr
