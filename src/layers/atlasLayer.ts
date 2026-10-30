import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import { epoch, isDark, palette } from '../theme';
import { dayOfYear, TimeAxis, type TimeSpec } from '../core/timeAxis';
import type { CaveatCard, Due, LegendSpec, ProbeCard, SeasonProfile, SpeciesWords } from '../core/layer';
import { ATLAS_YEAR, atlasKey, Field, SEASON, STEP, type Atlas, type AtlasSpecies, type Dot, type Seen } from '../atlas/atlas';
import { nameOf, plural } from '../atlas/names';
import { TYPICAL, type Mode } from './replayData';
import { animating, ripples } from './motion';
import { GLOW_DAYS, type LunaLayer } from './lunaReplay';
import moth from '../marks/moth.svg';
import beetle from '../marks/japanese-beetle.svg';

type RGBA = [number, number, number, number];

/** The calendar a typical year is drawn on (any year without 29 Feb: the network counts 365 days). */
const TYPICAL_AXIS_YEAR = 2025;
/** The first year the network learned from: keep in step with pipeline/atlas/config.py FIRST_YEAR. */
const FIRST_YEAR = 2015;
const fmt = (year: number, doy: number) =>
  new Date(Date.UTC(year, 0, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "1 in 40": a share as a count of photos. */
export const oneIn = (share: number) => {
  const n = 1 / share;
  const r = n < 20 ? Math.round(n) : n < 200 ? Math.round(n / 5) * 5 : n < 2000 ? Math.round(n / 50) * 50 : Math.round(n / 500) * 500;
  return `1 in ${r.toLocaleString()}`;
};
/** The colour scale spans this many powers of ten below the species' top share (a log scale: shares run from 1 in 10
 * to 1 in 10,000, and a straight scale would leave all but the busiest cells blank). Below it, a cell stays paper. */
const DECADES = 2.5;

/** The dark map's ramp ends: a dim moss, and the lamplit page's own leaf green (#8fd09a). */
const DIM = [70, 92, 58];
const BRIGHT = [143, 208, 154];

const filterExt = [new DataFilterExtension({ filterSize: 1 })];

/** A sketch for the header, by order (the Atlas has no drawing of each species). */
const markOf = (s: AtlasSpecies) =>
  s.order === 'Lepidoptera' ? moth : s.order === 'Coleoptera' ? beetle : new URL(`${import.meta.env.BASE_URL}favicon.svg`, document.baseURI).href;

/**
 * Any species of the Living Atlas on the map: the share of insect photos that would be this species, in each warmth
 * cell, on each day, from one network shared by every species (src/atlas/). The colour is the field itself, with no
 * stages: the model's expectation. The dots are its real photos (Atlas.dots). A typical year, or 2026 with its real
 * warmth sliding each species' season earlier or later by its own clock blend.
 */
export function createAtlasLayer(atlas: Atlas, sp: AtlasSpecies, initial: Mode, onData: () => void): LunaLayer {
  const key = atlasKey(sp.name);
  const name = nameOf(sp);
  const many = plural(sp);
  const words: SpeciesWords = { plural: many, sightingsOf: name, countedAs: many, shareName: many, mark: markOf(sp) };
  const other = atlas.net.nOut - 1;
  let mode: Mode = initial === String(ATLAS_YEAR) ? initial : TYPICAL;
  /** "Warm the spring", °F: every spring day this much warmer (negative: cooler). */
  let warm = 0;
  const yearOf = () => (mode === TYPICAL ? TYPICAL_AXIS_YEAR : ATLAS_YEAR);
  const curve = (m: Mode) => atlas.season(sp.i, m === TYPICAL ? null : ATLAS_YEAR);
  const at = (c: number[], doy: number) => {
    const x = (doy - SEASON[0]) / STEP;
    if (x <= 0 || x >= c.length - 1) return x <= 0 ? c[0]! : c[c.length - 1]!;
    const k = Math.floor(x);
    return c[k]! + (c[k + 1]! - c[k]!) * (x - k);
  };
  const peakDay = (c: number[]) => SEASON[0] + STEP * c.indexOf(Math.max(...c));

  // One run of the season per (season, warmth): its field, and every cell's days ahead on a day (null: a typical year
  // as it was). A run loads its files first (2026's days ahead, the warmth table), so until it lands the nearest one
  // ready stands in: the same season as it was, else the typical year.
  interface Run {
    key: string;
    mode: Mode;
    warm: number;
    field: Field;
    on: ((day: number) => Float32Array) | null;
    base: ((day: number) => Float32Array) | null;
  }
  const keyOf = (m: Mode, w: number) => `${m}|${w}`;
  const BASE = keyOf(TYPICAL, 0);
  const runs = new Map<string, Run>([[BASE, { key: BASE, mode: TYPICAL, warm: 0, field: new Field(atlas, sp.i, null, onData), on: null, base: null }]]);
  const pending = new Set<string>();
  const run = (): Run => runs.get(keyOf(mode, warm)) ?? runs.get(keyOf(mode, 0)) ?? runs.get(BASE)!;
  const ensure = (m: Mode, w: number) => {
    const k = keyOf(m, w);
    if (runs.has(k) || pending.has(k)) return;
    pending.add(k);
    void (async () => {
      const year = m === TYPICAL ? null : await atlas.ahead(ATLAS_YEAR);
      const base = year ? atlas.onDay(year) : null;
      const on = w === 0 ? base : await atlas.warmed(year, w);
      pending.delete(k);
      if ((m !== TYPICAL && !year) || (w !== 0 && !on)) return;
      runs.set(k, { key: k, mode: m, warm: w, field: new Field(atlas, sp.i, on, onData), on, base });
      // Keep the last few: a drag across the slider makes a run per notch.
      for (const old of runs.keys()) if (runs.size > 6 && old !== BASE && old !== k && old !== keyOf(mode, 0) && old !== keyOf(mode, warm)) runs.delete(old);
      onData();
    })();
  };
  ensure(mode, 0);
  const field = () => run().field;
  /** The run the numbers are for. */
  const drawn = () => run().key;
  const aheadAt = (c: number, doy: number) => run().on?.(doy)[c] ?? 0;
  /** How far its season follows warmth: its clock blend's share of the days ahead (0: the calendar alone). */
  const follows = atlas.net.meta.lambdas.reduce((a, l, k) => a + l * atlas.net.clockMix[sp.i * atlas.net.meta.lambdas.length + k]!, 0);
  /** Days earlier (negative: later) the warmth moves its season over the map, around its typical peak. */
  const shift = (r: Run) => {
    if (!r.warm || !r.on) return 0;
    const d = peakDay(curve(TYPICAL));
    const a = r.on(d);
    const b = r.base?.(d);
    let sum = 0;
    for (let c = 0; c < a.length; c++) sum += a[c]! - (b ? b[c]! : 0);
    return (follows * sum) / a.length;
  };
  const cells = atlas.cells.map((c, i) => ({ id: c.h, i }));

  // Expected vs seen in ATLAS_YEAR (Atlas.seen), fetched the first time that year is shown.
  let year: Seen | null = null;
  let askedYear = false;
  const askYear = () => {
    if (askedYear || mode === TYPICAL) return;
    askedYear = true;
    void atlas.seen(sp.i).then((s) => {
      year = s;
      onData();
    });
  };
  askYear();

  // Its photos as dots (Atlas.dots): a typical year draws the years the network learned from, ATLAS_YEAR its own.
  let dots: { past: Dot[]; year: Dot[] } | null = null;
  void atlas.dots(sp.i).then((d) => {
    if (!d) return;
    dots = { past: d.filter((x) => x.year < ATLAS_YEAR), year: d.filter((x) => x.year === ATLAS_YEAR) };
    onData();
  });
  const shownDots = () => (dots ? (mode === TYPICAL ? dots.past : dots.year) : []);
  const litNow = (doy: number) => shownDots().filter((x) => x.pdoy <= doy && x.pdoy > doy - GLOW_DAYS);
  let lit = { key: '', pts: [] as [number, number][] };
  // The GPU gets only the photos of the month around the day (refreshed as the day crosses into the next month), not
  // the whole year: a busy species' 5,000 dots three layers deep cost a software-drawn page seconds.
  let month = { key: '', list: [] as Dot[] };
  const nearDay = (doy: number) => {
    const m = Math.floor(doy / 30);
    const k = `${m}|${mode}|${dots ? 1 : 0}`;
    if (month.key !== k) month = { key: k, list: shownDots().filter((x) => x.pdoy > m * 30 - GLOW_DAYS && x.pdoy <= m * 30 + 31) };
    return month.list;
  };
  let fresh = { key: '', list: [] as Dot[] };
  const rings = ripples<Dot>(`${key}-ripples`, (x) => [x.lng, x.lat], () => palette.dotRim);
  /** "3.4× as many photos as expected, 6 days early for its warmth": its year over the whole map, in a few words. */
  const yearWords = (y: Seen) => {
    if (y.photos < 10 && y.expectedPhotos < 10) return 'too few photos to judge';
    const x = y.ratio === null ? 0 : y.ratio < 9.95 ? Math.round(y.ratio * 10) / 10 : Math.round(y.ratio);
    const r =
      y.ratio === null ? 'about as many photos as expected'
      : y.ratio === 0 ? 'no photos, though some expected'
      : y.ratio < 1 ? `${Math.max(1, Math.round(y.ratio * 100))}% as many photos as expected`
      : `${x}× as many photos as expected`;
    // Early or late for the warmth: the expectation already knows how warm the spring was.
    const d = y.days === null ? '' : `, ${Math.abs(y.days)} day${Math.abs(y.days) === 1 ? '' : 's'} ${y.days > 0 ? 'early' : 'late'} for its warmth`;
    return r + d;
  };

  // On paper, pale sage to deep leaf as the share climbs to the species' top (the forecast's "starting" and "peak"
  // greens): more ink where it is commoner. By lamplight the other way, dim moss to a bright leaf, so more still reads
  // as more against the dark.
  const level = (share: number) => Math.min(1, Math.log10(Math.max(share, 1e-12) / sp.peak) / DECADES + 1);
  const color = (share: number): RGBA => {
    const g = level(share);
    if (g <= 0) return [0, 0, 0, 0];
    const a = isDark() ? DIM : palette.stages.starting;
    const b = isDark() ? BRIGHT : palette.stages.peak;
    return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * g)).concat(Math.round(90 + 150 * g)) as RGBA;
  };
  const css = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;

  // "Also out here": the species most likely in a photo at a cell on a day, worked out on the CPU (milliseconds).
  const near = new Map<string, { i: number; s: number }[]>();
  const ranked = (c: number, doy: number) => {
    const k = `${c}|${doy}|${drawn()}`;
    let r = near.get(k);
    if (!r) {
      const ls = atlas.net.logShares(atlas.cells[c]!, doy, aheadAt(c, doy));
      r = [...ls].map((v, i) => ({ i, s: Math.exp(v) })).sort((a, b) => b.s - a.s);
      if (near.size > 200) near.clear();
      near.set(k, r);
    }
    return r;
  };
  // The species' best day at a cell: the most photos of it expected (its share times the day's usual photos), from a
  // season's worth of days in one pass on the graphics card.
  /** Its share at a cell every STEP days from SEASON[0] (on the graphics card in one pass; else the plain network). */
  const sharesHere = (c: number, on: ((day: number) => Float32Array) | null): number[] => {
    const n = Math.floor((SEASON[1] - SEASON[0]) / STEP) + 1;
    const days = Array.from({ length: n }, (_, j) => SEASON[0] + STEP * j);
    if (!atlas.gpu) return days.map((d) => Math.exp(atlas.net.logShares(atlas.cells[c]!, d, on ? on(d)[c]! : 0)[sp.i]!));
    const P = atlas.net.placeDim;
    const places = new Float32Array(n * P);
    for (let j = 0; j < n; j++) places.set(atlas.places.subarray(c * P, (c + 1) * P), j * P);
    const ahead = on ? Float32Array.from(days, (d) => on(d)[c]!) : null;
    return [...atlas.gpu.run(places, Float32Array.from(days), ahead, [sp.i])[0]!].map(Math.exp);
  };
  const peaks = new Map<string, number>();
  const peakHere = (c: number): number | null => {
    const k = `${c}|${drawn()}`;
    if (peaks.has(k)) return peaks.get(k)!;
    if (!atlas.gpu) return null;
    const photos = sharesHere(c, run().on).map((x, j) => x * atlas.volume[j]!);
    const best = SEASON[0] + STEP * photos.indexOf(Math.max(...photos));
    peaks.set(k, best);
    return best;
  };
  // "Coming out near you": a typical year's expected photos of it at the cell; its season is the days with at least a
  // twentieth of its best day's (so a spring brood counts, not just the bigger summer one). None where it is hardly
  // expected even then.
  const dues = new Map<number, Due | null>();
  const dueHere = (c: number): Due | null => {
    if (dues.has(c)) return dues.get(c)!;
    const shares = sharesHere(c, null);
    const photos = shares.map((x, j) => x * atlas.volume[j]!);
    const top = Math.max(...photos);
    const best = photos.indexOf(top);
    const on = photos.map((p, j) => (p >= top / 20 ? j : -1)).filter((j) => j >= 0);
    const d = shares[best]! < 1e-4 ? null : { start: SEASON[0] + STEP * on[0]!, peak: SEASON[0] + STEP * best, end: SEASON[0] + STEP * on[on.length - 1]! };
    dues.set(c, d);
    return d;
  };
  const shareAt = (c: number, doy: number) => field().get(doy)?.[c] ?? ranked(c, doy).find((r) => r.i === sp.i)!.s;

  const profiles = new Map<string, SeasonProfile>();
  return {
    id: `${key}-atlas`,
    title: name,
    words,
    mode: () => mode,
    setMode(m) {
      mode = m === String(ATLAS_YEAR) ? m : TYPICAL;
      askYear();
      ensure(mode, 0);
      ensure(mode, warm);
    },
    setWarmth(degF) {
      warm = degF;
      ensure(mode, warm);
    },
    warmthNote() {
      const r = run();
      if (!warm || r.warm !== warm) return '';
      const d = shift(r);
      return Math.abs(d) < 0.5 ? 'hardly moves' : `about ${Math.round(Math.abs(d))} day${Math.round(Math.abs(d)) === 1 ? '' : 's'} ${d > 0 ? 'earlier' : 'later'}`;
    },
    seasons: () => [TYPICAL, String(ATLAS_YEAR)],
    live: () => null,
    res: () => 4,
    due([lng, lat]) {
      const c = atlas.cellAt(lat, lng);
      return c === null ? null : dueHere(c);
    },
    cellAt: ([lng, lat]) => {
      const c = atlas.cellAt(lat, lng);
      return c === null ? null : atlas.cells[c]!.h;
    },
    seasonCount: () => 0,
    endNote: ['That was the season.', 'Press replay to watch again'],
    countdown(now) {
      const doy = dayOfYear(now);
      const c = curve(TYPICAL);
      if (at(c, doy) > 0.25) return ['Out now', ''];
      const d = new Date(Date.UTC(new Date(now).getUTCFullYear(), 0, peakDay(c)));
      return [`Peak: about ${d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}`, ''];
    },
    busy: (t) => at(curve(mode), dayOfYear(t)) > 0.3,

    // Its months: the ones around the days it is at least a tenth of its top, 1 March to 31 October at most.
    timeSpec(m, month, day) {
      const year = m === TYPICAL ? TYPICAL_AXIS_YEAR : ATLAS_YEAR;
      const c = curve(m);
      const on = c.map((v, j) => (v > 0.1 ? SEASON[0] + STEP * j : -1)).filter((d) => d > 0);
      const a = new Date(Date.UTC(year, 0, Math.max(SEASON[0], (on[0] ?? SEASON[0]) - 7)));
      const b = new Date(Date.UTC(year, 0, Math.min(SEASON[1], (on[on.length - 1] ?? SEASON[1]) + 7)));
      const start = Date.UTC(year, a.getUTCMonth(), 1);
      const end = Math.min(Date.UTC(year, 0, SEASON[1]), Date.UTC(year, b.getUTCMonth() + 1, 0));
      const asked = month === undefined ? NaN : Date.UTC(year, month, day ?? 1);
      const initial = asked >= start && asked <= end ? asked : Date.UTC(year, 0, peakDay(c));
      return {
        start,
        end,
        stepMs: TimeAxis.DAY,
        initial,
        label: m === TYPICAL ? (ms) => `${fmt(year, dayOfYear(ms))} (typical year)` : undefined,
      } satisfies TimeSpec;
    },

    summary(t) {
      const doy = dayOfYear(t);
      const f = field().get(doy);
      const top = f ? Math.max(...f) : 0;
      const n = litNow(doy).length;
      return `${fmt(yearOf(), doy)}, ${mode === TYPICAL ? 'typical year' : ATLAS_YEAR}. ${name}: ${top > 1e-4 ? `up to ${oneIn(top)} insect photos` : 'hardly expected anywhere'}. ` +
        `${n} photo${n === 1 ? '' : 's'} in the last ${GLOW_DAYS} days${mode === TYPICAL ? ' (all years)' : ''}.`;
    },

    points(t) {
      // The same array back while the dots are unchanged (the place names re-place only when it changes).
      const k = `${dayOfYear(t)}|${mode}|${dots ? 1 : 0}`;
      if (lit.key !== k) lit = { key: k, pts: litNow(dayOfYear(t)).map((x) => [x.lng, x.lat]) };
      return lit.pts;
    },
    newest(t) {
      const k = `${dayOfYear(t)}|${mode}|${dots ? 1 : 0}`;
      if (fresh.key !== k) fresh = { key: k, list: shownDots().filter((x) => x.pdoy === dayOfYear(t)) };
      return fresh.list;
    },

    // The ribbon: its share over the whole map through the season (export.py), one value per day of the range.
    profile() {
      const r = run();
      // In ATLAS_YEAR as it was, the line is the photos expected from that year's own photos, and the green wash the
      // photos seen, on one scale (warmed, the year is no longer the one the photos come from: the plain curve).
      const vs = r.mode !== TYPICAL && !r.warm ? year : null;
      const pk = `${r.key}|${vs ? 1 : 0}|${isDark()}`;
      let p = profiles.get(pk);
      if (!p) {
        const c = curve(r.mode);
        // Warmed, the season's curve slides by the days the warmth moves it (the field itself is the network rerun).
        const by = shift(r);
        const y = yearOf();
        const s = this.timeSpec!(mode);
        const d0 = dayOfYear(s.start);
        const n = Math.round((s.end - s.start) / TimeAxis.DAY) + 1;
        const line = vs ? vs.expected : c;
        const seen = Array.from({ length: n }, (_, j) => at(line, d0 + j + by));
        const top = Math.round(peakDay(line) - by);
        const notes = top >= d0 && top < d0 + n ? [{ at: top - d0, text: `peak ${fmt(y, top)}` }] : [];
        const g = isDark() ? BRIGHT : palette.stages.peak;
        const seenOnly = vs ? [{ color: `rgb(${g[0]},${g[1]},${g[2]})`, seen: Array.from({ length: n }, (_, j) => at(vs.seen, d0 + j)) }] : undefined;
        profiles.set(pk, (p = { bands: [], seen, notes, ...(seenOnly ? { seenOnly } : {}) }));
      }
      return p;
    },

    render({ t, theme, playing, frac }) {
      const doy = dayOfYear(t);
      const f = field().get(doy);
      if (!f) return [];
      const anim = animating(playing);
      const d = anim ? doy + (frac ?? 0) : doy;
      const data = nearDay(doy);
      // Time reaches the dots only through the filter range (a GPU uniform), so scrubbing never re-uploads them.
      const filter = {
        getFilterValue: (x: Dot) => x.pdoy,
        filterRange: [d - GLOW_DAYS + 0.5, d + 0.5] as [number, number],
        filterSoftRange: [d - 0.5, d + 0.5] as [number, number],
        filterTransformSize: true,
        filterTransformColor: true,
        extensions: filterExt,
      };
      // Many lit at once (a common species, or a typical year's eleven years): smaller dots, so they read as dots, not
      // blots over the place names.
      const k = litNow(doy).length > 150 ? 0.7 : 1;
      const dotLayers = data.length
        ? [
            new ScatterplotLayer<Dot>({
              id: `${key}-glow`,
              data,
              getPosition: (x) => [x.lng, x.lat],
              getFillColor: palette.dotShadow,
              radiusUnits: 'pixels',
              getRadius: 9 * k,
              pickable: true, // the soft shadow is the touch target
              ...filter,
            }),
            new ScatterplotLayer<Dot>({
              id: `${key}-halo`,
              data,
              getPosition: (x) => [x.lng, x.lat],
              getFillColor: palette.dotHalo,
              radiusUnits: 'pixels',
              getRadius: 6.5 * k,
              ...filter,
            }),
            new ScatterplotLayer<Dot>({
              id: `${key}-dots`,
              data,
              getPosition: (x) => [x.lng, x.lat],
              getFillColor: palette.moth,
              stroked: true,
              getLineColor: palette.dotRim,
              lineWidthUnits: 'pixels',
              getLineWidth: 1.5,
              radiusUnits: 'pixels',
              getRadius: 4 * k,
              ...filter,
            }),
            ...rings(anim, doy, (from, to) => data.filter((x) => x.pdoy >= from && x.pdoy <= to)),
          ]
        : [];
      return [
        new H3HexagonLayer<{ id: string; i: number }>({
          // Named like the forecast hexagons, so the map draws its lakes and rivers over them and picks them as cells.
          id: `${key}-forecast-r4`,
          data: cells,
          getHexagon: (h) => h.id,
          getFillColor: (h) => color(f[h.i]!),
          getLineColor: (h) => (level(f[h.i]!) <= 0 ? [0, 0, 0, 0] : theme.hexEdge),
          stroked: true,
          filled: true,
          extruded: false,
          highPrecision: true,
          lineWidthMinPixels: 0.6,
          pickable: true,
          updateTriggers: { getFillColor: [f, epoch], getLineColor: [f, epoch] },
        }),
        ...dotLayers,
      ];
    },

    probe(lngLat, t, picked): ProbeCard | null {
      if (picked && (picked.layerId === `${key}-glow` || picked.layerId === `${key}-dots`)) {
        const x = picked.object as Dot;
        return {
          title: `${name} seen ${fmt(x.year, x.doy)}, ${x.year}`,
          lines: [],
          link: { href: `https://www.inaturalist.org/observations/${x.id}`, label: 'Photo on iNaturalist' },
        };
      }
      const c = atlas.cellAt(lngLat[1], lngLat[0]);
      if (c === null) return null;
      const doy = dayOfYear(t);
      const s = shareAt(c, doy);
      const best = peakHere(c);
      const others = ranked(c, doy)
        .filter((r) => r.i !== sp.i && r.i !== other)
        .slice(0, 4)
        .map((r) => {
          const o = atlas.species[r.i]!;
          return { key: atlasKey(o.name), label: nameOf(o), note: oneIn(r.s), img: o.photo ?? undefined };
        });
      return {
        title: s > 1e-4 ? `${name}: ${oneIn(s)} insect photos` : `${name}: hardly expected`,
        swatch: css(color(s)),
        lines: [
          ...(best === null ? [] : [`Best here: around ${fmt(yearOf(), best)}`]),
          ...(mode !== TYPICAL && year ? [`Across the map in ${ATLAS_YEAR}: ${yearWords(year)}`] : []),
        ],
        others: { title: 'Also out here', list: others },
      };
    },

    caveats(): CaveatCard {
      const test =
        sp.test === 1
          ? `Tested on 2026, a season it never saw: it beat ${name}’s own week-by-week calendar.`
          : sp.test === 0
            ? `Tested on 2026, a season it never saw: ${name}’s own week-by-week calendar did better. Read this map loosely.`
            : `Too few 2026 records to test ${name} on its own.`;
      return {
        title: `${name}: fine print`,
        severity: 'normal',
        bullets: [
          `Colors: a model’s expectation, not sightings: of the insect photos taken here on this day, the share that would be ${name}.`,
          `Dots: real iNaturalist photos, each lit ${GLOW_DAYS} days, from ${mode === TYPICAL ? `${FIRST_YEAR}-${ATLAS_YEAR - 1}` : ATLAS_YEAR} (at most 5,000, picked at random).`,
          `One network learns all ${atlas.species.length.toLocaleString()} Midwest insects with 100+ records at once, from 2.1 million iNaturalist photos (2015-2025). ${name}: ${sp.n.toLocaleString()} of them.`,
          test,
          ...(sp.n < 300 ? [`Only ${sp.n.toLocaleString()} records: this forecast is rough.`] : sp.n >= 5000 ? [`Well recorded (${sp.n.toLocaleString()} records).`] : []),
          ...(mode !== TYPICAL && year && year.ratio !== null && year.ratio < 0.6 && year.expectedPhotos >= 10
            ? ['Fewer photos than expected this year. Seen one? Add it on iNaturalist.']
            : []),
          mode === TYPICAL
            ? 'A typical year: the season as it usually runs.'
            : `${ATLAS_YEAR}: each day’s real warmth slides the season earlier or later, as far as this species follows warmth.`,
          ...(mode !== TYPICAL && year
            ? [`On the time bar, the line is the ${ATLAS_YEAR} photos the network expected (from that year’s own photos, through ${fmt(ATLAS_YEAR, year.lastDay)}), the green the ones seen: ${yearWords(year)}. Recent photos are still being named, so hard-to-name species can come up short.`]
            : []),
          ...(warm
            ? [`Spring ${warm > 0 ? '+' : '−'}${Math.abs(warm)} °F: every day’s high and low moved that much, the network rerun. It follows warmth ${follows > 0.66 ? 'closely' : follows > 0.33 ? 'partly' : 'hardly at all'}.`]
            : []),
          'Photos show where people look as well as where insects are.',
        ],
      };
    },

    legend(): LegendSpec {
      const lo = sp.peak * 10 ** -DECADES;
      return {
        title: 'Share of insect photos',
        stops: [0, 0.5, 1].map((g) => ({ color: css(color(lo * 10 ** (g * DECADES) * 1.0001)), label: g === 0 ? oneIn(lo) : oneIn(sp.peak) })),
        items: [{ color: `rgb(${palette.moth[0]},${palette.moth[1]},${palette.moth[2]})`, label: `photo, last ${GLOW_DAYS} days`, shape: 'dot' }],
        note: 'Blank: rarer still.',
      };
    },

    offSeason: () => null,

    credits() {
      const out = [
        { text: 'Insect records: iNaturalist research-grade observations, via GBIF (CC0, CC BY and CC BY-NC).', href: 'https://www.gbif.org/dataset/50c9509d-22c7-4a22-a47d-8c48425ef4a7' },
        { text: 'Warmth: Daymet (ORNL DAAC); 2026 from PRISM via RCC-ACIS.', href: 'https://daymet.ornl.gov/' },
      ];
      if (sp.photo && sp.credit && sp.taxon) out.push({ text: `${name} photo: ${sp.credit}, via iNaturalist.`, href: `https://www.inaturalist.org/taxa/${sp.taxon}` });
      if (sp.taxon) {
        out.push({ text: `Recent ${name} sightings on iNaturalist.`, href: `https://www.inaturalist.org/observations?taxon_id=${sp.taxon}&order_by=observed_on` });
        out.push({ text: 'Seen one? Add it to iNaturalist.', href: 'https://www.inaturalist.org/observations/upload' });
      }
      return out;
    },
  };
}
