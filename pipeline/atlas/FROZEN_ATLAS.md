# Living Atlas: frozen test rules (written 27 Oct 2026, before any training run)

These rules decide the 10 Nov go/no-go. They are committed before the first model is trained, like
[FROZEN_P3.md](../fit/FROZEN_P3.md). Any change after the first training run is an amendment: dated, explained, and
listed at the bottom, with the original result still reported.

## The question
Given a place, a day and the warmth so far this year, what share of insect photos should each species be?
"Share" means: of all research-grade iNaturalist insect records at that place and day, the fraction that are this
species. Observer effort cancels, because a busier weekend raises every species' count together.

## Data
- **Records**: GBIF's copy of iNaturalist research-grade observations, class Insecta, box 36.5-49.5 N, 97.5-80.5 W,
  1 Jan 2015 to 31 Dec 2025, pulled by `fetch_gbif.py` (snapshot of 27 Oct 2026). Records without a day are dropped.
  Subspecies roll up to their species. Records identified only above species rank stay in, as part of "other".
- **Bursts**: one record per observer × species × warmth cell × day. The same filter applies to training and test.
- **Warmth**: Daymet v4 daily Tmin/Tmax at H3 resolution-4 cell centres (`build_warmth.py`). Degree-days since 1 March,
  base 10 °C, upper 30 °C, double sine: the luna model's own count. Water cells borrow the nearest land cell.
- **Species list**: every species with ≥ 100 records in the training split (below) gets its own output. All other
  insect records form one "other" output, so the shares always sum to 1.

## Splits
- **Training**: 2015-2024, every state in the box except Wisconsin and Minnesota.
- **Tuning**: while choosing settings, train on 2015-2023 and score 2024 (training states only). 2025 and WI/MN are
  never looked at while tuning. The final model is then refitted on all of 2015-2024 with the chosen settings and the
  number of passes over the data found while tuning.
- **Test A, a year it never saw**: 2025, training states.
- **Test B, places it never saw**: Wisconsin and Minnesota, every year 2015-2025.

## The model (the Atlas)
- **Inputs**: place (latitude and longitude as sines and cosines at several scales, plus the cell's typical warmth by
  1 July over the training years) and a clock time τ.
- **Built-in warmth clock**: each place has a typical degree-day curve (mean of the training years). On any day,
  "days ahead" Δ is how many days earlier than usual this place reached today's degree-days (clipped to ±30 days;
  held at its last value once the typical curve gains under 2 degree-days a day, so autumn doesn't blow up). Each
  species blends three clocks: calendar (τ = day), half-warmth (τ = day + Δ/2) and full warmth (τ = day + Δ), with
  learned weights. Warmth only slides the season in time, so a spring hotter than any in training gives a bigger
  slide, never a nonsense shape.
- **Shape**: one shared network (the trunk) turns (place, τ) into a feature vector; one linear layer turns it into a
  score per species plus "other"; a softmax turns scores into shares.
- **Training**: cross-entropy on the training records. Settings chosen on the tuning split only.

## The baseline: each species' own calendar
For each species: its share of insect records in that 2° latitude strip (36.5-38.5 N, 38.5-40.5 N, ... 48.5-49.5 N)
and that week of the year, over the training years, smoothed toward the species' share in that strip over the whole
year. The smoothing strength (and whether to blend neighbouring weeks) is chosen on the tuning split, the same way
as the Atlas's settings. Wisconsin and Minnesota use the strip calendar learned from the other states.

## The score
One scorer for every species. For each test record and each species, the model gives the chance that this record is
that species. For species *s*, its score is the log-likelihood of "is this record *s*, yes or no?" summed over every
test record (a proper scoring rule: it rewards shares that are right, not just big or small). Atlas minus calendar
> 0 means the Atlas wins that species.

**Scored species**: ≥ 400 training records and ≥ 20 records in that test set.

## Go or no-go (all three must pass)
1. **Test A**: the Atlas wins more than half of the scored species, and wins on all records together
   (the full multi-class log-likelihood).
2. **Test B**: the same two conditions on Wisconsin and Minnesota.
3. **Luna check**: on 2025, luna moth first-brood onset (10th percentile day) and peak (median day) per latitude band,
   using P3's own band-years, targets and brood cut-offs (`pipeline/fit/results/loyo_rows.csv`, year 2025). The Atlas's
   dates come from its luna share × that band's insect records per day, up to the band's cut-off. Its mean days off
   must be within 1.0 day of P3's (`p3_photo`) on the same band-years.

**No-go** means: ship the same screens with plain expected-vs-seen curves from the calendar baseline, and no network.

## Also reported (not part of the gate)
- Atlas without warmth (calendar clock only): does warmth earn its place?
- Share of wins with a 95% binomial interval, and the median per-species gain.
- Per-species table and the 20 biggest wins and losses, by name.

## Amendments

### Amendment 1 (27 Oct 2026, after run 1, before any run 2 training)
**Run 1 result, kept on record:** no-go. Tests A and B passed by wide margins; the luna check failed (5.6 d vs P3's
4.3 d, bar 5.3 d). See [RESULT.md](RESULT.md).

**Why amend:** after run 1, a bug was found. The optimiser's weight decay also applied to each species' clock-blend
weights, pulling them back to an even mix every step, so the warmth clock could barely learn (median blend stayed
31/33/35%). Run 1's test data are now spent, so run 2 is scored on a season no step has touched: 2026.

**What changes (and nothing else):**
- The clock-blend weights get no weight decay. Everything else about the network, the features, the calendar
  baseline, the scorer and the tuning procedure (train 2015-2023, score 2024, training states) is as frozen above.
- **Final fit**: 2015-2025, every state except Wisconsin and Minnesota.
- **2026 warmth**: Daymet 2026 isn't out until mid-2027, so 2026 uses PRISM (via RCC-ACIS), shifted per cell by its
  mean Daymet-minus-PRISM gap over 2025 (`build_warmth_2026.py`).
- **Test C**: 2026 records (GBIF snapshot of 27 Oct 2026) up to the newest PRISM day, training states.
- **Test D**: Wisconsin and Minnesota, 2026 only.
- **Luna check (2026)**: P3's 2026 strips, real onset/peak and P3's forecasts from
  [SCORECARD_2026.md](../live/SCORECARD_2026.md) (P3 missed by 5.6 d, the calendar by 8.2 d), with each strip's
  first-wave cut-off from P3's 2025 fold (`loyo_rows.csv`). The Atlas's dates come from its luna share × that strip's
  2026 insect records per day, as in run 1. It passes if its mean miss is within 1.0 d of P3's and beats the
  calendar. Note: the Atlas sees the real weather up to each day (a hindcast), while P3's scorecard forecasts were
  issued at least 7 days ahead, so this check leans in the Atlas's favour.
- **Go** if tests C and D pass by the same two conditions as A and B (more than half of scored species, and all
  records together), and the 2026 luna check passes.

### Amendment 2 (27 Oct 2026, after an independent method review of runs 1 and 2; no retraining)
Two places where the code did not do what the luna check above says. Both are fixed, and the check is re-run on the
saved models (`recheck_luna.py`, `results/luna_amended.json`). The original numbers stay in `gate.json`.
- **Which records count.** The rule says "that band's insect records"; the code counted only training states. P3's
  band targets include Wisconsin and Minnesota (in 2025, 61 of 85 luna records in 43-45 N), so the Atlas was dated on
  a different area than the target. Now every state counts. WI/MN were never trained on, so this leaks nothing.
- **Quantile day.** The code rounded to whole days; P3's targets interpolate. Now the Atlas interpolates the same way.

Also fixed for future runs (the saved runs predate them; effects are small): leap years used a 28 Feb fold where
Daymet keeps 29 Feb and drops 31 Dec, so March-December warmth in 2016, 2020 and 2024 was read one day off; the burst
filter now keeps the lowest iNaturalist id, so it's deterministic; `build_warmth_2026.py` refuses a PRISM gap.
`run_gate.py` without `--run2` restores run 1's optimiser.

**On amendment 1's luna comparator:** run 2 compares an Atlas hindcast on real weather with P3 forecasts issued a
week ahead, and P3's weaker 2026 score was already known (SCORECARD_2026.md, 24 Oct) when amendment 1 was written.
So run 2's luna number is a comparison against forecasts, not like-for-like. Run 1's comparison is like-for-like
(both on real weather, P3 leave-one-year-out).
