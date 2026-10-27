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

/** "fireflies", "swallowtails", "moths": the last word made plural, lower case. */
export function plural(s: AtlasSpecies): string {
  const n = nameOf(s);
  if (!s.common) return `${n} records`;
  const w = n.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}
