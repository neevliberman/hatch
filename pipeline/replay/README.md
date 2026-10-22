# Season replay data pipeline

`build_replay.py` builds `src/data/luna-replay.json`, the file the Hatch "season replay" map reads.
It holds, for every res-4 hex cell in the seven core states, a forecast of the day each share
(5%, 25%, 50%, 75%, 95%) of first-brood luna moths is out, for each year 2015-2025 plus a "typical" year.
It also holds the display sightings (iNaturalist, openly licensed), the brood cut-offs, and the
P1 leave-one-year-out scores that back up the forecast.

Run it from the repo root: `pip install -r notebooks/requirements.txt`, then
`python3 pipeline/replay/build_replay.py`. The first run downloads iNaturalist records and Daymet
temperatures (a few minutes, rate-limited) into `notebooks/data/`; reruns are offline.
Tests: `python3 -m pytest pipeline/replay`.

The forecast is P1's exploratory "skewed heat" model: warmth is counted as degree-days (base 10 C, from 1 March)
and a cell's moths are "out" in proportion to how many past sightings happened at or below that much warmth.
The script stops without writing if it cannot reproduce P1's scores (about 4.0 d heat, 7.3 d calendar).

LOYO means leave-one-year-out. Analogy: to grade a weather forecaster on 2019, you hide everything that
happened in 2019 and let them learn from the other ten years only. So a replayed year never "saw" its own moths,
and the replay is an honest guess, not a memory.
