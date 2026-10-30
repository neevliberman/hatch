import { cellToLatLng, latLngToCell } from 'h3-js';
import { AtlasGpu } from './gpu';
import { AtlasNet, type ModelMeta, type Place } from './net';
import { ATLAS_YEAR, atlasUrl, json, loadIndex, pickOffSchedule, type AtlasSpecies, type OffSchedule } from './index';

export { ATLAS_YEAR, atlasKey, loadIndex, type AtlasSpecies } from './index';

/**
 * The Living Atlas in the page: its files (public/atlas/, written by pipeline/atlas/export.py), the network, and the
 * map's field (every cell's share of insect photos for one species on one day).
 *
 * Loading is in two steps, so the species picker opens fast: the species list alone (loadIndex), then the network and
 * the cells the first time an Atlas species is drawn (loadAtlas).
 */

import { SEASON, STEP } from './index';
export { SEASON, STEP } from './index';
const STEPS = Math.floor((SEASON[1] - SEASON[0]) / STEP) + 1;
/** How far the "Warm the spring" slider reaches, °F (warm.py F), and the network's own limit on days ahead. */
export const WARM_F = 3;
const CLIP_DAYS = 30;
/** The warmth cells' size (H3 resolution). */
export const ATLAS_RES = 4;

const bin = (f: string): Promise<ArrayBuffer | null> => fetch(atlasUrl(f)).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);

/** seen-YEAR.json: per species [photos seen, photos expected, seen / expected or null, days early or null]. */
interface SeenFile {
  year: number;
  last_day: number;
  photos: number;
  species: [number, number, number | null, number | null][];
}

/** One species' year, expected vs seen (Atlas.seen). */
export interface Seen {
  /** Photos expected and seen every STEP days from SEASON[0], on one scale (0-1, the larger top is 1). */
  expected: number[];
  seen: number[];
  photos: number;
  expectedPhotos: number;
  /** Seen / expected, or null when the gap is within chance. */
  ratio: number | null;
  /** How many days early (negative: late) its season came, or null when within chance. */
  days: number | null;
  /** The last day of the year counted. */
  lastDay: number;
}

/** One photo of a species (dots/<i>.bin, pipeline/atlas/dots.py). */
export interface Dot {
  /** iNaturalist observation id. */
  id: number;
  year: number;
  doy: number;
  /** Its day on a typical year's 365-day calendar: a leap year's days from 29 Feb on move back one (as luna's pdoy). */
  pdoy: number;
  lng: number;
  lat: number;
}

/** The box the dots' positions are scaled across: keep in step with pipeline/atlas/config.py BOX. */
const BOX = { s: 36.5, n: 49.5, w: -97.5, e: -80.5 };

export interface AtlasCell extends Place {
  h: string;
}

export class Atlas {
  readonly cellIndex: Map<string, number>;
  /** Every cell's place inputs, back to back (net.placeFeatures). */
  readonly places: Float32Array;
  private aheads = new Map<number, Promise<Float32Array | null>>();
  private warmth: Promise<Int8Array | null> | null = null;

  constructor(
    readonly net: AtlasNet,
    readonly gpu: AtlasGpu | null,
    readonly species: AtlasSpecies[],
    readonly cells: AtlasCell[],
    private readonly seasonBytes: Uint8Array,
    /** Insect photos on each ribbon day of a typical year, scaled to the busiest (export.py volume). */
    readonly volume: number[],
  ) {
    this.cellIndex = new Map(cells.map((c, i) => [c.h, i]));
    this.places = new Float32Array(cells.length * net.placeDim);
    cells.forEach((c, i) => net.placeFeatures(c, this.places, i * net.placeDim));
  }

  /** A species' expected photos over the map, every STEP days from SEASON[0], scaled to its own top (0-1). */
  season(i: number, year: number | null): number[] {
    const at = (i * 2 + (year === null ? 0 : 1)) * STEPS;
    return [...this.seasonBytes.subarray(at, at + STEPS)].map((v) => v / 255);
  }

  /** "Days ahead" of the typical warmth for every cell on every day of `year`: [cell * 365 + day - 1]. */
  ahead(year: number): Promise<Float32Array | null> {
    let p = this.aheads.get(year);
    if (!p) {
      p = bin(`ahead-${year}.bin`).then((b) => (b ? Float32Array.from(new Int8Array(b), (q) => q / 4) : (this.aheads.delete(year), null)));
      this.aheads.set(year, p);
    }
    return p;
  }

  /** A year's days ahead ([cell * 365 + day - 1]) as every cell's on one day. */
  onDay(base: Float32Array): (day: number) => Float32Array {
    const n = this.cells.length;
    return (day) => {
      const d = Math.min(365, Math.max(1, Math.round(day))) - 1;
      return Float32Array.from({ length: n }, (_, c) => base[c * 365 + d]!);
    };
  }

  /**
   * "Warm the spring": a function giving every cell's days ahead on a day when each day of the spring runs `degF`
   * warmer (negative: cooler), on top of `base` (a year's own days ahead, [cell * 365 + day - 1]; null: a typical
   * year). warm.bin holds the days ahead at ±WARM_F (pipeline/atlas/warm.py); smaller moves scale along the straight
   * line from 0, and the two add. Null while warm.bin is missing.
   */
  async warmed(base: Float32Array | null, degF: number): Promise<((day: number) => Float32Array) | null> {
    this.warmth ??= bin('warm.bin').then((b) => (b ? new Int8Array(b) : ((this.warmth = null), null)));
    const w = await this.warmth;
    if (!w) return null;
    const n = this.cells.length;
    const side = degF < 0 ? 0 : 1;
    const k = Math.abs(degF) / WARM_F / 4; // quarter days
    return (day) => {
      const x = Math.min(STEPS - 1, Math.max(0, (day - SEASON[0]) / STEP));
      const j = Math.min(STEPS - 2, Math.floor(x));
      const f = x - j;
      const out = new Float32Array(n);
      for (let c = 0; c < n; c++) {
        const at = (side * n + c) * STEPS + j;
        const shift = day < SEASON[0] ? 0 : k * (w[at]! + (w[at + 1]! - w[at]!) * f);
        const b = base ? base[c * 365 + Math.min(365, Math.max(1, Math.round(day))) - 1]! : 0;
        out[c] = Math.max(-CLIP_DAYS, Math.min(CLIP_DAYS, b + shift));
      }
      return out;
    };
  }

  /**
   * Expected vs seen in ATLAS_YEAR, over the whole map (pipeline/atlas/seen.py): the photos of a species the network
   * expected from every insect photo of that year, and the ones there were. Fetched the first time it is asked for;
   * null when the files are missing.
   */
  seen(i: number): Promise<Seen | null> {
    this.seenFiles ??= Promise.all([bin(`seen-${ATLAS_YEAR}.bin`), json<SeenFile>(`seen-${ATLAS_YEAR}.json`)]).then(([b, j]) =>
      b && j ? { bytes: new Uint8Array(b), file: j } : ((this.seenFiles = null), null),
    );
    return this.seenFiles.then((f) => {
      const row = f?.file.species[i];
      if (!f || !row) return null;
      const at = i * 2 * STEPS;
      const scaled = (k: number) => [...f.bytes.subarray(at + k * STEPS, at + (k + 1) * STEPS)].map((v) => v / 255);
      return { expected: scaled(0), seen: scaled(1), photos: row[0], expectedPhotos: row[1], ratio: row[2], days: row[3], lastDay: f.file.last_day };
    });
  }
  /** The n species whose ATLAS_YEAR season ran furthest off schedule (>= 50 photos expected): [index, days early (negative: late)]. */
  async offSchedule(n = 10): Promise<OffSchedule> {
    await this.seen(0);
    return pickOffSchedule((await this.seenFiles)?.file.species ?? [], n);
  }
  private seenFiles: Promise<{ bytes: Uint8Array; file: SeenFile } | null> | null = null;

  /** A species' photos as dots (a sample of each part when there are many; see dots.py), sorted by year then day.
   * Fetched per species (every species has a file, empty when it has no photos); null when it failed to load. */
  dots(i: number): Promise<Dot[] | null> {
    return fetch(atlasUrl(`dots/${i}.bin`))
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
      .then((b) => {
        if (!b) return null;
        const n = Math.floor(b.byteLength / 11);
        const id = new Uint32Array(b, 0, n);
        const doy = new Uint16Array(b, 4 * n, n);
        const lat = new Uint16Array(b, 6 * n, n);
        const lng = new Uint16Array(b, 8 * n, n);
        const year = new Uint8Array(b, 10 * n, n);
        return Array.from({ length: n }, (_, k) => {
          const y = 2000 + year[k]!;
          const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
          return {
            id: id[k]!,
            year: y,
            doy: doy[k]!,
            pdoy: leap && doy[k]! >= 60 ? doy[k]! - 1 : doy[k]!,
            lat: BOX.s + (lat[k]! / 65535) * (BOX.n - BOX.s),
            lng: BOX.w + (lng[k]! / 65535) * (BOX.e - BOX.w),
          };
        });
      });
  }

  /** The cell a point falls in (null outside the map). */
  cellAt(lat: number, lng: number): number | null {
    return this.cellIndex.get(latLngToCell(lat, lng, ATLAS_RES)) ?? null;
  }
}

let atlas: Promise<Atlas | null> | null = null;
/** The network and its cells. Fetched once; null when a file is missing. */
export function loadAtlas(): Promise<Atlas | null> {
  atlas ??= Promise.all([json<ModelMeta>('model.json'), bin('model.bin'), loadIndex(), json<{ h: string; dd: number }[]>('cells.json'), bin('season.bin'), json<{ volume: number[] }>('season.json')])
    .then(([meta, raw, sp, cells, season, vol]) => {
      if (!meta || !raw || !sp || !cells || !season || !vol) return null;
      const net = new AtlasNet(meta, raw);
      const placed = cells.map((c) => {
        const [lat, lng] = cellToLatLng(c.h);
        return { h: c.h, lat, lng, dd: c.dd };
      });
      return new Atlas(net, AtlasGpu.create(net), sp, placed, new Uint8Array(season), vol.volume);
    })
    .then((a) => (a ?? (atlas = null), a));
  return atlas;
}

/**
 * One species' field over the map, day by day, worked out on demand and kept. `get` never blocks the frame: a day
 * not worked out yet is queued, the nearest day already done stands in meanwhile, and `onReady` asks for a redraw
 * when it lands. The graphics card does a day in milliseconds; without one, the plain network does it a slice of
 * cells at a time so the page stays responsive.
 */
export class Field {
  private done = new Map<number, Float32Array>();
  private queue: number[] = [];
  /** The day being worked out now, if any. */
  private doing: number | null = null;

  constructor(
    private readonly atlas: Atlas,
    private readonly sp: number,
    /** Every cell's days ahead on a day; null: a typical year. */
    private readonly aheadOn: ((day: number) => Float32Array) | null,
    private readonly onReady: () => void,
  ) {}

  /** Shares (0-1) per cell on `day`, or the nearest day worked out so far (undefined before the first). */
  get(day: number): Float32Array | undefined {
    const d = Math.round(day);
    const have = this.done.get(d);
    if (have) return have;
    if (d !== this.doing && !this.queue.includes(d)) this.queue.unshift(d);
    this.queue.length = Math.min(this.queue.length, 3); // only the latest few asks: a fast scrub skips the days between
    this.pump();
    let best: Float32Array | undefined;
    let gap = Infinity;
    for (const [k, v] of this.done) if (Math.abs(k - d) < gap) (gap = Math.abs(k - d)), (best = v);
    return best;
  }

  private pump(): void {
    if (this.doing !== null) return;
    while (this.queue.length && this.done.has(this.queue[0]!)) this.queue.shift();
    if (!this.queue.length) return;
    const d = (this.doing = this.queue.shift()!);
    const finish = (v: Float32Array) => {
      this.done.set(d, v);
      this.doing = null;
      this.onReady();
      this.pump();
    };
    const { gpu, net, cells, places } = this.atlas;
    const ahead = this.aheadOn?.(d) ?? null;
    // The graphics card, unless its context was lost (it would read back zeros); then the plain network.
    if (gpu && !gpu.lost) {
      setTimeout(() => {
        let v: Float32Array | null = null;
        try {
          v = gpu.run(places, d, ahead, [this.sp])[0]!.map(Math.exp);
        } catch {
          /* falls through to the plain network */
        }
        if (v && !gpu.lost) return finish(v);
        this.doing = null;
        this.queue.unshift(d);
        this.pump();
      }, 0);
      return;
    }
    const out = new Float32Array(cells.length);
    let c = 0;
    const slice = () => {
      const until = performance.now() + 12;
      while (c < cells.length && performance.now() < until) {
        out[c] = Math.exp(net.logShares(cells[c]!, d, ahead ? ahead[c]! : 0)[this.sp]!);
        c++;
      }
      if (c < cells.length) setTimeout(slice, 0);
      else finish(out);
    };
    setTimeout(slice, 0);
  }
}
