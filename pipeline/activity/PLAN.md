# Activity forecast: rules written before any result

Question: does the weather of a night (or day) say how many sightings people log, beyond what the date alone says?

Data: 14 metro boxes x 2017-2025 x 1 Apr-31 Oct. Daily iNaturalist counts for moths (Lepidoptera minus butterflies),
butterflies, fireflies, and all taxa (the "people out looking" control). Hourly Open-Meteo archive weather per box.
Held-out unit: a whole year (leave one year out, 9 folds).

Baseline ("season curve only"): negative-binomial counts, offset log(all sightings that day in the box), box effect,
smooth curve of day of year, weekend, Moth Week. Full model: baseline + weather (+ moon for night groups).

Ship a group only if both hold on the held-out years:
1. The full model beats the baseline in log-likelihood in at least 8 of the 9 held-out years.
2. Sorting held-out days by predicted weather lift, the top third logs at least 1.25x the sightings (against the
   baseline's expectation) of the bottom third, with the bootstrap 90% interval (resampling box-years) above 1.0.
