// Radar replays: the only part that ships in the page is this short list of links (for the About panel). The replay's
// code (./radarReplay.ts, with its own map layer) and each event's frames (public/radar/<id>/) load when one is opened.
// One entry per event in ./events.ts, same id; a few words each, as the About panel lists them side by side.
export const RADAR_HEAD = 'Mayfly hatches on radar';
export const RADAR_LINKS: { id: string; label: string; title: string }[] = [
  { id: 'karx-2014-07-20', label: 'Mississippi, 2014', title: 'The Mississippi at La Crosse, Wisconsin, 20 July 2014' },
  { id: 'kdvn-2012-06-23', label: 'Quad Cities, 2012', title: 'The Mississippi at Davenport, Iowa, on the Quad Cities radar, 23 June 2012' },
  { id: 'kcle-2019-06-26', label: 'Lake Erie, 2019', title: 'Western Lake Erie, on the Cleveland radar, 26 June 2019' },
];

/** The species a replay's map shows while it is up (main.ts), in place of whatever was on screen: the Atlas's Giant
 * Mayfly, the one burrowing mayfly (Hexagenia, what these hatches are) it knows. */
export const RADAR_SPECIES = { key: 'hexagenia-limbata', label: 'Giant Mayfly' };
/** A replay's calendar day, [month (0-11), day], from its id ("karx-2014-07-20"). */
export const radarDay = (id: string): [number, number] | null => {
  const m = /-(\d{4})-(\d\d)-(\d\d)$/.exec(id);
  return m ? [Number(m[2]) - 1, Number(m[3])] : null;
};
