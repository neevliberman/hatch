"""PREREG_2027.md pins files by hash. If a pinned file changes, revert it or add a dated amendment line to the prereg
(with a reason code from the allowed list); editing the registration table alone does not count as an amendment."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("prereg_hashes", Path(__file__).resolve().parents[1] / "prereg_hashes.py")
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)


def test_every_pinned_file_is_in_the_prereg_and_back():
    cur = P.current()
    assert not [k for k in cur if k not in P.table_pins()], "pinned file missing from the prereg table"
    assert not [k for k in P.table_pins() if k not in cur], "prereg table row not in prereg_hashes.FILES"


def test_frozen_files_match_prereg():
    bad = P.mismatches()
    assert not bad, "frozen file changed without an amendment in PREREG_2027.md:\n" + "\n".join(bad)


def test_amendments_are_well_formed_and_limited():
    assert not P.amendment_problems()


def test_late_amendment_reasons_are_the_fixed_list():
    assert P.LATE_REASONS == {"bug-both-models", "feed-outage"}
