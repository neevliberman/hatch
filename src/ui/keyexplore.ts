import { cellToLatLng, gridDisk } from 'h3-js';

export type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export const AIM: Record<Arrow, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/**
 * The H3 neighbour of `cell` that lies most nearly in the arrow's direction (north is up). Left and right have one
 * exact neighbour; up and down have two equally good ones, so the one nearest `prevLng` wins and a run of presses
 * climbs a straight column instead of zigzagging. `usable` says whether a cell has a forecast: if the nearest
 * neighbour has none (sea, outside the map), keep walking that way, up to a few cells, and give up with null.
 */
export function stepCell(cell: string, arrow: Arrow, prevLng: number, usable: (cell: string) => boolean): string | null {
  const [dx, dy] = AIM[arrow];
  for (let i = 0, from = cell; i < 6; i++) {
    const [la, ln] = cellToLatLng(from);
    const k = Math.cos((la * Math.PI) / 180);
    const score = (c: string) => {
      const [la2, ln2] = cellToLatLng(c);
      const x = (ln2 - ln) * k;
      const y = la2 - la;
      // Direction match in whole percent (so two equal neighbours tie), less how far it is from the column the walk came from, in degrees.
      return Math.round(((x * dx + y * dy) / Math.hypot(x, y)) * 100) - Math.abs(ln2 - prevLng);
    };
    from = gridDisk(from, 1).filter((c) => c !== from).sort((a, b) => score(b) - score(a))[0]!;
    if (usable(from)) return from;
  }
  return null;
}
