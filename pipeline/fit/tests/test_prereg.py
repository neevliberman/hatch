"""The 2027 pre-registration pins files by hash. If a pinned file changes, either revert it or add a dated amendment
to pipeline/fit/PREREG_2027.md with the new hash (and say why)."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("prereg_hashes", Path(__file__).resolve().parents[1] / "prereg_hashes.py")
prereg_hashes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prereg_hashes)


def test_prereg_lists_every_pinned_file():
    pin = prereg_hashes.pinned()
    missing = [k for k in prereg_hashes.current() if k not in pin]
    assert not missing, f"not in PREREG_2027.md: {missing}"


def test_frozen_files_match_prereg():
    bad = prereg_hashes.mismatches()
    assert not bad, "frozen file changed without updating PREREG_2027.md:\n" + "\n".join(bad)
