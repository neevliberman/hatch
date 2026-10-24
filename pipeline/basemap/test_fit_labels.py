"""The label fit must be a pure function of its inputs: running it twice gives byte-identical files."""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fit_labels  # noqa: E402


def digest():
    return {n: hashlib.md5((fit_labels.OUT / f'{n}.json').read_bytes()).hexdigest() for n in ('overview', 'detail')}


def test_fit_is_idempotent():
    originals = {n: (fit_labels.OUT / f'{n}.json').read_bytes() for n in ('overview', 'detail')}
    try:
        fit_labels.main()
        first = digest()
        fit_labels.main()
        assert digest() == first
        # And the committed files are what the fit produces.
        assert {n: hashlib.md5(b).hexdigest() for n, b in originals.items()} == first
    finally:
        for n, b in originals.items():
            (fit_labels.OUT / f'{n}.json').write_bytes(b)
