import type { FrontConfig } from '../layers/frontLayer';
import mark from '../marks/red-admiral.svg';

/** The red admiral (Vanessa atalanta), a tracker: built by pipeline/front (`red-admiral`). */
export const config: FrontConfig = {
  key: 'red-admiral',
  name: 'Red admiral',
  one: 'Red admiral',
  adults: 'adult red admirals',
  words: { plural: 'red admirals', sightingsOf: 'red admiral', countedAs: 'red admirals', shareName: 'red admirals', mark },
  glow: [196, 36, 56, 255],
  notes: [
    'Red admirals drift north in spring, in big waves some years (2023, 2024). Warmth did not predict them, but once they show up in St. Louis, Indianapolis and Columbus the north follows within days (about 4, on average).',
  ],
};
