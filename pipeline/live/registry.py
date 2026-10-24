"""The species the live pipeline forecasts every night, in one list. Each brings its own frozen fits, its own replay
file (cells, strip cut-offs, past errors, calendar, strip weights) and its own effort profile; the weather is shared.

Adding a species to the live map: an entry here, its effort profile (`build_static.py --effort <key>`), and that is
all: `build_live.py` forecasts it, `scorecard.py` archives and scores it, and the app shows it in live mode.

Analogy: one weather report read out to several gardeners, each with their own notebook of when their plant came up.
"""
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))

# Taxon ids and windows come from where each species' fit defines them, never copied here. Only modules with no
# import-time side effects (the build scripts patch fit.evaluate when imported, so they are never imported here).
import species as _species  # noqa: E402
from firefly import fetch as _ff_fetch  # noqa: E402


@dataclass(frozen=True)
class LiveSpecies:
    key: str                # the app's ?species= key, the scorecard layer, the archive folder
    name: str
    taxon: int              # iNaturalist taxon id (sightings so far, and the scorecard's records)
    replay: Path            # the app's replay file for this species
    fits: Path              # the frozen leave-one-year-out fits: luna's fold_fits.json, or a species' result.json
    effort: Path            # typical within-season recording effort per state (build_static.py)
    last_doy: int | None = None   # one generation a year: every strip's window ends here. None = the replay's cut-offs

    def folds(self):
        """(spec, [params per fold], [{band: cut-off doy} per fold]), in fold order."""
        js = json.loads(self.fits.read_text())
        if "folds" in js:                                   # pipeline/replay/fold_fits.json
            return js["spec"], [f["params"] for f in js["folds"].values()], [f["cuts"] for f in js["folds"].values()]
        bands = [b["label"] for b in json.loads(self.replay.read_text())["bands"]]
        params = [js["params"][y] for y in sorted(js["params"])]   # pipeline/species/<key>.result.json, firefly's
        return js["model"]["spec"], params, [{b: self.last_doy for b in bands} for _ in params]

    def model_hash(self):
        """First 12 hex digits of the sha256 of the frozen fits file: the season's model version, written into every
        forecast so the scorecard refuses to grade a forecast made by a different model."""
        return hashlib.sha256(self.fits.read_bytes()).hexdigest()[:12]

    def archive(self, root: Path) -> Path:
        """This species' archive folder under the live archive root. Luna keeps the root itself (<season>/<issued>.json,
        as before more species), every other species a folder of its own (<key>/<season>/<issued>.json)."""
        return root if self.key == "luna" else root / self.key


# Luna's taxon, as its replay file records it (pipeline/replay/build_replay.py).
LUNA_REPLAY_TAXON = json.loads((ROOT / "src" / "data" / "luna-replay.json").read_text())["species"]["inat_taxon"]

SPECIES = [
    LiveSpecies("luna", "Luna moth", LUNA_REPLAY_TAXON, ROOT / "src" / "data" / "luna-replay.json",
                ROOT / "pipeline" / "replay" / "fold_fits.json", HERE / "effort_profile.json"),
    LiveSpecies("firefly", "Common eastern firefly", _ff_fetch.TAXON, ROOT / "public" / "firefly-replay.json",
                ROOT / "pipeline" / "firefly" / "result.json", HERE / "effort" / "firefly.json", last_doy=_ff_fetch.LAST_DOY),
    *[LiveSpecies(sp.key, sp.name, sp.taxon, sp.replay, sp.result, HERE / "effort" / f"{sp.key}.json", last_doy=sp.last_doy)
      for sp in (_species.get(k) for k in ("japanese-beetle",))],
]
BY_KEY = {s.key: s for s in SPECIES}
LUNA = BY_KEY["luna"]


def get(key: str) -> LiveSpecies:
    if key not in BY_KEY:
        raise SystemExit(f"unknown live species {key!r}; known: {', '.join(BY_KEY)}")
    return BY_KEY[key]
