// Radar events: real evenings when a weather radar saw insects come off the water. Loaded with the replay code, only
// when someone opens one; the About panel's links come from the short list in ./index.ts (same ids).
// Adding an event: an entry in pipeline/radar/build_radar.py (radar, UTC window), run it to write
// public/radar/<id>/, then an entry here and one in ./index.ts. Check its insect test (meta.json) before it ships.

export interface RadarEvent {
  id: string;
  /** The card's caption after the time: what the echo is, in a few words. */
  caption: string;
  /** Local time zone the times are given in: its name and offset from UTC in hours (no daylight-saving guesswork). */
  tz: { name: string; offset: number };
  /** Behind the card's "How we know" fold. Plain sentences, each one checked against its source. */
  more: string[];
  /** Numbers quoted from the paper, each on its own line. */
  numbers: { lead: string; items: string[] };
  credits: { text: string; href: string }[];
}

export const EVENTS: Record<string, RadarEvent> = {
  'karx-2014-07-20': {
    id: 'karx-2014-07-20',
    caption: 'Mayflies rising off the Mississippi',
    tz: { name: 'CDT', offset: -5 },
    more: [
      'A replay of one evening on the National Weather Service radar at La Crosse, Wisconsin: a weather radar on the ground, one sweep about every 10 minutes. Darker means a stronger echo. The blank centre is left out: up close, echoes off the ground hide insects.',
      'How we know it’s insects: radar can tell raindrops (round, all alike) from insects (long, all different), and this cloud reads as insects, not rain.',
    ],
    numbers: {
      lead: 'Weather radars like this one show mayflies declining (Stepanian et al. 2020):',
      items: ['Upper Mississippi: down 52% from 2012 to 2019', 'Western Lake Erie: down 84% from 2015 to 2019'],
    },
    credits: [
      { text: 'Stepanian et al. 2020, PNAS 117(6): 2987–2992', href: 'https://doi.org/10.1073/pnas.1913598117' },
      { text: 'NOAA NEXRAD data (public domain)', href: 'https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar' },
    ],
  },
};
