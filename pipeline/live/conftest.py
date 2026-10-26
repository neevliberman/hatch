"""Every live test runs without the eastern shadow track's own process (pipeline/league/east.py reads PRISM and
iNaturalist over the network); test_species.no_east stubs it explicitly where its wiring is tested. No test may open
a GitHub issue (pipeline/league/drift.py does when the nightly job's token is set)."""
import pytest


@pytest.fixture(autouse=True)
def _no_eastern_track(monkeypatch):
    from live import scorecard
    monkeypatch.setattr(scorecard, "run_east", lambda *a: None)
    monkeypatch.delenv("GH_TOKEN", raising=False)
