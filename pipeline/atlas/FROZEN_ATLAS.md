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
None yet.
