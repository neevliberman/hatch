"""Negative-binomial counts: baseline (date only) vs full (date + weather).

Think of the baseline as the season's tide table: on this date, in this box, with this many people out, this many
sightings are normal. The weather terms say how far above or below the tide table tonight should run.
"""
import numpy as np
import patsy
import statsmodels.api as sm
from scipy.special import gammaln

from .terms import GROUPS, add_terms, terms_for  # noqa: F401

BASE = "C(region) * bs(doy, df=6) + weekend + mothweek"


def formula(group, weather):
    f = BASE
    if weather:
        f += " + " + " + ".join(terms_for(group))
    return f


class Fit:
    def __init__(self, df, group, weather):
        self.group, self.weather = group, weather
        y_col = GROUPS[group][0]
        y, X = patsy.dmatrices(f"{y_col} ~ {formula(group, weather)}", df, return_type="dataframe")
        self.design = X.design_info
        off = np.log(df.total.clip(lower=1)).values
        alpha = 1.0
        for _ in range(3):
            res = sm.GLM(y, X, family=sm.families.NegativeBinomial(alpha=alpha), offset=off).fit(maxiter=100)
            mu = res.mu
            alpha = max(float(np.sum(((y.values.ravel() - mu) ** 2 - mu) / mu ** 2) / (len(y) - X.shape[1])), 0.01)
        self.res, self.alpha = res, alpha

    def mean(self, df):
        X = patsy.build_design_matrices([self.design], df, return_type="dataframe")[0]
        return np.exp(X.values @ self.res.params.values + np.log(df.total.clip(lower=1)).values)

    def loglik(self, df):
        y = df[GROUPS[self.group][0]].values
        return nb_loglik(y, self.mean(df), self.alpha)


def nb_loglik(y, mu, alpha):
    r = 1 / alpha
    return gammaln(y + r) - gammaln(r) - gammaln(y + 1) + r * np.log(r / (r + mu)) + y * np.log(mu / (r + mu))
