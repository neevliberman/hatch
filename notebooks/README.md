# notebooks/

Python side of Hatch: research notebooks that decide what the map is allowed to claim.

- **P1 luna go/no-go:** [RESULT.md](RESULT.md) (one page) · [p1_luna_gonogo.ipynb](p1_luna_gonogo.ipynb) · [FROZEN_CHOICES.md](FROZEN_CHOICES.md)
- `hatch_p1/`: the code the notebook calls (iNat + Daymet fetchers, degree-days, brood split, baselines, simulate-and-recover).
- **Pooled moths (exploratory, season-two idea):** [pooled/RESULT.md](pooled/RESULT.md): a model pooled across 52 Midwest moths, tested on data-poor species. Code and small derived tables in `pooled/`.
- `build_notebook.py` writes the notebook from plain Python, so diffs stay readable.

## Run it (from this `notebooks/` folder, Python 3.13)
```
pip install -r requirements.txt
python -m pytest -q hatch_p1          # degree-day maths vs brute-force integration
python build_notebook.py
python -m nbconvert --to notebook --execute --inplace --ExecutePreprocessor.timeout=1800 p1_luna_gonogo.ipynb
```
First run downloads ~18k iNat records and ~600 Daymet pixels into `data/` (gitignored, ~15 min); later runs use the cache.
