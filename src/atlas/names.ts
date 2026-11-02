import type { AtlasSpecies } from './index';

/** Plain names for the insect orders in the Atlas, for the tree browse and the cards. */
export const ORDER_NAMES: Record<string, string> = {
  Lepidoptera: 'Butterflies and moths',
  Coleoptera: 'Beetles',
  Diptera: 'Flies',
  Hymenoptera: 'Bees, wasps and ants',
  Hemiptera: 'True bugs',
  Odonata: 'Dragonflies and damselflies',
  Orthoptera: 'Grasshoppers and crickets',
  Neuroptera: 'Lacewings',
  Megaloptera: 'Dobsonflies',
  Blattodea: 'Cockroaches and termites',
  Trichoptera: 'Caddisflies',
  Mantodea: 'Mantises',
  Psocodea: 'Barklice',
  Zygentoma: 'Silverfish',
  Ephemeroptera: 'Mayflies',
  Mecoptera: 'Scorpionflies',
  Phasmida: 'Walkingsticks',
  Dermaptera: 'Earwigs',
};

/** "Eastern Tiger Swallowtail" stays as iNaturalist writes it; a species with no common name goes by its Latin one. */
export const nameOf = (s: AtlasSpecies) => s.common ?? s.name;

/** "Black Fireflies", "Tiger Swallowtails": the name made plural at its last word. */
export function plural(s: AtlasSpecies): string {
  const n = nameOf(s);
  if (!s.common) return `${n} records`;
  // iNaturalist's casing kept ("Carolina Sphinxes"); a name already plural ("Black Saddlebags") stays as it is.
  if (/s$/.test(n)) return n;
  if (/(x|z|ch|sh)$/.test(n)) return `${n}es`;
  if (/[^aeiou]y$/.test(n)) return `${n.slice(0, -1)}ies`;
  return `${n}s`;
}

/**
 * Search the species list. Every word must start a word of the common name, Latin name, genus, family or order (or the
 * order's plain name). Best first, by tier:
 * 4. the whole common name, a featured species' label, or the Latin name, exactly;
 * 3. every word is a whole word of the common name ("luna" in "North American Luna Moth", "cicada" in "Swamp Cicada"),
 *    or a featured species (it has a richer layer) whose name the words start;
 * 2. every word starts a word of the common name ("luna" in "Lunate Zale Moth", "cicada" in "Cicada-killer Wasp");
 * 1. the rest (Latin name, genus, family, order).
 * Within a tier: featured first, then the most records ("bumble": the bumble bees before the Bumble Flower Beetle).
 * `featured` maps a featured species' scientific name to its label ("Actias luna" to "Luna moth").
 */
export function searchSpecies(all: readonly AtlasSpecies[], text: string, featured: ReadonlyMap<string, string> = new Map(), max = 60): AtlasSpecies[] {
  const t = text.toLowerCase().trim().replace(/\s+/g, ' ');
  const words = t.split(' ').filter(Boolean);
  if (!words.length) return [];
  const starts = (h: string, w: string) => h.startsWith(w) || h.includes(` ${w}`) || h.includes(`-${w}`);
  // Whole words split at spaces only: "Cicada-killer" is a wasp, not a cicada.
  const whole = (n: string) => {
    const ws = n.split(' ');
    return words.every((w) => ws.includes(w));
  };
  const scored: { s: AtlasSpecies; tier: number; feat: number }[] = [];
  for (const s of all) {
    const label = featured.get(s.name)?.toLowerCase();
    const names = [(s.common ?? '').toLowerCase(), label ?? ''].filter(Boolean);
    const hay = `${names.join(' ')} ${s.name} ${s.genus ?? ''} ${s.family ?? ''} ${s.order ?? ''} ${ORDER_NAMES[s.order ?? ''] ?? ''}`.toLowerCase();
    if (!words.every((w) => starts(hay, w))) continue;
    const named = names.some((n) => words.every((w) => starts(n, w)));
    const tier = names.includes(t) || s.name.toLowerCase() === t ? 4 : names.some(whole) || (named && label !== undefined) ? 3 : named ? 2 : 1;
    scored.push({ s, tier, feat: label !== undefined ? 1 : 0 });
  }
  return scored
    .sort((a, b) => b.tier - a.tier || b.feat - a.feat || b.s.n - a.s.n)
    .slice(0, max)
    .map((x) => x.s);
}
