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
