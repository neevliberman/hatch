# P1 result: luna moth go/no-go (2026-10-21, revised after review 2026-10-22)

**Verdict.**
- **Frozen test: NO-GO.** The pre-registered heat model (bell curve, base 10 °C) loses to the calendar.
- **Exploratory signal: promising.** The same model with a skewed curve beats the calendar by 3.3 days (95% CI 0.9-5.4). It isn't the pre-registered test, so it has to be confirmed in P3 on data it hasn't seen (the 2026 season, or a spatial holdout).
- **"The model learned the threshold": NO-GO.** Fix the base at 10 °C.

Notebook: [p1_luna_gonogo.ipynb](p1_luna_gonogo.ipynb) · choices frozen before results: [FROZEN_CHOICES.md](FROZEN_CHOICES.md) (with change log)

## The numbers (luna first brood, 31 latitude band-years, leave-one-year-out)

| Model | Onset error | Peak error | Average | vs calendar (95% CI over years) |
|---|---|---|---|---|
| (a) Calendar for that band | 8.0 d | 6.7 d | 7.3 d | |
| (c) Heat, base 10 °C, bell curve *(frozen)* | 18.7 d | **4.0 d** | 11.4 d | 4.0 d worse (1.0 to 7.3) |
| (d) Heat, base learned *(frozen)* | 8.5 d | 4.1 d | 6.3 d | 1.0 d better (-1.2 to +3.1) |
| Heat, base 10 °C, skewed curve *(exploratory)* | **3.9 d** | **4.2 d** | **4.0 d** | **3.3 d better (0.9 to 5.4)** |

How precisely the targets themselves are known (bootstrap SD, ~20-180 records per band-year): 3.1 d for onset and 3.5 d for peak.
A perfect predictor would still score about 2.6 d MAE against these noisy targets, so the skewed model sits about 1.4 d above that floor.

**Why the GO isn't earned the strict way:**
1. The frozen bell-curve model failed. The skewed curve was tried *after* seeing that.
2. The skewed result also needs the post-freeze brood-split change (50% to 80%). Under the original 50% rule it loses to the calendar by 1.2 d (CI -4.1 to +1.7), because two bands keep their July brood.
3. The CI comes from only 9 year-clusters, which is optimistic.

What *is* solid: the skewed model wins in every band (+1.8 to +7.3 d), and it still wins against a stronger calendar baseline built from pooled records.

## What each piece says

1. **The wave is real.** The first-brood median moves from 16 May (37-39 °N) to 21 June (45-49 °N), about 9 days per 2° of latitude. P2's south-to-north animation has something to show.
2. **The bank-account idea roughly holds.** Median warmth at a sighting is 230-320 degree-days (base 10 °C) in every band, while the dates span five weeks. It drifts lower going north (a P3 question: local adaptation or daylength).
3. **Heat predicts the peak well; the bell curve wrecks the onset.** Degree-days at sightings have a long warm tail, so a symmetric curve calls "10% of moths are out" weeks too early, in every band.
4. **The threshold can't be learned from this data.**
   - The learned base sits at 0 °C, the edge of the search grid, in every fold. It is compensating for the curve shape.
   - Simulate-and-recover, with fake sightings drawn from the fitter's *own* model: planted bases of 8/10/12 °C came back as 6.0/7.0/9.0 °C (median), and within ±1 °C only 10-20% of the time. Adding real day-to-day effort doesn't help (10-30%).
   - Bases of 5 °C and 10 °C score the same on real data.
   - The "ridge" the plan warned about is real.
5. **Firefly outside check.** The pipeline puts the median firefly sighting at 716 degree-days, against the published 800. The published rule predicts the peak 6.5 d late (MAE 6.8 d). Heat beats the calendar on the firefly peak (4.0 vs 5.8 d) but not on onset.
6. **The brood split matters more than any model choice** (see "Why" above). The cut is a fixed calendar day per band, which trims cold-year late fliers and nudges the targets slightly toward the calendar. The cut-offs are also computed from all years pooled, including the held-out one. Recomputing them per fold changed MAEs by less than 0.2 d.

## Census (confirms review 2)
- **Luna:**
  - 6,809 records in 7 states; 98% research grade.
  - 9.8% uploaded more than a year late; 10% annotated as non-adult (dropped).
  - After cleaning 2015-2025: 3,849 records (2,023 first-brood) from 3,060 observers.
  - The top hex has 120 records, 42% of them from one observer.
- **Firefly:** 10,918 records, only 35% research grade; 53% have no life-stage annotation.
- **Thin data:** only 1 luna band-year reaches 150+ records (P3's scoring bar).

## What this changes downstream
- **Headline, honestly:** "In a first test, heat called luna moths about 3 days closer than the calendar. We're confirming it on the 2026 season." Not "learned the threshold".
- **P3 has to:**
  - make the skewed curve the default, with the base fixed at 10 °C;
  - confirm on 2026 (once Daymet 2026 is out, around mid-2027) or a spatial holdout (fit IL/IN/OH, predict WI/MN), with no more tuning first;
  - drop the 150+ bar;
  - compute brood cut-offs per fold;
  - weight by observer.
- **P2:** the wave exists, so animate it. The second brood shows as grey "observed".
- **Hero stays luna.** The firefly check passes on peak only, and fireflies have a third the research-grade share.

## Data sources
- **Reachable:** iNaturalist API, Daymet v4 single-pixel API, GBIF API (not needed yet).
- **Blocked from this cloud environment:** PRISM (services.nacse.org) and the Open-Meteo archive (archive-api.open-meteo.com). P4 needs PRISM. P3's soil-temperature comparison needs Open-Meteo.
