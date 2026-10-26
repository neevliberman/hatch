// Radar events: real evenings when a weather radar saw insects come off the water. Loaded with the replay code, only
// when someone opens one; the About panel's links come from the short list in ./index.ts (same ids).
// Adding an event: an entry in pipeline/radar/build_radar.py (radar, UTC window), run it to write
// public/radar/<id>/, then an entry here and one in ./index.ts. Check its insect test (meta.json) before it ships.
// The evidence for each one (news of the night, the radar's own numbers) is in pipeline/radar/README.md.

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
      'One evening on the National Weather Service radar at La Crosse, Wisconsin, one sweep about every 10 minutes. Darker means a stronger echo. The blank center is left out: ground echoes hide insects up close.',
      'Radar tells raindrops (round, all alike) from insects (long, all different). This cloud reads as insects.',
    ],
    numbers: {
      lead: 'Radar shows mayflies declining (Stepanian et al. 2020):',
      items: ['Upper Mississippi: down 52% from 2012 to 2019', 'Western Lake Erie: down 84% from 2015 to 2019'],
    },
    credits: [
      { text: 'Stepanian et al. 2020, PNAS 117(6): 2987–2992', href: 'https://doi.org/10.1073/pnas.1913598117' },
      { text: 'NOAA NEXRAD data (public domain)', href: 'https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar' },
    ],
  },
  'kdvn-2012-06-23': {
    id: 'kdvn-2012-06-23',
    caption: 'Echoes consistent with mayflies on the river; storms and clutter elsewhere',
    tz: { name: 'CDT', offset: -5 },
    more: [
      'One evening on the National Weather Service radar at Davenport, Iowa, one sweep about every 4 minutes. After 9 pm a narrow cloud forms along the river north of the Quad Cities and drifts north. Darker means a stronger echo. The blank center is left out. Other echoes are not mayflies.',
      'Radar tells raindrops (round, all alike) from insects (long, all different). Along the river the echo reads as insects, consistent with a mayfly emergence. It is not a count.',
    ],
    numbers: {
      lead: 'Radar shows mayflies declining (Stepanian et al. 2020):',
      items: ['Upper Mississippi: down 52% from 2012 to 2019', 'Western Lake Erie: down 84% from 2015 to 2019'],
    },
    credits: [
      { text: 'Stepanian et al. 2020, PNAS 117(6): 2987–2992', href: 'https://doi.org/10.1073/pnas.1913598117' },
      { text: 'NWS La Crosse, mayfly radar events (23 June 2012)', href: 'https://www.weather.gov/arx/mayfly_tracking' },
      { text: 'NOAA NEXRAD data (public domain)', href: 'https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar' },
    ],
  },
  'kcle-2019-06-26': {
    id: 'kcle-2019-06-26',
    caption: 'Mayflies rising off Lake Erie',
    tz: { name: 'EDT', offset: -4 },
    more: [
      'One evening on the National Weather Service radar at Cleveland, Ohio, one sweep about every 7 minutes. After dark the cloud rises over the lake’s western islands and drifts east. Darker means a stronger echo. The blank center is left out.',
      'Radar tells raindrops (round, all alike) from insects (long, all different). This cloud reads as insects.',
    ],
    numbers: {
      lead: 'Radar shows mayflies declining (Stepanian et al. 2020):',
      items: ['Western Lake Erie: down 84% from 2015 to 2019', 'Upper Mississippi: down 52% from 2012 to 2019'],
    },
    credits: [
      { text: 'Stepanian et al. 2020, PNAS 117(6): 2987–2992', href: 'https://doi.org/10.1073/pnas.1913598117' },
      { text: 'NOAA NEXRAD data (public domain)', href: 'https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar' },
    ],
  },
};
