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
    monkeypatch.setattr(L, "weather", fake_weather)
    monkeypatch.setattr(L, "season_sightings", lambda *a: [[1, 2027, 150, 40.0, -88.0, 0]])


def strip(d):
    return {k: v for k, v in d.items() if k not in ("generated", "checks", "species")}


def test_nightly_file_is_luna_on_top_and_the_rest_under_species(offline):
    today, as_of = dt.date(2027, 6, 3), dt.date(2027, 5, 31)
    alone = L.build(2027, as_of, False, today)
    out = L.build_all(2027, as_of, False, today)
    assert strip(out) == strip(alone)                      # luna's part is exactly the luna-only build
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
