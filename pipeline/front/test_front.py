import datetime as dt

from front import build_front


def test_spring_stops_at_the_wave_end_and_drops_the_band_cutoffs(monkeypatch):
    from live import build_live
    seen = {}

    def fake(season, as_of, cutoffs, taxon, last_doy):
        seen.update(season=season, as_of=as_of, cutoffs=cutoffs, taxon=taxon, last_doy=last_doy)
        return [[1, season, 100, 41.0, -87.0, 0]]

    monkeypatch.setattr(build_live, "season_sightings", fake)
    rows = build_front.spring("monarch", 2025, dt.date(2025, 12, 31))
    assert rows == [[1, 2025, 100, 41.0, -87.0, 0]]
    assert seen["as_of"] == dt.date(2025, 7, 15)          # doy 196 in a non-leap year
    assert seen["last_doy"] == build_front.FRONT_END
    assert seen["taxon"] == 48662 and set(seen["cutoffs"]) == {None}


def test_live_front_uses_today_before_the_wave_ends(monkeypatch):
    got = {}
    monkeypatch.setattr(build_front, "spring", lambda key, year, as_of, fetch=None: got.setdefault(key, as_of) and [])
    out = build_front.live_front(2027, dt.date(2027, 5, 1))
    assert set(out) == {"monarch", "red-admiral"}
    assert out["monarch"] == {"season": 2027, "as_of": "2027-05-01", "sightings": []}


def test_a_failing_species_keeps_last_nights_entry_and_never_raises(monkeypatch):
    def spring(key, year, as_of, fetch=None):
        if key == "monarch":
            raise RuntimeError("iNat down")
        return [[2, year, 120, 42.0, -88.0, 0]]

    monkeypatch.setattr(build_front, "spring", spring)
    prev = {"monarch": {"season": 2027, "as_of": "2027-04-30", "sightings": [[1, 2027, 118, 41.0, -87.0, 0]]}}
    out = build_front.live_front(2027, dt.date(2027, 5, 1), prev)
    assert out["monarch"] == prev["monarch"]
    assert out["red-admiral"]["sightings"] == [[2, 2027, 120, 42.0, -88.0, 0]]
    assert "monarch" not in build_front.live_front(2027, dt.date(2027, 5, 1), None)


def test_the_nightly_job_hands_over_its_own_fetch(monkeypatch):
    calls = []
    out = build_front.live_front(2027, dt.date(2027, 5, 1), None, lambda *a, **k: calls.append(a) or [])
    assert len(calls) == 2 and out["monarch"]["sightings"] == []
