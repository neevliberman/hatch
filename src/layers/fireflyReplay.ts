import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension, FillStyleExtension, type FillStyleExtensionProps } from '@deck.gl/extensions';
import { latLngToCell } from 'h3-js';
import { palette } from '../theme';
import { GRID_RES } from '../core/grid';
import { dayOfYear } from '../core/timeAxis';
import type { CaveatCard, Explainer, LegendSpec, OffSeasonNote, ProbeCard, SeasonProfile, SpotStory } from '../core/layer';
import { restingSketch } from '../ui/sketch';
import { doyToMs, type ReplayFile } from './lunaData';
import { APPROXIMATE, replayData, TYPICAL, type Mode, type Sighting } from './replayData';
import { animating, hexFade, ripples } from './motion';
import { fineQ, fineSource, parentOf, type FineLevel } from './fineData';
import { FINE_ZOOM, GLOW_DAYS, modeLabel, seasonProfile, STAGE_LABEL, STRIPE_MAPPING, stripes, washer, type LunaLayer } from './lunaReplay';
import { isAsleep, isBusy, MIDWEST_MARGIN, onPaper, stageAt, stageCounts, STAGES, type Stage } from './stages';
import mark from '../marks/firefly.svg';

/**
 * The common eastern firefly, Hatch's second species (built by pipeline/firefly/build_firefly.py).
 * Same file format and forecast as the luna moth, with one generation a year (no second wave) and only the big
 * hexagons: there are no finer levels for fireflies yet. The file is fetched when the reader first picks the
 * firefly, so the luna page stays as light as it was.
 */
export const FIREFLY_URL = `${import.meta.env.BASE_URL}firefly-replay.json`;

/** Fetch the firefly file. Null when it is missing (the one-file preview build) or broken. */
export async function loadFirefly(): Promise<ReplayFile | null> {
  try {
    const r = await fetch(FIREFLY_URL);
    if (!r.ok) return null;
    const js = (await r.json()) as ReplayFile;
    return Array.isArray(js.cells) && js.forecast?.[TYPICAL] ? js : null;
  } catch {
    return null;
  }
}

type RGBA = [number, number, number, number];
const STAGE_COLOR: Record<Stage, RGBA> = palette.stages;
// Firefly light is yellow-green; a warm yellow keeps it apart from the luna's pale green.
const GLOW: RGBA = palette.firefly;
const GREY: RGBA = palette.rough;
const css = (c: RGBA) => `rgb(${c[0]},${c[1]},${c[2]})`;
const TYPICAL_AXIS_YEAR = 2025;
export const fireflyInk = '#8a5a00';

const fmtDoy = (year: number, doy: number) =>
  new Date(doyToMs(year, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** onData: called when the finer hexes arrive or the level on screen changes (the map should redraw). */
export function createFireflyLayer(
  file: ReplayFile,
  initial: Mode = TYPICAL,
  onData: () => void = () => {},
): LunaLayer & { seasonCount(m: Mode): number } {
  const { data, sightingsFor, bandOf } = replayData(file);
  let mode = initial;
  let shown = sightingsFor(mode);
  const profiles = new Map<Mode, SeasonProfile>(); // the ribbon depends only on the mode
  const cellIndex = new Map(data.cells.map((c, i) => [c, i] as const));
  const cells = data.cells.map((id, i) => ({ id, i, seen: data.seen[i] === 1 }));
  const washed = washer(data.cells);
  const unseen = cells.filter((c) => !c.seen);
  const yearOf = () => (mode === TYPICAL ? TYPICAL_AXIS_YEAR : Number(mode));
  const forecast = () => data.forecast[mode] ?? data.forecast[TYPICAL]!;
  const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
  const rings = ripples<Sighting>('firefly-ripples', (s) => [s.lng, s.lat], palette.dotRim);
  const filterExt = [new DataFilterExtension({ filterSize: 1 })];
  let lit: { key: string; pts: [number, number][] } = { key: '', pts: [] };
  let fresh = { key: '', list: [] as Sighting[] };
  let sleepNote: OffSeasonNote | undefined;

  // ---- finer hexes (res 5 only for fireflies), from public/fine-firefly/, loaded when the reader zooms in
  type Cell = { id: string; i: number; seen: boolean };
  const fine = fineSource('fine-firefly/');
  let fineLevel: { level: FineLevel; data: Cell[]; unseen: Cell[] } | null = null;
  const fineDays = new Map<Mode, Uint8Array>();
  let hasFine = false;
  let wantFine = false;
  let shownRes = GRID_RES;
  void fine.fineManifest().then((m) => {
    hasFine = !!m?.levels['5'];
    if (hasFine) onData(); // a zoomed-in view drawn before the manifest arrived can sharpen now
  });
  const loading = new Set<Mode>();
  const loadFine = () => {
    const m = mode;
    if (loading.has(m)) return; // one request per season, not one per frame while it is on its way
    loading.add(m);
    void Promise.all([fine.fineLevel(5), fine.fineDays(5, m)]).then(([level, days]) => {
      if (!level || !days || days.length !== level.cells.length * 5) return; // missing or stale: stay at res 4
      if (!fineLevel) {
        const data = level.cells.map((id, i) => ({ id, i, seen: level.seen[i] === 1 }));
        fineLevel = { level, data, unseen: data.filter((c) => !c.seen) };
      }
      fineDays.set(m, days);
      if (wantFine && m === mode) onData();
    });
  };
  /** Res 5 from FINE_ZOOM[5]; back to res 4 a little further out, so a zoom resting on the line doesn't flicker. */
  const resFor = (zoom: number) => {
    wantFine = hasFine && zoom >= FINE_ZOOM[5]! - (wantFine ? 0.3 : 0);
    const days = fineDays.get(mode);
    if (wantFine && !(fineLevel && days)) loadFine();
    return wantFine && fineLevel && days ? 5 : GRID_RES;
  };

  /** Forecast quantiles, "seen", the cell id and its res-4 parent at lngLat, on the level on screen. */
  const lookup = (lngLat: [number, number]) => {
    const days = fineDays.get(mode);
    if (shownRes === 5 && fineLevel && days) {
      const cell = latLngToCell(lngLat[1], lngLat[0], 5);
      const i = fineLevel.level.index.get(cell);
      return i === undefined ? null : { cell, q: fineQ(days, i), seen: fineLevel.level.seen[i] === 1, parent: parentOf(cell) };
    }
    const cell = latLngToCell(lngLat[1], lngLat[0], GRID_RES);
    const i = cellIndex.get(cell);
    return i === undefined ? null : { cell, q: forecast()[i] ?? [], seen: cells[i]!.seen, parent: cell };
  };

  /** Mean days off for the heat forecast and the usual date, over the shipped strip-years (one year, or all). */
  const scoreSummary = (year?: number) => {
    const rows = data.scores.filter((r) => year === undefined || r.year === year);
    const mae = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0) / Math.max(1, rows.length);
    return {
      n: rows.length,
      heat: mae((r) => (Math.abs(r.heat_onset - r.obs_onset) + Math.abs(r.heat_peak - r.obs_peak)) / 2),
      calendar: mae((r) => (Math.abs(r.cal_onset - r.obs_onset) + Math.abs(r.cal_peak - r.obs_peak)) / 2),
      rows,
    };
  };

  const HOME: [number, number] = [-88.0, 41.9];
  const spotStory = (lngLat: [number, number] | null, t: number, name?: string): SpotStory | null => {
    const hit = lookup(lngLat ?? HOME);
    if (!hit) return null;
    const [q05, q25, , q75, q95] = hit.q;
    if (q05 == null || q25 == null || q75 == null) return null;
    const year = yearOf();
    const f = (d: number) => fmtDoy(year, d);
    const doy = dayOfYear(t);
    const place = lngLat ? (name ?? 'this spot') : 'Chicago';
    const sentence = {
      'not yet': `On ${f(doy)}, the forecast says it is too early near ${place}. First fireflies about ${f(q05)}, busiest ${f(q25)} to ${f(q75)}.`,
      starting: `On ${f(doy)}, the forecast says fireflies are just starting near ${place}. Busiest nights should be ${f(q25)} to ${f(q75)}.`,
      peak: `On ${f(doy)}, the forecast says it is peak time near ${place}. Busiest ${f(q25)} to ${f(q75)}.`,
      'winding down': `On ${f(doy)}, the forecast says the season is winding down near ${place}. Busiest nights were ${f(q25)} to ${f(q75)}.`,
      over: `By ${f(doy)}, the forecast says the season is over near ${place}. It started about ${f(q05)}.`,
    }[stageAt(hit.q, doy)];
    const end = q95 ?? 273;
    return {
      title: lngLat ? (name ? `Near ${name}` : 'The spot you picked') : 'Example: the Chicago area',
      sentence,
      span: [dayOfYear(Date.UTC(year, 3, 1)), dayOfYear(Date.UTC(year, 8, 30))],
      months: [3, 4, 5, 6, 7, 8].map((m) => {
        const ms = Date.UTC(year, m, 1);
        return { doy: dayOfYear(ms), label: new Date(ms).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) };
      }),
      segments: [
        { from: 0, to: q05, label: 'not yet', color: css(STAGE_COLOR['not yet']) },
        { from: q05, to: q25, label: 'starting', color: css(STAGE_COLOR.starting) },
        { from: q25, to: q75, label: 'peak', color: css(STAGE_COLOR.peak) },
        { from: q75, to: end, label: 'winding down', color: css(STAGE_COLOR['winding down']) },
        { from: end, to: 367, label: 'over', color: css(STAGE_COLOR.over) },
      ],
      ticks: sightingsFor(mode).filter((s) => s.cell === hit.parent && !(s.flags & APPROXIMATE)).map(day),
      today: doy,
    };
  };

  return {
    id: 'firefly-replay',
    title: 'Common eastern firefly',
    words: { tagline: 'when fireflies glow', plural: 'fireflies', sightingsOf: 'firefly', countedAs: 'fireflies', shareName: 'fireflies', mark },
    mode: () => mode,
    setMode(m) {
      mode = m;
      shown = sightingsFor(m);
    },
    res: () => shownRes,
    cellAt: (lngLat) => lookup(lngLat)?.cell ?? null,
    busy: (t) => isBusy(forecast(), dayOfYear(t)),
    endNote: ['That was the firefly season.', 'Press replay to watch it again'],
    seasonCount: (m: Mode) => sightingsFor(m).length,

    newest(t) {
      const doy = dayOfYear(t);
      if (fresh.key !== `${doy}|${mode}`) fresh = { key: `${doy}|${mode}`, list: shown.filter((s) => day(s) === doy) };
      return fresh.list;
    },

    points(t) {
      // Cached per day and season, like luna's: the place names move out of the way of lit dots.
      const key = `${dayOfYear(t)}|${mode}`;
      if (lit.key !== key) {
        const doy = dayOfYear(t);
        lit = { key, pts: shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).map((s) => [s.lng, s.lat]) };
      }
      return lit.pts;
    },

    offSeason: (t) => (isAsleep(forecast(), dayOfYear(t)) ? (sleepNote ??= { title: 'Sleeping till summer', line: 'larvae in the soil', sketch: restingSketch('firefly'), at: MIDWEST_MARGIN }) : null),

    summary(t) {
      const doy = dayOfYear(t);
      const n = stageCounts(forecast(), doy);
      const lit = shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).length;
      const parts = STAGES.filter((s) => n[s]).map((s) => `${s} in ${n[s]}`);
      return `${fmtDoy(yearOf(), doy)}, ${modeLabel(mode)}. Firefly forecast across ${forecast().length} map hexagons: ${parts.join(', ')}. ` +
        `${lit} firefl${lit === 1 ? 'y' : 'ies'} seen in the last ${GLOW_DAYS} days.`;
    },

    // One wave a summer, so the ribbon's line needs no notes.
    profile() {
      let p = profiles.get(mode);
      if (!p) profiles.set(mode, (p = seasonProfile(forecast(), shown, day, yearOf(), [])));
      return p;
    },

    render({ t, zoom, theme, wash, playing, frac = 0 }) {
      const doy = dayOfYear(t);
      const anim = animating(playing);
      const d = anim ? doy + frac : doy; // the in-between day while playing, like luna's dots
      const res = resFor(zoom);
      if (res !== shownRes) {
        shownRes = res;
        queueMicrotask(onData); // the card and its outline follow the new level
      }
      const days = res === 5 ? fineDays.get(mode)! : null;
      const hexes = days ? fineLevel!.data : cells;
      const qOf = (c: Cell) => (days ? fineQ(days, c.i) : forecast()[c.i]);
      const filter = {
        getFilterValue: day,
        filterRange: [d - GLOW_DAYS + 0.5, d + 0.5] as [number, number],
        filterSoftRange: [d - 0.5, d + 0.5] as [number, number],
        filterTransformSize: true,
        filterTransformColor: true,
        extensions: filterExt,
      };
      return [
        new H3HexagonLayer<Cell>({
          // One id per level: reusing an id across levels left the other level's hexes drawn (see lunaReplay.ts).
          id: `firefly-forecast-r${res}${hexFade(anim).id}`,
          data: hexes,
          getHexagon: (c) => c.id,
          // The first-frame wash (a ?species=firefly link), on the coarse hexagons only.
          getFillColor: wash === undefined || days ? (c) => STAGE_COLOR[stageAt(qOf(c), doy)] : (c) => washed(c.i, STAGE_COLOR[stageAt(qOf(c), doy)], wash),
          getLineColor: wash === undefined || days ? theme.hexEdge : (c) => washed(c.i, theme.hexEdge, wash),
          stroked: true,
          filled: true,
          extruded: false,
          highPrecision: true,
          lineWidthMinPixels: days ? 0.4 : 0.6,
          pickable: true,
          autoHighlight: true,
          highlightColor: palette.hoverTint,
          updateTriggers: { getFillColor: [doy, mode, res, wash], getLineColor: [wash, res] },
          transitions: hexFade(anim).transitions,
        }),
        new H3HexagonLayer<Cell, FillStyleExtensionProps<Cell>>({
          id: `firefly-unseen-r${res}`,
          opacity: wash === undefined ? 1 : Math.min(1, wash / 900),
          data: days ? fineLevel!.unseen : unseen,
          getHexagon: (c) => c.id,
          getFillColor: palette.stripes,
          stroked: false,
          filled: true,
          extruded: false,
          highPrecision: true,
          pickable: false,
          extensions: [new FillStyleExtension({ pattern: true })],
          fillPatternAtlas: stripes(),
          fillPatternMapping: STRIPE_MAPPING,
          fillPatternMask: true,
          getFillPattern: () => 'stripes',
          fillPatternSizeUnits: 'pixels',
        }),
        new ScatterplotLayer<Sighting>({
          id: 'firefly-glow',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: palette.dotShadow,
          radiusUnits: 'pixels',
          getRadius: 9,
          pickable: true,
          updateTriggers: { getFilterValue: [mode] },
          ...filter,
        }),
        new ScatterplotLayer<Sighting>({
          id: 'firefly-halo',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: palette.dotHalo,
          radiusUnits: 'pixels',
          getRadius: 6.5,
          pickable: false,
          updateTriggers: { getFilterValue: [mode] },
          ...filter,
        }),
        new ScatterplotLayer<Sighting>({
          id: 'firefly-dots',
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: (s) => (s.flags & APPROXIMATE ? GREY : GLOW),
          stroked: true,
          getLineColor: palette.dotRim,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          radiusUnits: 'pixels',
          getRadius: (s) => (s.flags & APPROXIMATE ? 3 : 4),
          pickable: false,
          updateTriggers: { getFillColor: [mode], getFilterValue: [mode] },
          ...filter,
        }),
        ...rings(anim, doy, (from, to) => shown.filter((s) => day(s) >= from && day(s) <= to)),
      ];
    },

    probe(lngLat, t, picked): ProbeCard | null {
      const year = yearOf();
      const doy = dayOfYear(t);
      if (picked && (picked.layerId === 'firefly-glow' || picked.layerId === 'firefly-dots')) {
        const s = picked.object as Sighting;
        return {
          title: `Firefly seen ${fmtDoy(s.year, s.doy)}, ${s.year}`,
          lines: s.flags & APPROXIMATE ? ['Location is approximate, so the dot is small and dark.'] : [],
          link: { href: `https://www.inaturalist.org/observations/${s.id}`, label: 'See the photo on iNaturalist' },
        };
      }
      const at = lookup(lngLat);
      if (!at) return null;
      const [q05, q25, q50, q75] = at.q;
      // Same shape as the luna card: one answer up front, the detail behind "More".
      const stage = stageAt(at.q, doy);
      const label = stage === 'over' ? 'over' : STAGE_LABEL[stage]; // one wave a year, so plain "over"
      const lines: string[] = [];
      const more: string[] = [];
      const pk = data.interval?.peak;
      const likely = !!(pk && q50 != null && mode !== TYPICAL);
      if (likely) lines.push(`Busiest day likely ${fmtDoy(year, q50 + pk[0])} to ${fmtDoy(year, q50 + pk[1])}.`);
      else if (q25 != null && q75 != null) lines.push(`Busiest stretch ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}.`);
      if (!at.seen) lines.push('No fireflies of this kind ever seen near here to check this against.');
      if (q05 != null && q25 != null && q75 != null)
        more.push(`First fireflies about ${fmtDoy(year, q05)}${likely ? `. Busiest ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}` : ''}.`);
      const band = bandOf(lngLat[1]);
      const sc = mode === TYPICAL ? null : data.scores.find((r) => r.band === band.label && r.year === year);
      if (sc) {
        const off = sc.heat_peak - sc.obs_peak;
        more.push(
          `How the forecast did in this strip of the map (${band.label}°N): fireflies peaked ${fmtDoy(year, sc.obs_peak)}. Forecast ${fmtDoy(year, sc.heat_peak)}` +
            (off ? `, ${Math.abs(off)} day${Math.abs(off) > 1 ? 's' : ''} ${off < 0 ? 'early' : 'late'}` : ', right on') +
            `. Usual date ${fmtDoy(year, sc.cal_peak)}.`,
        );
      }
      // Sightings are counted on the zoomed-out hexagon: a small one would almost always have none.
      const here = sightingsFor(mode).filter((s) => s.cell === at.parent);
      const where = shownRes === 5 ? 'the wider area (one zoomed-out hexagon)' : 'this hexagon';
      more.push(
        here.length
          ? `${here.length} sighting${here.length > 1 ? 's' : ''} in ${where}${mode === TYPICAL ? ' (all years)' : ''}.`
          : `No sightings in ${where}${mode === TYPICAL ? '' : ' this year'}.`,
      );
      if (shownRes === 5) more.push('Small hexagon: forecast from its own local temperatures. Accuracy is only checked for whole strips of the map.');
      return { title: `Firefly: ${label} on ${fmtDoy(year, doy)}`, swatch: css(STAGE_COLOR[stage]), lines, more };
    },

    caveats(): CaveatCard {
      const yr = mode === TYPICAL ? null : scoreSummary(Number(mode));
      const c = data.counts;
      const m = data.model;
      const pk = data.interval?.peak ?? [0, 0];
      const bullets = [
        'This is a first try. It is the luna moth’s recipe refit on fireflies, with nothing tuned for fireflies yet. The luna moth’s rules were written down before it was scored. These were not.',
        'This is a look back. It uses the temperatures that actually happened. A forecast made during spring would have to guess the weather ahead.',
        `The dots are ${c.sightings?.toLocaleString() ?? '?'} photos of adult common eastern fireflies (Photinus pyralis) that people posted to iNaturalist, ${data.years[0]}-${data.years[data.years.length - 1]}. Each dot stays lit for ${GLOW_DAYS} days.`,
        'Fireflies are hard to name from a photo, and a flash at night is harder. Only records other iNaturalist users agreed on were used, and records of other firefly kinds were left out.',
        'Fireflies have one flying season a year, so there is no second wave. Records after late August were left out.',
        ...(m?.median_dd_at_lat?.['42']
          ? [`Half the fireflies came out after about ${Math.round(m.median_dd_at_lat['42'] / 10) * 10} degree-days of warmth (°C above 10, added up from March 1).`]
          : []),
        'To allow roughly for when people go looking, the model counts how many beetle photos people posted each day in each state. Most beetle photos are taken by day, so this is a rough stand-in, and nobody has checked yet whether it helps.',
        'Gray dots mean the photo’s location was blurred or rough, so the dot may sit off its true spot.',
        'Striped hexagons have no sightings of this firefly nearby, ever. There is nothing to check the forecast against there.',
        ...(hasFine
          ? ['Zoom in and the hexagons get smaller, about 17 km wide. Each uses the temperatures at its own centre. Nobody has checked the forecast at that scale. So a small hexagon\u2019s date is no surer than a big one\u2019s. Its card counts the sightings in the big hexagon around it.']
          : ['There are no small hexagons for fireflies here. Zooming in keeps the big ones.']),
        `For a single year, a hexagon’s card gives a "peak here likely" window. In the 23 strip-years checked, 8 in 10 peaks were within ${Math.round(-pk[0])} days early to ${Math.round(pk[1])} days late of the forecast. One spot can miss by more.`,
        ...(m?.holdout_mae
          ? [`When it learned only from Illinois, Indiana and Ohio, it was ${m.holdout_mae.heat.toFixed(1)} days off in Wisconsin and Minnesota, against ${m.holdout_mae.cal.toFixed(1)} for their own usual dates. That is only 4 strip-years, so it is a hint, not proof.`]
          : []),
        'Sightings show where people look as much as where fireflies are. Towns and backyards get counted too often. An empty spot does not mean no fireflies.',
        'Only openly licensed photos are drawn. The forecast learned from all confirmed records with a precise location, one per person, place and day.',
      ];
      if (yr && yr.n)
        bullets.push(
          `Peak dates in ${mode}, south to north (seen, forecast, usual date): ` +
            yr.rows.map((r) => `${r.band}°N ${fmtDoy(r.year, r.obs_peak)}, ${fmtDoy(r.year, r.heat_peak)}, ${fmtDoy(r.year, r.cal_peak)}`).join('. ') +
            '.',
        );
      else if (yr) bullets.push(`${mode} had too few sightings to check. Each strip of the map needs at least 20.`);
      return { title: 'Firefly replay: what you are looking at', severity: 'normal', bullets };
    },

    explainer(): Explainer {
      const sc = mode === TYPICAL ? scoreSummary() : scoreSummary(Number(mode));
      const all = sc.n ? sc : scoreSummary();
      return {
        name: 'Common eastern firefly',
        sci: data.species.sci,
        creature: 'firefly',
        accent: fireflyInk,
        hook: 'Common eastern fireflies light up summer evenings once a year. This map predicts when they come out across seven Midwest states, based on how warm the spring has been. It is a first try, using the luna moth’s recipe.',
        steps: [
          { title: 'Winter', text: 'All winter the young firefly lives as a grub in damp soil.' },
          { title: 'Warmth wakes it', text: 'From March 1, every day warmer than 50\u00a0°F (10\u00a0°C) adds a little warmth. Hotter days add more.' },
          { title: 'Warm spring, early fireflies', text: 'Once it has had enough warmth, out it comes and starts to flash. A warm spring gets there sooner.' },
        ],
        spotIntro: `${matchMedia('(hover: hover) and (pointer: fine)').matches ? 'Click' : 'Tap'} a hexagon on the map to see its season here.`,
        spot: (lngLat, t, name) => spotStory(lngLat, t, name),
        score: {
          title: 'How sure is it?',
          points: [
            [
              'checked',
              sc.n
                ? `the dates of the first fireflies and the peak, against people’s sightings, on ${mode === TYPICAL ? 'years' : mode} it never learned from (Illinois to central Wisconsin and Michigan).`
                : `${mode} had too few sightings to check, so this is all years together.`,
            ],
            ...(data.model
              ? [['simpler rule', `the warmth at past sightings alone did about as well: ${data.model.loyo_mae.p1.toFixed(1)} days off against ${data.model.loyo_mae.heat.toFixed(1)}.`] as [string, string]]
              : []),
            ['first try', 'not tested as carefully as the luna moth yet.'],
          ],
          bars: [
            { label: 'Heat forecast', days: all.heat, best: all.heat < all.calendar },
            { label: 'Usual date', days: all.calendar, best: all.calendar < all.heat },
          ],
        },
        finePrintLabel: 'Limits and fine print',
      };
    },

    legend(): LegendSpec {
      return {
        title: 'Forecast: when fireflies come out',
        items: [
          ...STAGES.map((s) => ({ color: onPaper(STAGE_COLOR[s]), label: s === 'over' ? 'over' : STAGE_LABEL[s], shape: 'hex' as const })),
          { color: css(STAGE_COLOR.peak), label: 'no sightings nearby', shape: 'striped' },
          { color: css(GLOW), label: 'seen, last 10 days', shape: 'dot' },
          { color: css(GREY), label: 'rough location', shape: 'dot' },
        ],
      };
    },

    credits() {
      return [
        { text: 'Firefly sightings: iNaturalist observers (CC0, CC BY and CC BY-NC records only). Photos are linked, never copied.', href: `https://www.inaturalist.org/taxa/${data.species.inat_taxon}` },
        { text: 'Temperatures: Daymet v4 daily 1 km, Thornton et al., ORNL DAAC.', href: 'https://daymet.ornl.gov/' },
        { text: 'State outlines: US Census Bureau, via us-atlas.', href: 'https://github.com/topojson/us-atlas' },
      ];
    },
  };
}
