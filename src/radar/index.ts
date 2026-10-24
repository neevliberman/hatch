// Radar replays: the only part that ships in the page is this short list of links (for the About panel). The replay's
// code (./radarReplay.ts, with its own map layer) and each event's frames (public/radar/<id>/) load when one is opened.
// One entry per event in ./events.ts, same id; a few words each, as the About panel lists them side by side.
export const RADAR_HEAD = 'Real mayfly hatches on radar';
export const RADAR_LINKS: { id: string; label: string; title: string }[] = [
  { id: 'karx-2014-07-20', label: 'Mississippi, 2014', title: 'The Mississippi at La Crosse, Wisconsin, 20 July 2014' },
  { id: 'kcle-2019-06-26', label: 'Lake Erie, 2019', title: 'Western Lake Erie, on the Cleveland radar, 26 June 2019' },
];
