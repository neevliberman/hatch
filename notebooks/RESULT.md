# P1 result: luna moth go/no-go (2026-10-21)

**Verdict: GO for "heat beats the calendar", with the threshold fixed at 10 °C. NO-GO for "the model learned the threshold".**
The go comes with one honest asterisk: the frozen bell-curve version failed; the version that passes uses a skewed curve,
which the plan had scheduled for P3 and which was run early here, labelled exploratory.

Notebook: [p1_luna_gonogo.ipynb](p1_luna_gonogo.ipynb) · choices frozen before results: [FROZEN_CHOICES.md](FROZEN_CHOICES.md)

## The numbers (luna, first brood, 31 latitude band-years, leave-one-year-out)

| Model | Onset error | Peak error | Average | vs calendar |
|---|---|---|---|---|
| (a) Calendar for that band | 8.1 d | 6.7 d | 7.4 d | |
| (c) Heat, base 10 °C, bell curve *(frozen)* | 19.3 d | **4.1 d** | 11.7 d | 4.3 d worse (95% CI 0.9-7.8) |
| (d) Heat, base learned *(frozen)* | 8.7 d | 4.2 d | 6.4 d | 1.0 d better (CI -1.4 to +3.2) |
| Heat, base 10 °C, skewed curve *(exploratory)* | **4.2 d** | **4.2 d** | **4.2 d** | **3.2 d better (CI 0.7-5.5)** |

Noise floor (how well the target itself is known from ~20-180 records): ±3.1 d onset, ±3.5 d peak.
So the skewed-curve heat model is about one day off the best possible score on this data.

## What each piece says

1. **The wave is real.** First-brood median moves from 16 May (37-39 °N) to 21 June (45-49 °N), about 9 days per 2° of latitude. P2's south-to-north animation has something to show.
2. **The bank-account idea roughly holds.** Median warmth at a sighting is 230-320 degree-days (base 10 °C) in every band, while dates differ by five weeks. It drifts a little lower going north (worth a look in P3: local adaptation or daylength).
3. **Heat predicts the peak well; the bell curve wrecks the onset.** Degree-days at sightings have a long warm tail, so a symmetric curve puts "10% of moths are out" weeks too early, every band, every year. Swapping in the real (skewed) spread fixes onset from 19 d to 4 d. Peak was already 4 d.
4. **The threshold cannot be learned from this data.** The learned base ran to 0 °C (edge of the grid) in every fold, chasing the curve-shape error. Simulate-and-recover failed: planted bases of 8/10/12 °C came back as 4/5.5/7.5 °C (median), within ±1 °C only 5-30% of the time. Bases 5 °C and 10 °C score the same on real data (4.1 vs 4.2 d). The "ridge" the plan warned about is real.
5. **Firefly outside check: plumbing is sane, published rule runs late.** Median degree-days at firefly sightings = 714 vs the published 800; the published rule predicts the peak 6.8 d late (MAE 7.1 d). Heat beats the calendar on firefly peak (3.9 vs 5.8 d) but not onset. The ~11% gap to the paper is plausible (Daymet grid vs one Michigan site, iNat timing) and makes a good "here's why" story.
6. **Brood split matters more than any model choice.** With the originally frozen 50% rule, two bands keep their July brood and both calendar and heat fall apart (calendar peak error 10 d). The logged change to 80% is what everything above uses.

## Census (confirms review 2)
- Luna: 6,809 records in 7 states, 98% research grade, **9.8% uploaded >1 year late**, 10% annotated as non-adult (dropped).
  Clean 2015-2025 after dedupe: 3,849 records (2,023 first-brood), 3,060 observers. Top hex: 120 records, **42% from one observer**.
- Firefly: 10,918 records, **only 35% research grade** (64% needs-ID), 53% without a life-stage annotation.
- Thin data: only **1** luna band-year has 150+ records (plan P3's scoring bar). P3 must score at ≥20 per band-year with the noise floor shown, or pool years.

## What this changes downstream
- **Headline:** "Heat predicts luna moths better than the calendar, about 3 days closer, tuned on community science." Not "learned the threshold".
- **P3:** base fixed at 10 °C; the skewed curve becomes the default, not an option; re-run simulate-and-recover with the skew-aware/likelihood fitter before claiming anything about μ, σ; drop the 150+ bar; keep the brood split; add observer weighting (one observer = 42% of the top hex).
- **P2:** the wave exists; animate it. Second brood shows as grey "observed", as planned.
- **Not a reason to swap heroes:** firefly passes on peak only and has a third the research-grade share. Luna stays.

## Data sources
iNaturalist API (reachable), Daymet v4 single-pixel API (reachable), GBIF API (reachable, not needed yet).
**Blocked from this cloud environment:** PRISM (services.nacse.org) and Open-Meteo archive (archive-api.open-meteo.com). Neither was needed for P1; P4 needs PRISM, and P3's soil-temperature comparison needs Open-Meteo.
