import { PathLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import { areNeighborCells, cellsToDirectedEdge, directedEdgeToBoundary, gridDisk } from 'h3-js';
import { palette } from '../theme';

// The forecast front: an amber dashed line where the first individuals are due to come out today, drawn on the shared
// edges between hexagons that have started and neighbours that haven't. Like a weather map's cold front, it shows
// the season as a moving line, not just two colours. Coarse hexagons only (551 cells, so ~1,500 edges).

type Q = readonly (number | null)[] | null | undefined;
type Path = { path: [number, number][] };

/** Every pair of neighbouring cells in `ids`, once, with their shared edge as a [lng, lat] path. */
function edgesOf(ids: readonly string[]) {
  const index = new Map(ids.map((id, i) => [id, i] as const));
  const out: { a: number; b: number; path: [number, number][] }[] = [];
  ids.forEach((id, a) => {
    for (const n of gridDisk(id, 1)) {
      const b = index.get(n);
      if (b === undefined || b <= a || !areNeighborCells(id, n)) continue;
      out.push({ a, b, path: directedEdgeToBoundary(cellsToDirectedEdge(id, n)).map(([lat, lng]) => [lng, lat]) });
    }
  });
  return out;
}

/** A front drawer for one grid. Call it with the day's forecast quantiles (q05 first) and day of year. */
export function makeFront(ids: readonly string[], id: string) {
  let edges: ReturnType<typeof edgesOf> | null = null; // built the first time a front is drawn
  const memo = new WeakMap<readonly Q[], Map<number, Path[]>>();
  const pathsFor = (qs: readonly Q[], doy: number): Path[] => {
    let days = memo.get(qs);
    if (!days) memo.set(qs, (days = new Map()));
    let paths = days.get(doy);
    if (!paths) {
      edges ??= edgesOf(ids);
      const out = (i: number) => {
        const q05 = qs[i]?.[0];
        return q05 != null && doy >= q05;
      };
      // A lone hexagon (out among neighbours that aren't, or the reverse) is a blip, not the front: no ring around it.
      const like = new Uint8Array(qs.length);
      for (const e of edges) if (out(e.a) === out(e.b)) like[e.a] = like[e.b] = 1;
      const has = (i: number) => qs[i]?.[0] != null; // a hexagon with no forecast is not the front's other side
      paths = edges.filter((e) => has(e.a) && has(e.b) && out(e.a) !== out(e.b) && like[e.a] && like[e.b]).map((e) => ({ path: e.path }));
      days.set(doy, paths);
    }
    return paths;
  };
  return (qs: readonly Q[], doy: number) =>
    new PathLayer<Path, PathStyleExtensionProps<Path>>({
      id,
      data: pathsFor(qs, doy),
      getPath: (d) => d.path,
      getColor: palette.front,
      getWidth: 2.5,
      widthUnits: 'pixels',
      capRounded: true,
      getDashArray: [3, 2],
      dashJustified: true,
      extensions: [new PathStyleExtension({ dash: true })],
      pickable: false,
      updateTriggers: { getColor: [palette.front] },
    });
}
