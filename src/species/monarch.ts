import type { FrontConfig } from '../layers/frontLayer';
import mark from '../marks/monarch.svg';

/** The monarch (Danaus plexippus), a tracker: built by pipeline/front (`monarch`). */
export const config: FrontConfig = {
  key: 'monarch',
  name: 'Monarch',
  one: 'Monarch',
  adults: 'adult monarchs',
  words: { plural: 'monarchs', sightingsOf: 'monarch', countedAs: 'monarchs', shareName: 'monarchs', mark },
  glow: [236, 112, 16, 255],
  notes: [
    'Monarchs fly back north each spring from Mexico and Texas. In 2018-2025 the usual arrival date was off by about 6 days in Midwest cities, and nothing we tried beat it: wind, warmth, plant growth, or the south’s arrivals.',
  ],
};
