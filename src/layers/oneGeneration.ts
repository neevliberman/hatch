import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension, FillStyleExtension, type FillStyleExtensionProps } from '@deck.gl/extensions';
import { latLngToCell } from 'h3-js';
import { palette } from '../theme';
import { GRID_RES } from '../core/grid';
import { dayOfYear } from '../core/timeAxis';
import type { CaveatCard, Creature, Explainer, LegendSpec, OffSeasonNote, ProbeCard, SeasonProfile, SpeciesWords, SpotStory } from '../core/layer';
import { restingSketch } from '../ui/sketch';
import { countdownParts, type SeasonWords } from '../ui/countdown';
import { doyToMs, LIVE, UNCONFIRMED, type ReplayFile } from './lunaData';
import type { Live } from './liveData';
import { APPROXIMATE, modelChecks, replayData, TYPICAL, windowCheck, type Mode, type Sighting } from './replayData';
import { animating, hexFade, ripples } from './motion';
import { fineQ, fineSource, KEEP_SEASONS, parentOf, RELEASE_MS, remember, RETRY_MS, type FineLevel } from './fineData';
import { COARSE, FINE_ZOOM, GLOW_DAYS, SETTLE_MS, liveNotice, modeLabel, seasonProfile, STAGE_LABEL, STRIPE_MAPPING, stripes, washer, type LunaLayer } from './lunaReplay';
import { isAsleep, isBusy, MIDWEST_MARGIN, onPaper, stageAt, stageCounts, STAGES, type Stage } from './stages';

type RGBA = [number, number, number, number];

/**
 * Everything one species with one generation a year says and draws, beyond its data file. The layer below is the
 * same for every such species (the firefly, the Japanese beetle, ...): same file format and forecast as the luna moth
 * (built by pipeline/firefly or pipeline/species), one flight season a year, big hexagons plus res-5 ones if the
 * species has a fine/ folder. A new species is one of these (src/species/) plus its data.
 */
export interface SpeciesConfig {
  /** Layer ids start with it: `${key}-forecast-r4`. Also the ?species= value. */
  key: string;
  /** "Common eastern firefly": the panel's name and the layer title. */
  name: string;
  /** One of them, capitalised, for card titles: "Firefly seen Jun 3", "Firefly: peak on Jun 20". */
  one: string;
  /** One of them in a sentence: "1 firefly seen". */
  oneLower: string;
  /** "this firefly" / "Japanese beetles", for "no sightings of this firefly nearby". */
  thisOne: string;
  /** The card line on a hexagon with no sightings nearby: "No fireflies of this kind ever seen near here to ...". */
  noneSeen: string;
  /** Adults, for the dots bullet: "adult common eastern fireflies". */
  adults: string;
  /** When people see them at their busiest: "nights" (fireflies) or "days". */
  busyWhen: 'nights' | 'days';
  words: SpeciesWords;
  season: SeasonWords;
  /** Dot colour (its own, so species never read alike when switched). */
  glow: RGBA;
  /** Text colour for its name and marks in the About panel. */
  ink: string;
  creature: Creature;
  /** Folder of res-5 hexes next to the page ('fine-firefly/'), or none. */
  fine?: string;
  endNote: [string, string];
  sleep: { title: string; line: string };
  hook: string;
  steps: Explainer['steps'];
  /** Where the leave-one-year-out check was scored ("Illinois to central Wisconsin and Michigan"). */
  checkedWhere: string;
  /** Its own fine-print bullets: how hard it is to name, its season, its effort background. */
  idNote: string;
  seasonNote: string;
  effortNote: string;
  /** Extra bullets after the shared ones (the species' own story, such as where it came from). */
  extra?: string[];
  /** Strip-years in the holdout, for files that predate model.holdout_band_years. */
  holdoutYears?: number;
}

const STAGE_COLOR: Record<Stage, RGBA> = palette.stages;
const GREY: RGBA = palette.rough;
const css = (c: RGBA) => `rgb(${c[0]},${c[1]},${c[2]})`;
const TYPICAL_AXIS_YEAR = 2025;

const fmtDoy = (year: number, doy: number) =>
  new Date(doyToMs(year, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A fetched species file that looks whole (not missing, broken or cut off). */
export const isReplay = (js: unknown): js is ReplayFile => {
  const f = js as ReplayFile | null;
  return !!f && Array.isArray(f.cells) && !!f.forecast?.[TYPICAL];
};

/**
 * onData: called when the finer hexes arrive or the level on screen changes (the map should redraw).
 * live: this season's nightly forecast for the species (public/live/latest.json, src/layers/liveData.ts), or null:
 * with one, the season menu offers it (LIVE), drawn like luna's: big hexagons, this season's sightings so far.
 */
export function createOneGenerationLayer(
  cfg: SpeciesConfig,
  file: ReplayFile,
  initial: Mode = TYPICAL,
  onData: () => void = () => {},
  liveIn: Live | null = null,
): LunaLayer {
  let live = liveIn;
  const { key, one, words } = cfg;
  const plural = words.plural;
  const GLOW = cfg.glow;
  const { data, sightingsFor: pastSightings, bandOf } = replayData(file);
  /** Sightings in a mode: past years from the replay file, this season's from the live file. */
  const sightingsFor = (m: Mode): Sighting[] => (m === LIVE ? (live?.sightings ?? []) : pastSightings(m));
  let mode = initial === LIVE && !live ? TYPICAL : initial;
  let shown = sightingsFor(mode);
  const profiles = new Map<Mode, SeasonProfile>(); // the ribbon depends only on the mode
  const cellIndex = new Map(data.cells.map((c, i) => [c, i] as const));
  const cells = data.cells.map((id, i) => ({ id, i, seen: data.seen[i] === 1 }));
  const washed = washer(data.cells);
  const unseen = cells.filter((c) => !c.seen);
  const isLive = () => mode === LIVE && live !== null;
  const yearOf = () => (mode === TYPICAL ? TYPICAL_AXIS_YEAR : isLive() ? live!.season : Number(mode));
  const forecast = () => (isLive() ? live!.median : (data.forecast[mode] ?? data.forecast[TYPICAL]!)) as ((number | null)[] | null)[];
  const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
  const rings = ripples<Sighting>(`${key}-ripples`, (s) => [s.lng, s.lat], palette.dotRim);
  const filterExt = [new DataFilterExtension({ filterSize: 1 })];
  let lit: { key: string; pts: [number, number][] } = { key: '', pts: [] };
  let fresh = { key: '', list: [] as Sighting[] };
  let sleepNote: OffSeasonNote | undefined;
  // A season with thousands of dots out at once (the Japanese beetle's all-years view: ~9,000 on the peak days) buries
  // the hexagons under them on the zoomed-out map. Its dots shrink there, by how crowded its busiest ten days are,
  // and grow back to full size as you zoom in. Luna-sized seasons (a few hundred at once) keep full-size dots.
  let crowd = { mode: '' as Mode, k: 1 };
  const dotScale = (zoom: number) => {
    if (crowd.mode !== mode) {
      const perDay = new Array<number>(370).fill(0);
      for (const s of shown) perDay[Math.min(369, Math.max(0, Math.round(day(s))))]!++;
      let peak = 0;
      for (let d = 0, sum = 0; d < 370; d++) (sum += perDay[d]! - (perDay[d - GLOW_DAYS] ?? 0)), (peak = Math.max(peak, sum));
      crowd = { mode, k: Math.min(1, Math.max(0.55, Math.sqrt(1200 / Math.max(1, peak)))) };
    }
    return crowd.k + (1 - crowd.k) * Math.min(1, Math.max(0, (zoom - 6) / 1.5));
  };

  // ---- finer hexes (res 5 only), from the species' fine/ folder, loaded when the reader zooms in
  type Cell = { id: string; i: number; seen: boolean };
  const fine = cfg.fine ? fineSource(cfg.fine) : null;
  let fineLevel: { level: FineLevel; data: Cell[]; unseen: Cell[] } | null = null;
  const fineDays = new Map<Mode, Uint8Array>();
  let hasFine = false;
  let wantFine = false;
  let wantSince = 0;
  let shownRes = GRID_RES;
  /** The res-5 days drawn last: kept on screen while a season switch loads its own (no flash back to res 4). */
  let shownDays: Uint8Array | null = null;
  /** Requests on their way or recently failed ('manifest', or a season): no retry before RETRY_MS. */
  const loading = new Map<string, number>();
  const loadManifest = () => {
    if (!fine) return;
    loading.set('manifest', Infinity);
    void fine.fineManifest().then((m) => {
      hasFine = !!m?.levels['5'];
      loading.set('manifest', m ? Infinity : performance.now() + RETRY_MS);
      if (hasFine) onData(); // a zoomed-in view drawn before the manifest arrived can sharpen now
    });
  };
  loadManifest();
  const loadFine = () => {
    const m = mode;
    // One request per season, not one per frame while it is on its way; a failed one is asked again later.
    if (!fine || (loading.get(m) ?? 0) > performance.now()) return;
    loading.set(m, Infinity);
    void Promise.all([fine.fineLevel(5), fine.fineDays(5, m)]).then(([level, days]) => {
      if (!level || !days || days.length !== level.cells.length * 5) {
        loading.set(m, performance.now() + RETRY_MS); // missing, stale or offline: stay at res 4 for now
        return;
      }
      loading.delete(m);
      if (!fineLevel) {
        const data = level.cells.map((id, i) => ({ id, i, seen: level.seen[i] === 1 }));
        fineLevel = { level, data, unseen: data.filter((c) => !c.seen) };
      }
      remember(fineDays, m, days, KEEP_SEASONS, (k) => k === mode || k === m);
      if (wantFine && m === mode) onData();
    });
  };
  // Zoomed back out: after RELEASE_MS at res 4, let the res-5 hexes go (see RELEASE_MS).
  let releaseTimer = 0;
  const releaseLater = () => {
    if (releaseTimer || !fineLevel) return;
    releaseTimer = window.setTimeout(() => {
      releaseTimer = 0;
      if (shownRes !== GRID_RES || wantFine) return;
      fineLevel = null;
      fineDays.clear();
      fine?.forget();
    }, RELEASE_MS);
  };
  /** Res 5 from FINE_ZOOM[5]; back to res 4 a little further out, so a zoom resting on the line doesn't flicker. */
  /** The level to draw and its days: res 5 only once the zoom has rested there (SETTLE_MS), not mid fly-to. */
  const resFor = (zoom: number): { res: number; days: Uint8Array | null } => {
    if (isLive()) return { res: GRID_RES, days: null }; // live has no finer files: big hexagons at every zoom
    if (fine && !hasFine && zoom >= FINE_ZOOM[5]! && (loading.get('manifest') ?? 0) <= performance.now()) loadManifest();
    const want = hasFine && zoom >= FINE_ZOOM[5]! - (wantFine ? 0.3 : 0);
    if (want !== wantFine) {
      wantSince = performance.now();
      if (want) setTimeout(onData, SETTLE_MS + 20); // look again once the zoom has rested
    }
    wantFine = want;
    if (!wantFine) return { res: GRID_RES, days: null };
    const days = fineDays.get(mode);
    if (!(fineLevel && days)) loadFine();
    if (shownRes !== 5 && performance.now() - wantSince < SETTLE_MS) return { res: GRID_RES, days: null };
    if (fineLevel && days) return { res: 5, days };
    // Old colours only while the new season's request is out: after a failure they'd sit under the wrong season.
    return shownRes === 5 && shownDays && loading.get(mode) === Infinity ? { res: 5, days: shownDays } : { res: GRID_RES, days: null };
  };

  /** Forecast quantiles, "seen", the cell id and its res-4 parent at lngLat, on the level on screen. */
  const lookup = (lngLat: [number, number]) => {
    const days = shownDays; // what is drawn (for a moment after a season switch, the last season's colours)
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

  const busiest = `Busiest ${cfg.busyWhen}`;
  const HOME: [number, number] = [-88.0, 41.9];
  const spotStory = (lngLat: [number, number] | null, t: number, name?: string, example = false): SpotStory | null => {
    const hit = lookup(lngLat ?? HOME);
    if (!hit) return null;
    const [q05, q25, , q75, q95] = hit.q;
    if (q05 == null || q25 == null || q75 == null) return null;
    const year = yearOf();
    const f = (d: number) => fmtDoy(year, d);
    const doy = dayOfYear(t);
    const place = lngLat ? (name ?? 'this spot') : 'Chicago';
    const sentence = {
      'not yet': `On ${f(doy)}, the forecast says it is too early near ${place}. First ${plural} about ${f(q05)}, busiest ${f(q25)} to ${f(q75)}.`,
      starting: `On ${f(doy)}, the forecast says ${plural} are just starting near ${place}. ${busiest} should be ${f(q25)} to ${f(q75)}.`,
      peak: `On ${f(doy)}, the forecast says it is peak time near ${place}. Busiest ${f(q25)} to ${f(q75)}.`,
      'winding down': `On ${f(doy)}, the forecast says the season is winding down near ${place}. ${busiest} were ${f(q25)} to ${f(q75)}.`,
      over: `By ${f(doy)}, the forecast says the season is over near ${place}. It started about ${f(q05)}.`,
    }[stageAt(hit.q, doy)];
    const end = q95 ?? 273;
    return {
      title: !lngLat || example ? `Example: the ${place} area` : name ? `Near ${name}` : 'The spot you picked',
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

  /** Live hex card, as luna's: the stage first, the likely peak, the detail behind "More". Any number may be missing. */
  const liveProbe = (cell: string, q: (number | null)[], seen: boolean, doy: number): ProbeCard => {
    const L = live!;
    const y = L.season;
    const i = cellIndex.get(cell);
    const f = (d: number) => fmtDoy(y, d);
    const asOf = f(dayOfYear(L.asOf));
    const stage = stageAt(q, doy);
    const label = stage === 'over' ? 'over' : STAGE_LABEL[stage];
    const lines: string[] = [];
    const more: string[] = [];
    const lo = i === undefined ? null : L.lo[i]?.[2];
    const hi = i === undefined ? null : L.hi[i]?.[2];
    if (lo != null && hi != null) lines.push(lo === hi ? `Busiest day likely ${f(lo)}.` : `Busiest day likely ${f(lo)} to ${f(hi)}.`);
    else if (q[2] != null) lines.push(`Busiest day likely about ${f(q[2])}.`);
    if (!seen) lines.push(cfg.noneSeen);
    const out = i === undefined ? null : L.outNow[i];
    if (out != null && out > 0) more.push(`${Math.round(out)}% of the season\u2019s ${plural} out by ${asOf}.`);
    const dd = i === undefined ? null : L.dd[i];
    if (dd != null && dd > 0) more.push(`${Math.round(dd).toLocaleString()} degree-days banked since Mar 1.`);
    const n = shown.filter((s) => s.cell === cell).length;
    if (n) more.push(`${n} sighting${n > 1 ? 's' : ''} here this season.`);
    more.push(`${modeLabel(LIVE, L)}: real weather to ${asOf}, then forecast.`);
    return { title: `${one}: ${label} on ${f(doy)}${L.asOf < doyToMs(y, doy) ? ' (forecast)' : ''}`, swatch: css(STAGE_COLOR[stage]), lines, more };
  };

  const isDot = (id: string) => id === `${key}-glow` || id === `${key}-dots`;
  return {
    id: `${key}-replay`,
    title: cfg.name,
    live: () => live,
    setLive(l) {
      live = l;
      profiles.delete(LIVE);
      if (mode === LIVE) shown = sightingsFor(mode);
    },
    words,
    mode: () => mode,
    setMode(m) {
      mode = m;
      shown = sightingsFor(m);
    },
    res: () => shownRes,
    cellAt: (lngLat) => lookup(lngLat)?.cell ?? null,
    busy: (t) => isBusy(forecast(), dayOfYear(t)),
    endNote: cfg.endNote,
    seasonCount: (m: Mode) => sightingsFor(m).length,
    countdown: (now) => countdownParts(now, file, cfg.season),

    newest(t) {
      const doy = dayOfYear(t);
      if (fresh.key !== `${doy}|${mode}`) fresh = { key: `${doy}|${mode}`, list: shown.filter((s) => day(s) === doy) };
      return fresh.list;
    },

    points(t) {
      // Cached per day and season, like luna's: the place names move out of the way of lit dots.
      const k = `${dayOfYear(t)}|${mode}`;
      if (lit.key !== k) {
        const doy = dayOfYear(t);
        lit = { key: k, pts: shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).map((s) => [s.lng, s.lat]) };
      }
      return lit.pts;
    },

    offSeason: (t) => (isAsleep(forecast(), dayOfYear(t)) ? (sleepNote ??= { ...cfg.sleep, sketch: restingSketch(cfg.creature), at: MIDWEST_MARGIN }) : null),

    summary(t) {
      const doy = dayOfYear(t);
      const n = stageCounts(forecast(), doy);
      const lit = shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).length;
      const parts = STAGES.filter((s) => n[s]).map((s) => `${s} in ${n[s]}`);
      const asOf = isLive() ? ` Weather observed up to ${fmtDoy(yearOf(), dayOfYear(live!.asOf))}, forecast after.` : '';
      return `${fmtDoy(yearOf(), doy)}, ${modeLabel(mode, live)}.${asOf} ${one} forecast across ${forecast().length} map hexagons: ${parts.join(', ')}. ` +
        `${lit} ${lit === 1 ? cfg.oneLower : plural} seen in the last ${GLOW_DAYS} days.`;
    },

    // One wave a summer, so the ribbon's line needs no notes.
    profile() {
      let p = profiles.get(mode);
      if (!p) profiles.set(mode, (p = seasonProfile(forecast().map((q) => q ?? []), shown, day, yearOf(), [])));
      return p;
    },

    render({ t, zoom, theme, wash, playing, frac = 0 }) {
      const doy = dayOfYear(t);
      const anim = animating(playing);
      const d = anim ? doy + frac : doy; // the in-between day while playing, like luna's dots
      const { res, days } = resFor(zoom);
      shownDays = days;
      if (res === GRID_RES) releaseLater();
      else if (releaseTimer) releaseTimer = (clearTimeout(releaseTimer), 0); // back in: the 60 s starts again next time
      if (res !== shownRes) {
        shownRes = res;
        queueMicrotask(onData); // the card and its outline follow the new level
      }
      const hexes = days ? fineLevel!.data : cells;
      const radiusScale = dotScale(zoom);
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
          id: `${key}-forecast-r${res}${hexFade(anim).id}`,
          data: hexes,
          getHexagon: (c) => c.id,
          // The first-frame wash (a ?species= link), on the coarse hexagons only.
          getFillColor: wash === undefined || days ? (c) => STAGE_COLOR[stageAt(qOf(c), doy)] : (c) => washed(c.i, STAGE_COLOR[stageAt(qOf(c), doy)], wash),
          getLineColor: wash === undefined || days ? theme.hexEdge : (c) => washed(c.i, theme.hexEdge, wash),
          stroked: true,
          filled: true,
          extruded: false,
          // Phones draw res 5 as one instanced shape (see COARSE in lunaReplay.ts): far less memory.
          highPrecision: days && COARSE ? 'auto' : true,
          lineWidthMinPixels: days ? 0.4 : 0.6,
          pickable: true,
          autoHighlight: true,
          highlightColor: palette.hoverTint,
          updateTriggers: { getFillColor: [doy, mode, res, wash], getLineColor: [wash, res] },
          transitions: hexFade(anim).transitions,
        }),
        new H3HexagonLayer<Cell, FillStyleExtensionProps<Cell>>({
          id: `${key}-unseen-r${res}`,
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
          id: `${key}-glow`,
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: palette.dotShadow,
          radiusUnits: 'pixels',
          getRadius: 9,
          radiusScale,
          pickable: true,
          updateTriggers: { getFilterValue: [mode] },
          ...filter,
        }),
        new ScatterplotLayer<Sighting>({
          id: `${key}-halo`,
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: palette.dotHalo,
          radiusUnits: 'pixels',
          getRadius: 6.5,
          radiusScale,
          pickable: false,
          updateTriggers: { getFilterValue: [mode] },
          ...filter,
        }),
        new ScatterplotLayer<Sighting>({
          id: `${key}-dots`,
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: (s) => {
            const c = s.flags & APPROXIMATE ? GREY : GLOW;
            return s.flags & UNCONFIRMED ? [c[0], c[1], c[2], 150] : c; // live: not yet confirmed, a little fainter
          },
          stroked: true,
          getLineColor: palette.dotRim,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          radiusUnits: 'pixels',
          getRadius: (s) => (s.flags & APPROXIMATE ? 3 : 4),
          radiusScale,
          lineWidthScale: Math.max(0.7, radiusScale),
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
      if (picked && isDot(picked.layerId)) {
        const s = picked.object as Sighting;
        return {
          title: `${one} seen ${fmtDoy(s.year, s.doy)}, ${s.year}`,
          lines: s.flags & APPROXIMATE ? ['Location is approximate, so the dot is small and dark.'] : [],
          link: { href: `https://www.inaturalist.org/observations/${s.id}`, label: 'See the photo on iNaturalist' },
        };
      }
      const at = lookup(lngLat);
      if (!at) return null;
      if (isLive()) return liveProbe(at.cell, at.q, at.seen, doy);
      const [q05, q25, q50, q75] = at.q;
      // Same shape as the luna card: one answer up front, the detail behind "More".
      const stage = stageAt(at.q, doy);
      const label = stage === 'over' ? 'over' : STAGE_LABEL[stage]; // one wave a year, so plain "over"
      const lines: string[] = [];
      const more: string[] = [];
      const pk = data.interval?.peak;
      const likely = !!(pk && q50 != null && mode !== TYPICAL);
      if (likely) lines.push(`Busiest day likely ${fmtDoy(year, q50 + pk[0])} to ${fmtDoy(year, q50 + pk[1])}.`);
      // In date order: the first ones, then the busiest stretch.
      else if (q25 != null && q75 != null)
        lines.push(`${q05 != null ? `First ${plural} about ${fmtDoy(year, q05)}. ` : ''}Busiest stretch ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}.`);
      if (!at.seen) lines.push(cfg.noneSeen);
      if (likely && q05 != null && q25 != null && q75 != null)
        more.push(`First ${plural} about ${fmtDoy(year, q05)}. Busiest stretch ${fmtDoy(year, q25)} to ${fmtDoy(year, q75)}.`);
      const band = bandOf(lngLat[1]);
      const sc = mode === TYPICAL ? null : data.scores.find((r) => r.band === band.label && r.year === year);
      if (sc) {
        const off = sc.heat_peak - sc.obs_peak;
        more.push(
          `How the forecast did in this strip of the map (${band.label}°N): ${plural} peaked ${fmtDoy(year, sc.obs_peak)}. Forecast ${fmtDoy(year, sc.heat_peak)}` +
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
      return { title: `${one}: ${label} on ${fmtDoy(year, doy)}`, swatch: css(STAGE_COLOR[stage]), lines, more };
    },

    caveats(): CaveatCard {
      const yr = mode === TYPICAL || isLive() ? null : scoreSummary(Number(mode));
      const c = data.counts;
      const m = data.model;
      const pk = data.interval?.peak ?? [0, 0];
      const nHold = m?.holdout_band_years ?? cfg.holdoutYears;
      const bullets = [
        `This is a first try. It is the luna moth’s recipe refit on ${plural}, with nothing tuned for ${plural} yet. The luna moth’s rules were written down before it was scored. These were not.`,
        isLive()
          ? `This is ${live!.season}\u2019s forecast: real weather so far, then guesses for the weeks ahead. Its misses on past years (below) knew the real weather, so expect bigger misses early in the season.`
          : 'This is a look back. It uses the temperatures that actually happened. A forecast made during spring would have to guess the weather ahead.',
        isLive()
          ? `The dots are this season\u2019s photos of ${cfg.adults} (${data.species.sci}) posted to iNaturalist (${shown.length ? `${shown.length.toLocaleString()} so far` : 'none yet'}). Fainter ones are not confirmed yet. Each dot stays lit for ${GLOW_DAYS} days.`
          : `The dots are ${c.sightings?.toLocaleString() ?? '?'} photos of ${cfg.adults} (${data.species.sci}) that people posted to iNaturalist, ${data.years[0]}-${data.years[data.years.length - 1]}. Each dot stays lit for ${GLOW_DAYS} days.`,
        cfg.idNote,
        cfg.seasonNote,
        ...(m?.median_dd_at_lat?.['42']
          ? [`Half the ${plural} came out after about ${Math.round(m.median_dd_at_lat['42'] / 10) * 10} degree-days of warmth (°C above 10, added up from March 1).`]
          : []),
        cfg.effortNote,
        'Gray dots mean the photo’s location was blurred or rough, so the dot may sit off its true spot.',
        `Striped hexagons have no sightings of ${cfg.thisOne} nearby, ever. There is nothing to check the forecast against there.`,
        ...(isLive()
          ? ['This year\u2019s forecast has big hexagons only, at every zoom.']
          : hasFine
          ? ['Zoom in and the hexagons get smaller, about 17 km wide. Each uses the temperatures at its own centre. Nobody has checked the forecast at that scale. So a small hexagon’s date is no surer than a big one’s. Its card counts the sightings in the big hexagon around it.']
          : [`There are no small hexagons for ${plural} here. Zooming in keeps the big ones.`]),
        `For a single year, a hexagon’s card gives a "peak here likely" window. In the ${data.scores.length} strip-years checked, 8 in 10 peaks were within ${Math.round(-pk[0])} days early to ${Math.round(pk[1])} days late of the forecast.` +
          (data.interval?.checked
            ? ` Sized without the year being checked, it caught ${data.interval.checked.peak[0]} of ${data.interval.checked.peak[1]}.`
            : '') +
          ' One spot can miss by more.',
        ...(m?.holdout_mae && nHold
          ? [`When it learned only from Illinois, Indiana and Ohio, it was ${m.holdout_mae.heat.toFixed(1)} days off in Wisconsin and Minnesota, against ${m.holdout_mae.cal.toFixed(1)} for their own usual dates. That is only ${nHold} strip-years, so it is a hint, not proof.`]
          : []),
        // Strips of the map where the usual date beat the forecast, said plainly.
        ...(data.scorecard ?? [])
          .filter((b) => b.mae.cal < b.mae.heat)
          .map((b) => `In the strip at ${b.band}°N the usual date did better than the forecast: ${b.mae.cal.toFixed(1)} days off against ${b.mae.heat.toFixed(1)}, over ${b.band_years} years.`),
        ...(cfg.extra ?? []),
        `Sightings show where people look as much as where ${plural} are. Towns and backyards get counted too often. An empty spot does not mean no ${plural}.`,
        'Only openly licensed photos are drawn. The forecast learned from all confirmed records with a precise location, one per person, place and day.',
      ];
      if (yr && yr.n)
        bullets.push(
          `Peak dates in ${mode}, south to north (seen, forecast, usual date): ` +
            yr.rows.map((r) => `${r.band}°N ${fmtDoy(r.year, r.obs_peak)}, ${fmtDoy(r.year, r.heat_peak)}, ${fmtDoy(r.year, r.cal_peak)}`).join('. ') +
            '.',
        );
      else if (yr) bullets.push(`${mode} had too few sightings to check. Each strip of the map needs at least 20.`);
      return { title: `${one} replay: what you are looking at`, severity: 'normal', bullets };
    },

    explainer(): Explainer {
      const sc = mode === TYPICAL || isLive() ? scoreSummary() : scoreSummary(Number(mode));
      const all = sc.n ? sc : scoreSummary();
      const past = scoreSummary();
      const lm = data.model?.loyo_mae;
      // The simpler rule (warmth at past sightings alone, luna's first model), said as its numbers say it, on the same
      // strip-years as the bars (all years, or the one year picked), so the card never shows two numbers for one score.
      const p1 = all.rows.filter((r) => r.p1_onset != null && r.p1_peak != null);
      const p1Days = p1.reduce((a, r) => a + (Math.abs(r.p1_onset! - r.obs_onset) + Math.abs(r.p1_peak! - r.obs_peak)) / 2, 0) / Math.max(1, p1.length);
      const vs = `${p1Days.toFixed(1)} days off against ${all.heat.toFixed(1)}`;
      const simpler = lm && p1.length === all.rows.length
        ? Math.abs(p1Days - all.heat) < 0.5
          ? `A simpler rule, the warmth at past sightings alone, did about as well: ${vs}.`
          : p1Days < all.heat
            ? `A simpler rule, the warmth at past sightings alone, did better: ${vs}.`
            : `A simpler rule, the warmth at past sightings alone, did worse: ${vs}.`
        : null;
      return {
        name: cfg.name,
        sci: data.species.sci,
        creature: cfg.creature,
        accent: cfg.ink,
        hook: cfg.hook,
        steps: cfg.steps,
        spotIntro: `${matchMedia('(hover: hover) and (pointer: fine)').matches ? 'Click' : 'Tap'} a hexagon on the map to see its season here.`,
        spot: (lngLat, t, name, example) => spotStory(lngLat, t, name, example),
        score: {
          title: 'How sure is it?',
          points: [
            sc.n
              ? `It was checked against real sightings: the dates of the first ${plural} and the peak, on ${mode === TYPICAL || isLive() ? 'years' : mode} it never learned from (${cfg.checkedWhere}).`
              : `${mode} had too few sightings to check, so these numbers are for all years together.`,
            ...(isLive()
              ? ['Those checks knew the real weather. This year\u2019s forecast has to guess the weeks ahead, so expect bigger misses early in the season.']
              : []),
            ...(simpler ? [simpler] : []),
            ...[windowCheck(data)].filter((w): w is string => !!w),
            'It is a first try, not tested as carefully as the luna moth yet.',
          ],
          bars: [
            { label: 'This forecast', days: all.heat, best: all.heat < all.calendar },
            { label: 'Usual date', days: all.calendar, best: all.calendar < all.heat },
          ],
          scope: sc.n && mode !== TYPICAL && !isLive() ? `in ${mode}` : 'on past years',
          checks: modelChecks(data, past, cfg.holdoutYears),
          checksThrough: data.years[data.years.length - 1],
        },
        finePrintLabel: 'Limits and fine print',
        notice: isLive() ? liveNotice(live!) : undefined,
      };
    },

    legend(): LegendSpec {
      return {
        title: `Forecast: when ${plural} come out`,
        items: [
          ...STAGES.map((s) => ({ color: onPaper(STAGE_COLOR[s]), label: s === 'over' ? 'over' : STAGE_LABEL[s], shape: 'hex' as const })),
          { color: css(STAGE_COLOR.peak), label: 'no sightings nearby', shape: 'striped' },
          { color: css(GLOW), label: 'seen, last 10 days', shape: 'dot' },
          { color: css(GREY), label: 'rough location', shape: 'dot' },
        ],
      };
    },

    credits() {
      const weather = isLive()
        ? [
            { text: 'Observed weather this season: PRISM Climate Group, Oregon State University, via RCC-ACIS.', href: 'https://www.rcc-acis.org/' },
            { text: 'Weather forecast: Open-Meteo.com (CC BY 4.0).', href: 'https://open-meteo.com/' },
          ]
        : [];
      return [
        ...weather,
        { text: `${one} sightings: iNaturalist observers (CC0, CC BY and CC BY-NC records only). Photos are linked, never copied.`, href: `https://www.inaturalist.org/taxa/${data.species.inat_taxon}` },
        { text: 'Temperatures: Daymet v4 daily 1 km, Thornton et al., ORNL DAAC.', href: 'https://daymet.ornl.gov/' },
        { text: 'State outlines: US Census Bureau, via us-atlas.', href: 'https://github.com/topojson/us-atlas' },
      ];
    },
  };
}
