# Firefly: Hatch's second species

The common eastern firefly (*Photinus pyralis*, iNaturalist taxon 129350), forecast with the luna moth's P3 model
(`pipeline/fit`). Output: `public/firefly-replay.json`, same format as `src/data/luna-replay.json`. The app fetches it
the first time someone picks "Firefly", so the luna page loads no extra bytes.

```
python3 pipeline/firefly/fetch.py          # iNat records, beetle effort, Daymet (cached in notebooks/data/)
python3 pipeline/firefly/build_firefly.py  # leave-one-year-out fits, scores, writes the JSON and result.json
```

What differs from luna:
- **One generation a year.** No brood split; every latitude strip's window is 1 March to 28 August (day 240).
- **Effort background = beetles.** Daily verifiable beetle records per state, fireflies' own family left out. It stands
  for "how many people were out photographing beetles that day".
- **No latitude or daylength term** (`p3_flat`). P3 found neither helped luna and recommended dropping it.

**This fit is exploratory.** Nothing was written down before scoring, unlike luna's P3. `result.json` holds the
leave-one-year-out and Illinois/Indiana/Ohio to Wisconsin/Minnesota scores, the per-fold parameters and the
noise floor. The app says "first try" next to every firefly number.
