"""Builds p1_luna_gonogo.ipynb from the cells below (keeps the notebook diff-able as code)."""
import nbformat as nbf

md, code = nbf.v4.new_markdown_cell, nbf.v4.new_code_cell
cells = [
md("""# P1: does heat predict luna moths better than the calendar?

**The bet.** Each luna moth is a bank account that fills with warm days ("degree-days"). When the balance
crosses its threshold, it flies. If that is true, a warm spring should bring lunas early and a cold one late,
and a heat forecast should beat "same date as usual".

**The test (build-plan-v2, P1).** Before trusting a scale to weigh gold, weigh a known 1 kg block on it:
1. freeze the choices first ([FROZEN_CHOICES.md](FROZEN_CHOICES.md)),
2. census the data, 3. plot the wave, 4. simulate-and-recover,
5. score baselines leave-one-year-out on **dates**, 6. read off which headline is earned.

Fireflies (*Photinus pyralis*) go through the same pipe as an outside check against a published rule.
Data: iNaturalist (7 Midwest states), Daymet v4 daily temperatures at H3 res-4 hex centres, 2015-2025."""),
code("""import numpy as np, pandas as pd, matplotlib.pyplot as plt
from hatch_p1.run import load, temps, index, BASES, DATA
from hatch_p1 import model
from hatch_p1.census import census
from hatch_p1.simulate import effort_matrix, recover
from hatch_p1.inat import fetch_taxon, fetch_daily_effort
pd.set_option('display.precision', 1)
plt.rcParams.update({'figure.dpi': 110, 'axes.spines.top': False, 'axes.spines.right': False})
MOON, GREY, EMBER = '#4c9a6a', '#9aa0a6', '#c8743a'

# downloads are cached in data/ (gitignored); first run takes ~15 min
luna_raw = fetch_taxon(47916, DATA / 'luna_inat.parquet')
fly_raw = fetch_taxon(129350, DATA / 'pyralis_inat.parquet')
effort = fetch_daily_effort(47157, 47224, range(2008, 2026), DATA / 'moth_effort.parquet')"""),
md("""## 2. Census
How much data, how clustered, how late. (Review 2 predicted ~9.6% of luna records uploaded >1 year late,
one observer dominating the top hex, and a low firefly research-grade share.)"""),
code("""pd.DataFrame({'luna': census(luna_raw), 'firefly': census(fly_raw)}).map(lambda v: f'{v:.1%}' if v < 1 else f'{v:,.0f}')"""),
code("""rec_all, _ = load('luna_inat.parquet', split_broods=False)
pd.crosstab(rec_all.year, rec_all.band, margins=True)"""),
md("""## 3. The wave
Day of year against latitude, all years pooled. If heat drives first flight, the spring brood should slide later
going north. Grey = records the frozen brood rule calls **second brood** (southern summer generation, set by daylength, shown as observed in v1)."""),
code("""rec, cut = load('luna_inat.parquet')
print('brood cut-offs (day of year):', cut)
second = rec_all[~rec_all.id.isin(rec.id)]
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.scatter(second.doy, second.lat, s=4, c=GREY, alpha=.35, label='second brood (dropped)')
ax.scatter(rec.doy, rec.lat, s=4, c=MOON, alpha=.5, label='first / spring brood')
for b, g in rec.groupby('band', observed=True):
    ax.plot(g.doy.median(), g.lat.median(), 'o', ms=9, mfc='white', mec='k')
months = pd.to_datetime(['2025-04-01','2025-05-01','2025-06-01','2025-07-01','2025-08-01']).dayofyear
ax.set_xticks(months, ['Apr', 'May', 'Jun', 'Jul', 'Aug'])
ax.set_xlim(85, 245); ax.set_ylabel('latitude (°N)')
ax.set_title('Luna moths switch on south to north (white dots: band medians)', loc='left')
ax.legend(loc='lower right', frameon=False, markerscale=3)
fig.tight_layout(); fig.savefig('figures/wave.png', dpi=150)
first = rec.groupby('band', observed=True).doy.median()
print('first-brood median day by band:', first.to_dict())"""),
md("""## 4. Temperatures and degree-days
Double-sine, base 10 °C, upper cutoff 30 °C, from 1 March. Tests in `hatch_p1/test_degree_days.py` check the closed form
against brute-force integration of the sine."""),
code("""hexes, years, tmin, tmax = temps(rec)
r = index(rec, hexes, years)
cubes = {float(b): model.dd_cube(tmin, tmax, b) for b in BASES}
dd10 = cubes[10.0]
r['dd10'] = model.dd_at_sightings(r, dd10)
print(f'{len(hexes)} hexes, {len(r)} first-brood records')
r.groupby('band').dd10.describe(percentiles=[.1, .5, .9])[['count', '10%', '50%', '90%']]"""),
md("""**Read this table like a receipt.** Median "warmth saved up" at a sighting is 230-320 degree-days in every band,
even though the calendar dates are a month apart. That is the bank-account idea holding roughly. Note the long right
tail (90th percentile ≈ 2× the median): a symmetric bell curve in degree-days will not fit it well."""),
md("""## 5. Baselines, leave-one-year-out, scored on dates
Targets per band-year (≥ 20 records): **onset** = 10th percentile day, **peak** = median day.
The noise floor is how precisely the target itself is known (bootstrap SD)."""),
code("""tg = model.noise_floor(r, model.targets(r))
print('scored band-years:', len(tg), '| with 150+ records:', (tg.n >= 150).sum())
print('noise floor (median bootstrap SD, days):', tg[['sd_onset', 'sd_peak']].median().round(1).to_dict())
a = model.calendar_predictions(tg)
c = model.heat_predictions(r, tg, dd10, years)
d = model.full_predictions(r, tg, cubes, years)
table = pd.DataFrame({k: model.score(tg, p) for k, p in
                      {'(a) calendar': a, '(c) heat, base 10 °C': c, '(d) heat, base learned': d}.items()}).T
print('learned base per held-out year:', d.groupby('year').base.first().to_dict())
table"""),
code("""for name, p in [('(c) vs (a)', c), ('(d) vs (a)', d)]:
    diff, ci = model.paired_bootstrap(tg, a, p)
    print(f'{name}: calendar MAE minus model MAE = {diff:+.1f} days (95% CI over years {ci[0]:+.1f} to {ci[1]:+.1f})')
diff, ci = model.paired_bootstrap(tg, c, d)
print(f'(d) vs (c): {diff:+.1f} days (95% CI {ci[0]:+.1f} to {ci[1]:+.1f})')"""),
md("""**What happened.** Heat nails the **peak** (≈4 days off vs ≈7 for the calendar, close to the ~3.5-day noise floor)
but misses the **onset** by ~19 days, always too early. That is the bell curve: the real spread of degree-days at sightings is
skewed (long warm tail), so a symmetric curve puts its 10% point far too low. (d) "improves" by sliding the base to 0 °C, the
edge of the grid, which flattens the skew. That is the fitter compensating for the wrong curve, not learning biology."""),
md("""## 6. Simulate-and-recover
Fake sightings from a known base (8, 10, 12 °C) using real temperatures, real places and counts, and real daily moth effort.
Can the (d) fitter find the base again? Pass = within ±1 °C."""),
code("""eff = effort_matrix(effort, years)
sim = recover(r, cubes, years, eff, reps=20)
sim['within_1C'] = (sim.recovered - sim.true_base).abs() <= 1
sim.to_csv('figures/sim_recover.csv', index=False)
summary = sim.groupby('true_base').agg(median=('recovered', 'median'), lo=('recovered', lambda x: x.quantile(.1)),
                                       hi=('recovered', lambda x: x.quantile(.9)), within_1C=('within_1C', 'mean'))
summary"""),
code("""fig, ax = plt.subplots(figsize=(5.5, 4))
for tb, g in sim.groupby('true_base'):
    ax.scatter(np.full(len(g), tb) + np.random.default_rng(0).uniform(-.25, .25, len(g)), g.recovered, s=14, c=EMBER, alpha=.7)
ax.plot([7, 13], [7, 13], c='k', lw=1, ls='--'); ax.fill_between([7, 13], [6, 12], [8, 14], color=MOON, alpha=.15, label='±1 °C pass band')
ax.set_xlabel('true base (°C)'); ax.set_ylabel('recovered base (°C)'); ax.set_xlim(7, 13); ax.set_ylim(-0.5, 15.5)
ax.set_title('Can the fitter find a base we planted?', loc='left'); ax.legend(frameon=False)
fig.tight_layout(); fig.savefig('figures/sim_recover.png', dpi=150)"""),
md("""## 7. Firefly check against a published answer
Same pipe, *Photinus pyralis*, one brood. The published rule (800 DD, base 10 °C, double-sine from 1 March, peak)
is the one outside answer we can check the plumbing against."""),
code("""frec, _ = load('pyralis_inat.parquet', split_broods=False)
fh, fy, ftmin, ftmax = temps(frec)
fr = index(frec, fh, fy)
fdd = model.dd_cube(ftmin, ftmax, 10)
ftg = model.noise_floor(fr, model.targets(fr))
fa, fc = model.calendar_predictions(ftg), model.heat_predictions(fr, ftg, fdd, fy)
rule = []
for _, x in ftg.iterrows():
    hx, w = model._band_weights(fr[fr.year != x.year], x.band)
    rule.append((x.band, x.year, np.nan, model.predict_rule(fdd, hx, w, int(x.year - fy[0]), 800)))
fb = pd.DataFrame(rule, columns=['band', 'year', 'onset_pred', 'peak_pred'])
m = ftg.merge(fb, on=['band', 'year'])
print(f'scored band-years: {len(ftg)}; median DD at sighting: {np.median(model.dd_at_sightings(fr, fdd)):.0f} (published peak: 800)')
print(f'(b) published rule, peak: MAE {(m.peak_pred - m.peak).abs().mean():.1f} d, bias {(m.peak_pred - m.peak).mean():+.1f} d (late)')
pd.DataFrame({'(a) calendar': model.score(ftg, fa), '(c) heat, base 10 °C': model.score(ftg, fc)}).T"""),
md("""## 8. Sensitivity and one exploratory check (not frozen; labelled as such)
* **Brood rule as originally frozen (50%)** instead of the logged change to 80%.
* **Skew-aware heat model.** Same as (c) but the bell curve is swapped for the actual spread of degree-days at
  training sightings. This is *not* a frozen baseline; it is the P3 item "compare a skewed curve", run early because
  section 5 pointed straight at it. Bases 10 °C and 5 °C, nothing else tried."""),
code("""rec50, cut50 = load('luna_inat.parquet', frac=0.5)
r50 = index(rec50, hexes, years); tg50 = model.targets(r50)
print('50% rule cut-offs:', cut50)
print('50% rule  (a):', {k: round(v, 1) for k, v in model.score(tg50, model.calendar_predictions(tg50)).items()})
print('50% rule  (c):', {k: round(v, 1) for k, v in model.score(tg50, model.heat_predictions(r50, tg50, dd10, years)).items()})
for base in (10.0, 5.0):
    e = model.empirical_predictions(r, tg, cubes[base], years)
    diff, ci = model.paired_bootstrap(tg, a, e)
    print(f'skew-aware, base {base:.0f} °C:', {k: round(v, 1) for k, v in model.score(tg, e).items()},
          f'| beats calendar by {diff:+.1f} d (95% CI {ci[0]:+.1f} to {ci[1]:+.1f})')
e10 = model.empirical_predictions(r, tg, dd10, years)"""),
md("""With the 50% rule the 41-43 and 43-45 bands keep their July second brood, the bell curve widens until it puts ~15% of
moths before any warmth at all (onset predicted on 1 Jan), and the calendar's peak error also jumps to 10 days.
So the brood split matters more than any model choice; the 80% rule is the one used everywhere else."""),
code("""# one picture of the answer: per band-year peak error, calendar vs heat
mc = tg.merge(a, on=['band', 'year']).merge(e10, on=['band', 'year'], suffixes=('_cal', '_heat'))
fig, axs = plt.subplots(1, 2, figsize=(9, 4), sharey=True)
for ax, k, title in [(axs[0], 'onset', 'Onset (10% of sightings)'), (axs[1], 'peak', 'Peak (median sighting)')]:
    err_cal, err_heat = (mc[f'{k}_pred_cal'] - mc[k]).abs(), (mc[f'{k}_pred_heat'] - mc[k]).abs()
    for i, (lo, hi) in enumerate(zip(err_cal, err_heat)):
        ax.plot([0, 1], [lo, hi], c=GREY, lw=.8, alpha=.6)
    ax.scatter(np.zeros(len(mc)), err_cal, c=GREY, s=16); ax.scatter(np.ones(len(mc)), err_heat, c=MOON, s=16)
    ax.plot([0, 1], [err_cal.mean(), err_heat.mean()], c='k', lw=2.5, marker='o')
    ax.axhspan(0, tg[f'sd_{k}'].median(), color=MOON, alpha=.08)
    ax.set_xticks([0, 1], ['calendar', 'heat\\n(skew-aware, 10 °C)']); ax.set_xlim(-.3, 1.3); ax.set_title(title, loc='left')
axs[0].set_ylabel('days off, held-out year'); fig.suptitle('Each line is one latitude band in one year; black = average. Shaded = noise floor.', x=.02, ha='left', fontsize=9)
fig.tight_layout(); fig.savefig('figures/calendar_vs_heat.png', dpi=150)"""),
md("""## 9. Verdict
See [RESULT.md](RESULT.md) for the one-page reading of these numbers against the go/no-go table."""),
]
nb = nbf.v4.new_notebook(cells=cells, metadata={"kernelspec": {"name": "python3", "display_name": "Python 3"}})
nbf.write(nb, "p1_luna_gonogo.ipynb")
