import { cellToLatLng, getResolution, gridDisk } from 'h3-js';
import { nearby } from '../core/grid';
import { basemapLabels } from '../map/basemap';
import type { MapHandle, Padding, ProbeHit } from '../map/map';

export type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export const AIM: Record<Arrow, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
export const WORD: Record<Arrow, string> = { ArrowRight: 'east', ArrowLeft: 'west', ArrowUp: 'north', ArrowDown: 'south' };

/**
 * The H3 neighbour of `cell` in the arrow's direction (north is up). H3's grid is rotated against the compass, so no
 * neighbour lies due north or due east: of those within 60 degrees of the arrow, up and down take the one nearest the
 * column `col` (a longitude), and left and right the one nearest the row `row` (a latitude), so a run of presses keeps
 * to a straight line, now and then taking the other slanted neighbour to step back onto it. (Taking the best aligned
 * neighbour each time drifts off the row, by a whole hexagon in about ten steps.) `usable` says whether a cell has a
 * forecast: if the neighbour has none (a lake), keep walking that way, for about as far as six of the coarsest
 * hexagons. Null if nothing is found.
 */
export function stepCell(cell: string, arrow: Arrow, col: number, row: number, usable: (cell: string) => boolean): string | null {
  const [dx, dy] = AIM[arrow];
  const vertical = dx === 0;
  // Finer hexagons are smaller steps (each resolution is 1/sqrt(7) as wide): take more of them.
  const reach = Math.ceil(6 * Math.sqrt(7) ** Math.max(0, getResolution(cell) - 4));
  // How far a cell's centre is off the line being walked.
  const off = (c: string) => {
    const [la, ln] = cellToLatLng(c);
    return vertical ? Math.abs(ln - col) : Math.abs(la - row);
  };
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
    const ahead = ring.filter((c) => cos(c) > 0.49).sort((a, b) => off(a) - off(b));
    from = (ahead[0] ?? ring.sort((a, b) => cos(b) - cos(a))[0])!;
    if (usable(from)) return from;
  }
  return null;
}

export interface KeyExploreDeps {
  map: Pick<MapHandle, 'project' | 'focus' | 'zoom' | 'center'>;
  /** The space the panels leave for the map. */
  padding(): Padding;
  /** Whether the species on screen has a forecast at a point today. */
  hasForecast(lngLat: [number, number]): boolean;
  /** The species' hexagon at a point, at the map's current level. */
  cellAt(lngLat: [number, number]): string | null;
  /** The pinned card's hit, or null with nothing pinned. */
  selection(): ProbeHit | null;
  /** The last pinned spot, by any means. */
  lastPin(): [number, number] | null;
  /** Pin the card on this hexagon (shown by show(), once the map has moved to it). */
  select(hit: ProbeHit): void;
  /** Redraw the card. */
  show(): void;
  /** True while something else owns the map (the radar replay): no hexagon to walk under it. */
  busy(): boolean;
  say(text: string): void;
}

/**
 * "Explore map with keys" on `el`: arrows walk a pinned selection hex to hex (the same pinned card, announced by its
 * live region), Enter or Space pins where it starts, Escape lets go (main.ts). It starts at the last pinned hex, or
 * else the middle of the free map, and pans the map when the selection leaves the view. Returns a reset, for a
 * species or season switch. Analogy: a cursor in a spreadsheet, where the cells are hexagons.
 */
export function mountKeyExplore(el: HTMLElement, d: KeyExploreDeps): () => void {
  let col = 0; // the longitude of the column an up or down walk keeps to
  let row = 0; // the latitude of the row a left or right walk keeps to
  // The selection the keys last made. Pinned any other way since, the walk starts afresh from there. (The selection
  // itself, not its hexagon: a zoom swaps the hexagon for one of the new size, and the walk and its count go on.)
  let keyHit: ProbeHit | null = null;
  let steps = 0;
  let nudge = false; // alternates a trailing space, so a repeated message is announced again
  // The free area of the map, inside a margin: where a selected hexagon is in view.
  const inView = (lngLat: [number, number]) => {
    const p = d.padding();
    const at = d.map.project(lngLat);
    return !!at && at[0] > 24 && at[1] > p.top + 24 && at[0] < innerWidth - (p.right ?? 0) - 24 && at[1] < innerHeight - p.bottom - 24;
  };
  // What the card says first, new at every step so a screen reader reads each one: the nearest town in the map's own
  // names (when one is close), and how many steps and which way.
  const where = (lngLat: [number, number], dir: string) => {
    let town = '';
    let best = 0.35 ** 2; // degrees, squared
    for (const [name, lng, lat, , kind] of basemapLabels()) {
      const dd = (lng - lngLat[0]) ** 2 + (lat - lngLat[1]) ** 2;
      if ((kind === 'city' || kind === 'town') && dd < best) (best = dd), (town = name);
    }
    return `${steps ? `Step ${steps} ${dir}` : 'Start'}${town ? `, near ${town}` : ''}`;
  };
  const selectCell = (cell: string, dir = '') => {
    const [la, ln] = cellToLatLng(cell);
    const hit: ProbeHit = { cell, lngLat: [ln, la] };
    hit.note = where(hit.lngLat, dir);
    keyHit = hit;
    // Pinned before the map moves: the move drops any hover card, which must not take this one with it.
    d.select(hit);
    // Off the free area (or near its edge): bring the hexagon to the middle of it, as the town finder does.
    if (!inView(hit.lngLat)) d.map.focus(hit.lngLat, d.map.zoom() ?? 0, d.padding(), true);
    d.show();
  };
  // Where a first key press lands: the last pinned hexagon if it is in view, else the middle of the free map; the
  // nearest hexagon with a forecast, within view, if that spot has none.
  const startCell = (): string | null => {
    const mid = d.map.center(d.padding())?.lngLat;
    const last = d.lastPin();
    const from = last && inView(last) ? last : mid;
    if (!from) return null;
    const at = [{ lngLat: from }, ...nearby(from[1], from[0], 4)].find((h) => inView(h.lngLat) && d.hasForecast(h.lngLat));
    return at ? d.cellAt(at.lngLat) : null;
  };
  // Enter or Space. An arrow comes here too when the pinned card has no forecast hexagon under it (a sighting past
  // the shore, land beyond the Midwest): the arrows can't move that one, so they start a walk from the nearest hexagon
  // rather than say "Already pinned", which would be wrong.
  const pin = (arrowed = false) => {
    if (d.busy()) return;
    if (d.selection() && !arrowed) return d.say('Pinned. Arrow keys move it, Escape lets go.');
    const c = startCell();
    if (!c) return d.say('No forecast in view');
    steps = 0;
    [row, col] = cellToLatLng(c);
    selectCell(c);
  };
  const arrow = (a: Arrow) => {
    if (d.busy()) return;
    const hit = d.selection();
    const from = hit ? d.cellAt(hit.lngLat) : null;
    if (!from) return pin(true);
    if (hit !== keyHit) ([row, col] = cellToLatLng(from)), (steps = 0); // pinned by mouse, tap or town since: start afresh there
    const next = stepCell(from, a, col, row, (c) => d.hasForecast(cellToLatLng(c).reverse() as [number, number]));
    if (!next) return d.say(`No forecast to the ${WORD[a]}${(nudge = !nudge) ? '\u00a0' : ''}`);
    // A new column (left and right) or row (up and down); the walk keeps the other.
    if (a === 'ArrowLeft' || a === 'ArrowRight') col = cellToLatLng(next)[1];
    else row = cellToLatLng(next)[0];
    steps++;
    selectCell(next, WORD[a]);
  };
  // The time slider listens on the window for these same keys (and Home, End): while this has focus it owns them.
  el.addEventListener('keydown', (e) => {
    const move = e.key in AIM;
    const own = move || ['Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key);
    if (e.ctrlKey || e.metaKey || e.altKey || !own) return;
    e.preventDefault();
    e.stopPropagation();
    if (move) arrow(e.key as Arrow);
    else if (e.key === 'Enter' || e.key === ' ') pin();
  });
  return () => ((keyHit = null), (steps = 0));
}
