import { cellToLatLng, getResolution, gridDisk } from 'h3-js';

export type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export const AIM: Record<Arrow, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
export const WORD: Record<Arrow, string> = { ArrowRight: 'east', ArrowLeft: 'west', ArrowUp: 'north', ArrowDown: 'south' };

/**
 * The H3 neighbour of `cell` in the arrow's direction (north is up). H3's grid is rotated against the compass, so no
 * neighbour lies due north: of those within 60 degrees of the arrow, left and right take the best aligned, and up and
 * down take the one nearest the column `col` (a longitude), so a run of presses climbs a straight line, alternating
 * between the two slanted neighbours. `usable` says whether a cell has a forecast: if the neighbour has none (a lake),
 * keep walking that way, for about as far as six of the coarsest hexagons. Null if nothing is found.
 */
export function stepCell(cell: string, arrow: Arrow, col: number, usable: (cell: string) => boolean): string | null {
  const [dx, dy] = AIM[arrow];
  const vertical = dx === 0;
  // Finer hexagons are smaller steps (each resolution is 1/sqrt(7) as wide): take more of them.
  const reach = Math.ceil(6 * Math.sqrt(7) ** Math.max(0, getResolution(cell) - 4));
  const lng = (c: string) => cellToLatLng(c)[1];
  for (let i = 0, from = cell; i < reach; i++) {
    const [la, ln] = cellToLatLng(from);
    const k = Math.cos((la * Math.PI) / 180);
    const cos = (c: string) => {
      const [la2, ln2] = cellToLatLng(c);
      const x = (ln2 - ln) * k;
      const y = la2 - la;
      return (x * dx + y * dy) / Math.hypot(x, y);
    };
    const ring = gridDisk(from, 1).filter((c) => c !== from);
    const ahead = ring.filter((c) => cos(c) > 0.49).sort(vertical ? (a, b) => Math.abs(lng(a) - col) - Math.abs(lng(b) - col) : (a, b) => cos(b) - cos(a));
    from = (ahead[0] ?? ring.sort((a, b) => cos(b) - cos(a))[0])!;
    if (usable(from)) return from;
  }
  return null;
}
