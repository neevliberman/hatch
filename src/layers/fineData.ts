import { cellToChildren, cellToParent, splitLongToH3Index } from 'h3-js';

/**
 * Finer forecast hexes (res 5 and 6) for zoomed-in views, built by pipeline/replay/build_fine.py into public/fine/.
 * Same forecast as the res-4 map, at each finer hex's own 1 km temperatures. Fetched lazily, one file per level for
 * the cell list and one per level and season for the days, so a phone only downloads what it zooms into.
 *
 * Only over http(s): the one-file preview build opened from disk has no files beside it, so it stays at res 4
 * (and never makes a request that would fail or count as external).
 */
export const FINE_PARENT_RES = 4;

interface Manifest {
  version: number;
  offset: number;
  never: number;
  modes: string[];
  parent_res: number;
  levels: Record<string, { cells: number }>;
}

export interface FineLevel {
  res: number;
  cells: string[];
  /** 1 if the res-4 hexagon this cell sits in has a luna sighting in it or next to it. */
  seen: Uint8Array;
  index: Map<string, number>;
}

export const fineAvailable = () => typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

/** One species' finer hexes, in a folder next to the page ('fine/' for luna, 'fine-firefly/' for the firefly). */
export function fineSource(dir: string) {
  const base = () => new URL(dir, document.baseURI).href;
  let manifest: Promise<Manifest | null> | null = null;
  const levels = new Map<number, Promise<FineLevel | null>>();
  const modes = new Map<string, Promise<Uint8Array | null>>();

  const get = async (path: string): Promise<ArrayBuffer | null> => {
    try {
      const r = await fetch(base() + path);
      return r.ok ? await r.arrayBuffer() : null;
    } catch {
      return null;
    }
  };

  /** Which fine levels exist (null when none, or not served over http). */
  function fineManifest(): Promise<Manifest | null> {
    if (!fineAvailable()) return Promise.resolve(null);
    manifest ??= get('manifest.json').then((b) => {
      if (!b) return null;
      try {
        const m = JSON.parse(new TextDecoder().decode(b)) as Manifest;
        return m.version === 1 ? m : null;
      } catch {
        return null;
      }
    });
    return manifest;
  }

  function fineLevel(res: number): Promise<FineLevel | null> {
    let p = levels.get(res);
    if (!p) {
      p = fineManifest().then(async (m) => {
        if (!m?.levels[String(res)]) return null;
        const b = await get(`r${res}/cells.bin`);
        try {
          return b ? decodeCells(b) : null;
        } catch {
          return null;
        }
      });
      levels.set(res, p);
    }
    return p;
  }

  /** Days for one level and season: 5 bytes per cell (day of year minus offset; `never` = not reached). */
  function fineDays(res: number, mode: string): Promise<Uint8Array | null> {
    const key = `${res}/${mode}`;
    let p = modes.get(key);
    if (!p) {
      p = fineManifest().then(async (m) => {
        if (!m?.levels[String(res)] || !m.modes.includes(mode)) return null;
        const b = await get(`r${res}/${mode}.bin`);
        return b ? new Uint8Array(b) : null;
      });
      modes.set(key, p);
    }
    return p;
  }

  return { fineManifest, fineLevel, fineDays };
}

export const { fineManifest, fineLevel, fineDays } = fineSource('fine/');

/** Decode cells.bin (format in build_fine.py): parents, child masks, seen bits. */
export function decodeCells(buf: ArrayBuffer): FineLevel {
  const v = new DataView(buf);
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (magic !== 'HXC1') throw new Error('not a fine-cells file');
  const res = v.getUint8(4);
  const nb = v.getUint16(6, true);
  const P = v.getUint32(8, true);
  const N = v.getUint32(12, true);
  let o = 16;
  const parents: string[] = [];
  for (let i = 0; i < P; i++, o += 8) parents.push(splitLongToH3Index(v.getUint32(o, true), v.getUint32(o + 4, true)));
  const cells: string[] = [];
  for (const p of parents) {
    // H3 ids at one resolution are equal-length hex strings, so string order is numeric order.
    const kids = cellToChildren(p, res).sort();
    for (let k = 0; k < kids.length; k++) if (v.getUint8(o + (k >> 3)) & (1 << (k & 7))) cells.push(kids[k]!);
    o += nb;
  }
  if (cells.length !== N) throw new Error('fine-cells count mismatch');
  const bits = new Uint8Array(buf, o, (N + 7) >> 3);
  const seen = new Uint8Array(N);
  for (let i = 0; i < N; i++) seen[i] = (bits[i >> 3]! >> (i & 7)) & 1;
  return { res, cells, seen, index: new Map(cells.map((c, i) => [c, i] as const)) };
}

/** Quantile days of cell i, as the res-4 file has them (null = never). */
export function fineQ(days: Uint8Array, i: number, offset = 60, never = 255): (number | null)[] {
  const out: (number | null)[] = [];
  for (let k = 0; k < 5; k++) {
    const b = days[i * 5 + k]!;
    out.push(b === never ? null : b + offset);
  }
  return out;
}

export const parentOf = (cell: string) => cellToParent(cell, FINE_PARENT_RES);
