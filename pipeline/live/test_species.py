"""Offline tests for the live pipeline's species list (registry.py): every species' own inputs, the nightly file's
layout (luna on top, the rest under "species"), one species failing without costing the others, and the scorecard's
one layer per species. python3 -m pytest pipeline/live"""
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live import build_live as L, registry, scorecard as S  # noqa: E402
from fit import data as fdata, model as M  # noqa: E402

LUNA_CELLS = json.loads(L.REPLAY.read_text())["cells"]


@pytest.mark.parametrize("sp", registry.SPECIES, ids=lambda s: s.key)
def test_each_species_brings_its_own_inputs(sp):
    replay = json.loads(sp.replay.read_text())
    assert replay["cells"] == LUNA_CELLS                  # the weather is fetched once, for one shared cell list
    spec, params, cuts = sp.folds()
    assert spec in M.SPECS and len(params) == len(cuts) == 11
    assert all(set(p) >= {"alpha", "mu0", "log_sigma"} for p in params)
    assert all(set(c) == {b["label"] for b in replay["bands"]} for c in cuts)
    if sp.last_doy:
        assert all(v == sp.last_doy for c in cuts for v in c.values())
    eff = json.loads(sp.effort.read_text())
    assert eff["states"] == fdata.STATES and np.array(eff["profile"]).shape == (7, 365)
    assert (np.array(eff["profile"]) > 0).all()
    assert len(sp.model_hash()) == 12
    assert replay["model"]["id"] and replay["scores"]       # the model id and the past errors the range is built from


def test_species_keep_apart():
    keys = [s.key for s in registry.SPECIES]
    assert keys[0] == "luna" and len(set(keys)) == len(keys)
    root = Path("/archive")
    assert registry.LUNA.archive(root) == root             # luna's archive stays where it was before more species
    folders = [s.archive(root) for s in registry.SPECIES]
    assert len(set(folders)) == len(folders)
    assert len({s.model_hash() for s in registry.SPECIES}) == len(keys)
    assert registry.LUNA.model_hash() == L.model_hash()


def fake_weather(season, as_of, use_forecast, cells):
    """Two made-up weather endings: a steady 8 or 10 degree-days a day from 1 March."""
    clat = np.array([L.h3.cell_to_latlng(c)[0] for c in cells])
    clng = np.array([L.h3.cell_to_latlng(c)[1] for c in cells])
    incs = []
    for v in (8.0, 10.0):
        inc = np.full((len(cells), 365), v)
        inc[:, :L.START_DOY - 1] = 0
        incs.append(inc)
    start = dt.date(season, 3, 1)
    return {"cells": cells, "clat": clat, "clng": clng, "years": np.array([2015, 2016]), "start": start,
            "i0": L.day_index(start), "i1": L.day_index(as_of) + 1, "f_end": as_of, "forecast_days": 0,
            "n_borrowed": 0, "incs": incs, "dd_now": np.cumsum(incs[0], 1)[:, L.day_index(as_of)],
            "use_forecast": use_forecast}


@pytest.fixture
def offline(monkeypatch):
    """No network: made-up weather, and a sightings stub that records which taxon and window each call asked for."""
    asked = []

    def sightings(season, as_of, cutoffs, taxon=L.TAXON, last_doy=None):
        asked.append((taxon, last_doy))
        return [[1, 2027, 150, 40.0, -88.0, 0]]
    monkeypatch.setattr(L, "weather", fake_weather)
    monkeypatch.setattr(L, "season_sightings", sightings)
    return asked


def strip(d):
    return {k: v for k, v in d.items() if k not in ("generated", "checks", "species", "shadows")}


def test_nightly_file_is_luna_on_top_and_the_rest_under_species(offline):
    today, as_of = dt.date(2027, 6, 3), dt.date(2027, 5, 31)
    alone = L.build(2027, as_of, False, today)
    out = L.build_all(2027, as_of, False, today)
    assert strip(out) == strip(alone)                      # luna's part is exactly the luna-only build
    # each species' sightings are its own taxon and window: luna, then (build_all) luna, firefly, beetle
    assert offline == [(47916, None), (47916, None), (129350, 240), (67760, 240)]
    assert sorted(out["species"]) == sorted(s.key for s in registry.SPECIES if s.key != "luna")
    assert out["checks"]["species_failed"] == []
    for key, e in out["species"].items():
        sp = registry.get(key)
        assert "cells" not in e                            # shared from the top level
        assert e["model"]["id"] == json.loads(sp.replay.read_text())["model"]["id"]
        assert e["model"]["hash"] == sp.model_hash() and e["season"] == 2027
        assert len(e["median"]) == len(out["cells"]) and len(e["bands"]) == len(out["bands"])
        assert e["median"] != out["median"]                # its own model, not luna's
        assert e["sightings"] == [[1, 2027, 150, 40.0, -88.0, 0]]
    # the bench (pipeline/league): P3.1's strip dates on the same weather, its own model, no sightings call of its own
    sh = out["shadows"]["luna~p3.1-v1"]
    assert out["checks"]["shadows_failed"] == []
    assert sh["model"]["id"] == "p3.1-v1" and sh["model"]["hash"] == "a9fb5fe06cdb" and "sightings" not in sh
    assert [b["band"] for b in sh["bands"]] == [b["band"] for b in out["bands"]] and sh["bands"] != out["bands"]


def test_one_species_failing_keeps_its_last_entry(offline, monkeypatch):
    real = L.forecast_species

    def flaky(sp, *a, **k):
        if sp.key == "firefly":
            raise RuntimeError("boom")
        return real(sp, *a, **k)
    monkeypatch.setattr(L, "forecast_species", flaky)
    prev = {"season": 2027, "species": {"firefly": {"season": 2027, "as_of": "2027-05-30", "bands": []}}}
    out = L.build_all(2027, dt.date(2027, 5, 31), False, dt.date(2027, 6, 3), prev)
    assert out["checks"]["species_failed"] == ["firefly"]
    assert out["species"]["firefly"]["as_of"] == "2027-05-30"     # last night's, so the app shows it as late
    assert "japanese-beetle" in out["species"] and out["median"]   # the others and luna still publish
    last_year = {"season": 2026, "species": {"firefly": {**prev["species"]["firefly"], "season": 2026}}}
    stale = L.build_all(2027, dt.date(2027, 5, 31), False, dt.date(2027, 6, 3), last_year)
    assert "firefly" not in stale["species"]                       # never last season's


def test_a_species_raising_systemexit_does_not_stop_luna(offline, monkeypatch):
    real = L.forecast_species

    def exits(sp, *a, **k):
        if sp.key == "japanese-beetle":
            raise SystemExit("bad cell list")
        return real(sp, *a, **k)
    monkeypatch.setattr(L, "forecast_species", exits)
    out = L.build_all(2027, dt.date(2027, 5, 31), False, dt.date(2027, 6, 3))
    assert out["checks"]["species_failed"] == ["japanese-beetle"] and "firefly" in out["species"] and out["median"]


def test_cell_mismatch_is_an_ordinary_error(offline):
    wx = fake_weather(2027, dt.date(2027, 5, 31), False, LUNA_CELLS[:-1])
    with pytest.raises(ValueError):
        L.forecast_species(registry.get("firefly"), wx, 2027, dt.date(2027, 5, 31), dt.date(2027, 6, 3))


def bands(onset, peak, labels=("37-39", "39-41", "41-43", "43-45", "45-49")):
    return [{"band": b, "onset": onset, "onset_lo": onset - 5, "onset_hi": onset + 5,
             "peak": peak, "peak_lo": peak - 5, "peak_hi": peak + 5} for b in labels]


def test_archive_and_scorecard_per_species(tmp_path):
    season = 2027
    live = {"season": season, "generated": "2027-04-01T13:00:00Z", "as_of": "2027-03-29",
            "model": {"id": "p3-v1", "hash": "a"}, "bands": bands(110, 130),
            "species": {"japanese-beetle": {"season": season, "generated": "2027-04-01T13:00:00Z", "as_of": "2027-03-29",
                                            "model": {"id": "japanese-beetle-v0", "hash": "b"}, "bands": bands(170, 190)}}}
    paths = S.add_all(tmp_path, live)
    assert paths == [tmp_path / "2027" / "2027-04-01.json", tmp_path / "japanese-beetle" / "2027" / "2027-04-01.json"]
    assert S.load_archive(tmp_path, season)[0]["model"]["id"] == "p3-v1"      # luna's folder holds luna only

    def recs(doy0):
        d = pd.DataFrame([{"id": i, "user_id": i, "observed_on": S.doy_date(season, doy0 + i).isoformat(),
                           "created_at": S.doy_date(season, doy0 + i).isoformat() + "T20:00:00-05:00",
                           "lat": 40.0, "lng": -88.0, "accuracy_m": 10.0, "obscured": False, "geoprivacy": None,
                           "quality_grade": "research", "captive": False, "life_stage": "adult"} for i in range(30)])
        return d
    records = {"luna": recs(110), "japanese-beetle": recs(175)}
    out, failed = S.scorecard_all(season, dt.date(2027, 10, 1), tmp_path, records)
    assert failed == [] and sorted(out["layers"]) == ["japanese-beetle", "luna"]   # the firefly has no archive: no layer
    luna_only = S.scorecard(season, records["luna"], S.load_archive(tmp_path, season), dt.date(2027, 10, 1))
    assert out["layers"]["luna"] == luna_only["layers"]["luna"]
    jb = {r["band"]: r for r in out["layers"]["japanese-beetle"]["bands"]}["39-41"]
    assert jb["status"] == "scored" and jb["peak"]["forecast"] == 190 and jb["peak"]["real"] == pytest.approx(189.5)
    assert out["layers"]["japanese-beetle"]["model"] == {"id": "japanese-beetle-v0", "hash": "b"}

    # a species whose records cannot be had keeps last week's layer, and is named
    def broken(*a):
        raise RuntimeError("iNat down")
    monkey = dict(records)
    del monkey["japanese-beetle"]
    orig = S.fetch_records
    S.fetch_records = broken
    try:
        again, failed = S.scorecard_all(season, dt.date(2027, 10, 8), tmp_path, monkey, prev=out)
    finally:
        S.fetch_records = orig
    assert failed == ["japanese-beetle"] and again["layers"]["japanese-beetle"] == out["layers"]["japanese-beetle"]


def live_file(generated="2027-04-01T13:00:00Z", **species):
    return {"season": 2027, "generated": generated, "as_of": "2027-03-29", "model": {"id": "p3-v1", "hash": "a"},
            "bands": bands(110, 130), "checks": {"species_failed": []},
            "species": {k: {"season": 2027, "generated": generated, "as_of": "2027-03-29",
                            "model": {"id": f"{k}-v0", "hash": k}, "bands": bands(170, 190), **v} for k, v in species.items()}}


def test_archive_skips_backfills_and_carried_entries(tmp_path):
    live = live_file(firefly={"backfill": True}, **{"japanese-beetle": {"generated": "2027-03-31T13:00:00Z"}})
    assert S.add_all(tmp_path, live) == [tmp_path / "2027" / "2027-04-01.json"]


def test_a_corrupt_species_archive_does_not_block_luna(tmp_path):
    S.add_all(tmp_path, live_file(firefly={}))
    (tmp_path / "firefly" / "2027" / "2027-04-01.json").write_text("{not json")
    out, failed = S.scorecard_all(2027, dt.date(2027, 10, 1), tmp_path, {"luna": pd.DataFrame(), "firefly": pd.DataFrame()})
    assert failed == ["firefly"] and "luna" in out["layers"] and "firefly" not in out["layers"]


def test_scorecard_main_fails_loudly_after_writing_when_a_forecast_failed(tmp_path, capsys):
    live = live_file(firefly={})
    live["checks"]["species_failed"] = ["japanese-beetle"]
    (tmp_path / "latest.json").write_text(json.dumps(live))
    pd.DataFrame().to_parquet(tmp_path / "empty.parquet")
    args = ["--archive", str(tmp_path / "archive"), "--season", "2027", "--add", str(tmp_path / "latest.json"),
            "--today", "2027-10-01", "--out", str(tmp_path / "scorecard.json"),
            "--records", str(tmp_path / "empty.parquet"), f"firefly={tmp_path / 'empty.parquet'}"]
    assert S.main(args) == 1
    assert sorted(json.loads((tmp_path / "scorecard.json").read_text())["layers"]) == ["firefly", "luna"]   # written
    err = capsys.readouterr().out
    assert "japanese-beetle forecast failed" in err and "WAS written" in err
    live["checks"]["species_failed"] = []
    (tmp_path / "latest.json").write_text(json.dumps(live))
    assert S.main(args) == 0


def test_importing_the_live_pipeline_patches_nothing():
    """The species list reads ids and windows without importing any build script (build_firefly / species.build set
    fit.evaluate.cutoffs to a one-generation rule when imported, which would change luna's fit code in this process)."""
    import subprocess
    code = ("import sys; sys.path.insert(0, 'pipeline'); from fit import evaluate as EV; before = EV.cutoffs; "
            "from live import registry, build_live, scorecard, rehearse; "
            "assert EV.cutoffs is before and EV.cutoffs.__module__ == 'fit.evaluate', EV.cutoffs.__module__; "
            "assert not any(m in sys.modules for m in ('firefly.build_firefly', 'species.build')), 'a build script was imported'")
    root = Path(__file__).resolve().parents[2]
    subprocess.run([sys.executable, "-c", code], cwd=root, check=True)
