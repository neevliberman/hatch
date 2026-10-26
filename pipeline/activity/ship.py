"""Fit the moth model on every box and year, and write moth_static.json: the weather coefficients and, for each
box and week of the year, the lift a slow / typical / busy night has had (the 1/3 and 2/3 marks over 2017-2025).

Run: python3 -m pipeline.activity.ship
"""
import json
from pathlib import Path

import numpy as np

from .features import build
from .model import Fit
from .terms import add_terms, lift_from, terms_for

OUT = Path(__file__).parent / "moth_static.json"
LO, HI = 121, 288   # the days the model was fitted and scored on (1 May - 15 Oct)


def main():
    df = add_terms(build())
    df = df[(df.doy >= LO) & (df.doy <= HI)].reset_index(drop=True)
    fit = Fit(df, "moth", True)
    coef = {t: float(fit.res.params[t]) for t in terms_for("moth")}
    df["lift"] = lift_from(coef, df)
    df["wk"] = df.doy // 7
    cuts = {r: {int(w): [round(float(g.lift.quantile(1 / 3)), 4), round(float(g.lift.quantile(2 / 3)), 4)]
                for w, g in d.groupby("wk")} for r, d in df.groupby("region")}
    OUT.write_text(json.dumps(dict(coef=coef, window=[LO, HI], cuts=cuts, rows=len(df)), indent=1))
    print("wrote", OUT, coef)


if __name__ == "__main__":
    main()
