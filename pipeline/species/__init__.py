"""One list of the one-generation species Hatch forecasts with luna's model (pipeline/fit), beyond the luna moth
and the firefly (which keep their own scripts in pipeline/firefly). Adding a species = one entry here, then
`fetch.py <key>`, `build.py <key>` and (optionally) `build_fine.py <key>`; the app's own list is src/species.ts.
"""
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Species:
    key: str             # the app's ?species= value and the folder name under public/species/
    name: str
    sci: str
    taxon: int           # iNaturalist taxon id
    effort_taxon: int    # the effort background: who was out photographing this kind of animal that day
    effort_without: int  # left out of the background (the species itself, so its own boom never counts as effort)
    effort_label: str
    last_doy: int = 240  # one generation: every band's window runs 1 March to this day
    model_id: str = ""

    @property
    def out_dir(self) -> Path:
        return ROOT / "public" / "species" / self.key

    @property
    def replay(self) -> Path:
        return self.out_dir / "replay.json"

    @property
    def result(self) -> Path:
        return ROOT / "pipeline" / "species" / f"{self.key}.result.json"


COLEOPTERA = 47208
LEPIDOPTERA, BUTTERFLIES = 47157, 47224

SPECIES = {s.key: s for s in [
    Species("japanese-beetle", "Japanese beetle", "Popillia japonica", 67760, COLEOPTERA, 67760,
            "beetle records minus Japanese beetles", model_id="japanese-beetle-v0"),
    # Tried in the species check (README.md), not shipped: kept so the comparison can be rerun.
    Species("cecropia", "Cecropia moth", "Hyalophora cecropia", 81582, LEPIDOPTERA, BUTTERFLIES,
            "moth records (Lepidoptera minus butterflies), luna's background", model_id="cecropia-v0"),
]}


def get(key: str) -> Species:
    if key not in SPECIES:
        raise SystemExit(f"unknown species {key!r}; known: {', '.join(SPECIES)}")
    return SPECIES[key]
