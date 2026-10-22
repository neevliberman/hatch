"""The P3 write-up figures (PNG)."""
import datetime as dt

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

INK, MUTED, GRID, SURFACE = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
COL = {"p3": "#2a78d6", "p1": "#eb6834", "cal": "#8a8984", "cal_lat": "#6250d6"}
LABEL = {"p3": "P3 model", "p1": "P1 model (what the map showed)", "cal": "Calendar",
         "cal_lat": "Calendar from IL/IN/OH, slid north by latitude"}


def _style(ax):
    ax.set_facecolor(SURFACE)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(MUTED)
    ax.tick_params(colors=MUTED, labelsize=9)
    ax.grid(axis="y", color=GRID, lw=0.8)
    ax.set_axisbelow(True)


def _date(t):
    d = dt.date(2021, 1, 1) + dt.timedelta(days=int(round(t)))
    return d.strftime("%-d %b")


def bias_by_band(d, chosen, path):
    bands = sorted(d.band.unique())
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.8), sharey=True, facecolor=SURFACE)
    x = np.arange(len(bands))
    for ax, (k, title) in zip(axes, (("ep", "Peak (median sighting)"), ("eo", "Onset (first 10% of sightings)"))):
        _style(ax)
        for j, (m, key) in enumerate((("p1", "p1"), (chosen, "p3"))):
            v = d.groupby("band")[f"{m}_{k}"].mean().reindex(bands).to_numpy()
            ax.bar(x + (j - 0.5) * 0.38, v, 0.36, color=COL[key], label=LABEL[key], edgecolor=SURFACE, lw=2)
            for xi, vi in zip(x + (j - 0.5) * 0.38, v):
                ax.text(xi, vi + (0.3 if vi >= 0 else -0.3), f"{vi:+.1f}", ha="center",
                        va="bottom" if vi >= 0 else "top", fontsize=8, color=INK)
        ax.axhline(0, color=INK, lw=1)
        ax.set_xticks(x, [f"{b}°N" for b in bands])
        ax.set_title(title, fontsize=10, color=INK, loc="left")
    axes[0].set_ylabel("Forecast minus real (days)\nbelow 0 = forecast too early", fontsize=9, color=MUTED)
    axes[0].legend(frameon=False, fontsize=8, loc="lower right")
    fig.suptitle("South-early, north-late bias, leave-one-year-out (mean error per band)", fontsize=11,
                 color=INK, x=0.01, ha="left")
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)


def predicted_vs_real(d, hd, chosen, path):
    fig, axes = plt.subplots(1, 2, figsize=(9, 4.2), facecolor=SURFACE)
    panels = ((axes[0], d, ["cal", "p1", chosen], "Leave-one-year-out, all 7 states"),
              (axes[1], hd, ["cal", "cal_lat", "p1", chosen], "Spatial holdout: learned IL/IN/OH, guessed WI/MN"))
    for ax, df, ms, title in panels:
        _style(ax)
        lo, hi = df.peak.min() - 12, df.peak.max() + 12
        ax.plot([lo, hi], [lo, hi], color=MUTED, lw=1, ls="--")
        for m in ms:
            key = "p3" if m == chosen else m
            ax.scatter(df.peak, df[f"{m}_peak"], s=36 if key == "p3" else 22, color=COL[key], label=LABEL[key],
                       edgecolor=SURFACE, lw=1, zorder=3 if key == "p3" else 2)
        ticks = np.linspace(lo + 5, hi - 5, 4)
        ax.set_xticks(ticks, [_date(t) for t in ticks])
        ax.set_yticks(ticks, [_date(t) for t in ticks])
        ax.set_xlim(lo, hi)
        ax.set_ylim(lo, hi)
        ax.set_xlabel("Real peak", fontsize=9, color=MUTED)
        ax.set_title(title, fontsize=10, color=INK, loc="left")
    axes[0].set_ylabel("Forecast peak", fontsize=9, color=MUTED)
    axes[1].legend(frameon=False, fontsize=8, loc="upper left")
    fig.suptitle("Each dot is one latitude band in one year; on the dashed line = perfect", fontsize=11,
                 color=INK, x=0.01, ha="left")
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)


def make_all(d, hd, chosen, out):
    bias_by_band(d, chosen, out / "bias_by_band.png")
    predicted_vs_real(d, hd, chosen, out / "predicted_vs_real.png")
