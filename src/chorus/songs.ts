/**
 * What each singing insect in the Atlas sounds like, from published song traits (carrier pitch, how the song is
 * built, how fast it runs at 25 °C, how warm it must be to sing, when in the day). Sounds are synthesised from these
 * numbers, never recorded.
 *
 * Analogy: sheet music with the tempo marked in degrees. Warm the room and the whole band plays faster: Dolbear's
 * law, the old rule that a snowy tree cricket's chirps per 15 s plus 40 is the temperature in °F, comes to about a
 * doubling of tempo per 10 °C, and that one rule sets every singer's pace here (Q10 = 2).
 */

export type Shape = 'trill' | 'chirp' | 'rasp' | 'tick' | 'buzz' | 'drone';

export interface Song {
  shape: Shape;
  /** Carrier pitch, Hz. */
  hz: number;
  /** Events per second at 25 °C (a chirp, a rasp, a tick group); for trill, buzz and drone the pulse rate inside. */
  rate: number;
  /** Pulses inside one chirp, rasp or tick group. */
  pulses: number;
  /** Coolest air it will sing in, °C. */
  minC: number;
  /** Hours of the day it sings, [from, to), wrapping midnight. */
  hours: [number, number];
  /** Plain-words sound, for the roll. */
  word: string;
}

const NIGHT: [number, number] = [19, 5];
const ALL: [number, number] = [0, 24];

const TREE: Song = { shape: 'trill', hz: 2900, rate: 48, pulses: 1, minC: 12, hours: NIGHT, word: 'trill' };
const FIELD: Song = { shape: 'chirp', hz: 4700, rate: 2.6, pulses: 3, minC: 9, hours: ALL, word: 'chirp' };
const BUSH: Song = { shape: 'chirp', hz: 4200, rate: 1.4, pulses: 2, minC: 12, hours: NIGHT, word: 'chirp' };
const KATYDID: Song = { shape: 'rasp', hz: 2600, rate: 0.7, pulses: 3, minC: 15, hours: [20, 4], word: 'rasp' };
const TICKER: Song = { shape: 'tick', hz: 6800, rate: 0.8, pulses: 3, minC: 15, hours: NIGHT, word: 'tick' };
const MEADOW: Song = { shape: 'buzz', hz: 7500, rate: 90, pulses: 1, minC: 15, hours: [9, 24], word: 'buzz' };
const CONEHEAD: Song = { shape: 'buzz', hz: 8200, rate: 55, pulses: 1, minC: 17, hours: [19, 4], word: 'buzz' };
const CICADA: Song = { shape: 'drone', hz: 6300, rate: 190, pulses: 1, minC: 22, hours: [10, 20], word: 'drone' };

/** By Latin name; species not listed here do not sing (grasshoppers rub quietly; moths and beetles are silent). */
const BY_NAME: Record<string, Song> = {
  'Oecanthus niveus': TREE,
  'Oecanthus latipennis': { ...TREE, hz: 2400, rate: 40 },
  'Oecanthus pini': { ...TREE, hz: 3100, rate: 55 },
  'Oecanthus forbesi': { ...TREE, hz: 2800, rate: 50 },
  'Neoxabea bipunctata': { ...TREE, hz: 2600, rate: 34 },
  'Gryllus pennsylvanicus': FIELD,
  'Velarifictorus micado': { ...FIELD, hz: 4500, rate: 2.2 },
  'Hapithus saltator': BUSH,
  'Hapithus agitator': { ...BUSH, hz: 3900 },
  'Phyllopalpus pulchellus': { shape: 'trill', hz: 5400, rate: 38, pulses: 1, minC: 15, hours: [14, 4], word: 'bell trill' },
  'Anaxipha exigua': { shape: 'trill', hz: 6600, rate: 70, pulses: 1, minC: 15, hours: NIGHT, word: 'trill' },
  'Camptonotus carolinensis': { ...BUSH, hz: 3400, rate: 1.1 },
  'Neocurtilla hexadactyla': { shape: 'trill', hz: 1900, rate: 30, pulses: 1, minC: 10, hours: NIGHT, word: 'purr' },
  'Pterophylla camellifolia': KATYDID,
  'Microcentrum rhombifolium': { ...TICKER, hz: 5200, rate: 0.6, pulses: 2 },
  'Microcentrum retinerve': { ...TICKER, hz: 5600, rate: 0.7, pulses: 2 },
  'Scudderia furcata': { ...TICKER, hz: 7200, rate: 0.9, pulses: 2 },
  'Scudderia septentrionalis': { ...TICKER, hz: 7000, rate: 0.9, pulses: 3 },
  'Amblycorypha oblongifolia': { ...KATYDID, hz: 3300, rate: 0.9, pulses: 2 },
  'Conocephalus brevipennis': MEADOW,
  'Conocephalus fasciatus': { ...MEADOW, hz: 8000 },
  'Conocephalus strictus': { ...MEADOW, hz: 7000 },
  'Conocephalus nemoralis': { ...MEADOW, hz: 7200 },
  'Orchelimum nigripes': { ...MEADOW, hz: 7000, rate: 110 },
  'Orchelimum vulgare': { ...MEADOW, hz: 7200, rate: 110 },
  'Neoconocephalus retusus': CONEHEAD,
  'Neoconocephalus ensiger': { ...CONEHEAD, hz: 7600, rate: 70 },
  'Roeseliana roeselii': { ...MEADOW, hz: 9000, rate: 140, hours: [8, 24] },
  'Neotibicen pruinosus': CICADA,
  'Neotibicen tibicen': { ...CICADA, hz: 5900 },
  'Neotibicen lyricen': { ...CICADA, hz: 6100 },
  'Neotibicen canicularis': { ...CICADA, hz: 6500, rate: 210 },
  'Neotibicen linnei': { ...CICADA, hz: 6000 },
  'Neotibicen robinsonianus': { ...CICADA, hz: 6200 },
  'Neotibicen aurifer': { ...CICADA, hz: 6400 },
  'Megatibicen pronotalis': { ...CICADA, hz: 5600, rate: 170 },
  'Megatibicen dorsatus': { ...CICADA, hz: 5400, rate: 160 },
  'Diceroprocta grossa': { ...CICADA, hz: 6800, hours: [17, 22], minC: 20 },
  'Magicicada septendecim': { ...CICADA, hz: 1400, rate: 120, minC: 20, hours: [9, 20] },
  'Magicicada tredecassini': { ...CICADA, hz: 1500, rate: 130, minC: 20, hours: [9, 20] },
  'Magicicada neotredecim': { ...CICADA, hz: 1500, rate: 130, minC: 20, hours: [9, 20] },
  'Magicicada cassini': { ...CICADA, hz: 7000, rate: 150, minC: 20, hours: [9, 20] },
  'Magicicada septendecula': { ...CICADA, hz: 7200, rate: 150, minC: 20, hours: [9, 20] },
};

export const songFor = (latin: string): Song | null => BY_NAME[latin] ?? null;

/** Q10 = 2: events and pulses run twice as fast 10 °C warmer. Zero below the singer's coolest air. */
export function tempo(song: Song, c: number): number {
  return c < song.minC ? 0 : 2 ** ((c - 25) / 10);
}

/** 0-1: how much of the day this song is on at `hour` (a soft shoulder of 1 h at each end). */
export function hourWeight(song: Song, hour: number): number {
  const [a, b] = song.hours;
  const span = (b - a + 24) % 24 || 24;
  const x = (hour - a + 24) % 24;
  if (x >= span) return 0;
  return Math.min(1, x / 1, (span - x) / 1);
}

/** °C to °F. */
export const toF = (c: number): number => (c * 9) / 5 + 32;
