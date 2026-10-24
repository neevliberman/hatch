# P4: the model search

Tries to beat P3 (the map's luna model) with ten ideas and ten times the data. Result: [RESULT.md](RESULT.md). Rules, written first: [FROZEN_P4.md](FROZEN_P4.md).

Needs `pip install -r pipeline/p4/requirements.txt`.

```
python3 pipeline/p4/wide.py            # (imported) downloads eastern luna records + effort grid into notebooks/data/wide/
python3 pipeline/p4/run_p4.py --cands m0j m6 c1 --workers 3   # folds are cached in notebooks/data/p4_cache/
python3 pipeline/p4/ml_c9.py           # trees and ridge
python3 pipeline/p4/ensembles.py       # averages, with intervals
python3 pipeline/p4/fetch_2026.py && python3 pipeline/p4/score_2026.py --cands m0j c1p
python3 -m pytest pipeline/p4
```
`jaxlik.py` is P3's likelihood with exact gradients (JAX), about 7× faster; `tests/` checks it against `pipeline/fit`.

Note: fold caches are keyed by candidate and year only. Delete `notebooks/data/p4_cache/` after changing code, or results will be stale.
