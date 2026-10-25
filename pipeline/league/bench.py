"""The bench: challenger models that forecast every night beside the map's model, sealed but never shown.

Analogy: a sports league. The map's model is the starter (the "champion"); each model here plays every game from the
bench. Its nightly forecast is made on the same weather, written into the night's live file and archived with a
date (a sealed envelope), and graded weekly against the champion (weekly.py). It can take the map only between
seasons, and only by the rule in rules.py.

Adding a challenger: an entry in BENCH, with its frozen fits file, before the season it starts in (1 March). It must
have passed its tryout on past seasons first (README.md); the tryout only buys a bench spot, never the map.
"""
import dataclasses
import datetime as dt
import hashlib
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "notebooks"))
sys.path.insert(0, str(ROOT / "pipeline"))


@dataclass(frozen=True)
class Challenger:
    id: str                 # model id written into its forecasts, e.g. "p3.1-v1"
    species: str            # registry key of the species it forecasts (its champion is that species' live model)
    fits: Path              # frozen fits, same layout as the champion's (fold_fits.json or a species result.json)
    archive: str            # its archive folder, beside the champion's (live/<archive>/<season>/<issued>.json)
    first_season: int       # the first season it shadows; it is graded from then on
    verdict: dt.date        # the Monday its season's head-to-head is decided (rules.py)
    gate: str               # the extra check it must pass to win, written before its first season (rules.py)
    why: str                # one line: what it is

    @property
    def slug(self):
        return f"{self.species}~{self.id}"

    def model_hash(self):
        """First 12 hex digits of the sha256 of its fits file, as the champion's (registry.LiveSpecies.model_hash)."""
        return hashlib.sha256(self.fits.read_bytes()).hexdigest()[:12]

    def live_species(self):
        """The champion's live species with this challenger's fits swapped in: same replay file (cells, cut-offs,
        strip weights, past errors), same effort profile, same taxon."""
        from live import registry
        return dataclasses.replace(registry.get(self.species), key=self.slug, fits=self.fits)

    def archive_dir(self, archive_root: Path) -> Path:
        """Its archive folder, given the champion's archive root (live/archive -> live/<archive>)."""
        return Path(archive_root).parent / self.archive


BENCH = [
    # P3 vs P3.1, pre-registered in pipeline/fit/PREREG_2027.md: archive folder, verdict date and the 2026 gate are
    # that file's. The map stays P3 through 2027 whatever happens; a win puts P3.1 on the map for 2028.
    Challenger("p3.1-v1", "luna", ROOT / "pipeline" / "replay" / "fold_fits_p31.json", "archive_p31",
               2027, dt.date(2027, 9, 27), "daymet-2026",
               "P3.1: P3 without the daylength term, warmth targets kept above zero"),
]
BY_SLUG = {c.slug: c for c in BENCH}


def tonight(season, species_keys=None):
    """The challengers that forecast this season (for the species being run tonight)."""
    return [c for c in BENCH if c.first_season <= season and (species_keys is None or c.species in species_keys)]


def shadow_entry(live_entry, ch: Challenger):
    """What a night keeps of a challenger's forecast: the strip dates the scorecard grades, the model, and when.
    Small (about 1 KB), so it rides in the public live file without slowing the map."""
    keep = ("version", "season", "generated", "as_of", "forecast_through", "backfill", "model", "bands")
    e = {k: live_entry[k] for k in keep}
    e["species"], e["challenger"] = ch.species, ch.id
    return e
