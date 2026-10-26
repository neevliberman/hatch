import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import { onTheme, palette } from '../theme';
import { dayOfYear, TimeAxis } from '../core/timeAxis';
import type { CaveatCard, LegendSpec, ProbeCard, SeasonProfile, SpeciesWords } from '../core/layer';
import { doyToMs, LIVE, UNCONFIRMED } from './lunaData';
import type { Live } from './liveData';
import { APPROXIMATE, toSighting, TYPICAL, type Mode, type Sighting } from './replayData';
import { animating, ripples } from './motion';
import { GLOW_DAYS, modeLabel, replayTimeSpec, type LunaLayer } from './lunaReplay';

type RGBA = [number, number, number, number];

/** What a migrant's tracker says in its own words (src/species/monarch.ts, redAdmiral.ts). */
export interface FrontConfig {
  /** The ?species= value; layer ids start with it. */
  key: string;
  name: string;
  /** "Monarch seen Jun 3". */
  one: string;
  /** The animals in the page's words (header, menus, share sheet). */
  words: SpeciesWords;
  /** Adults, for the dots bullet: "adult monarchs". */
  adults: string;
  glow: RGBA;
  /** The species' own fine-print bullets: why it is a tracker and how well the usual date does. */
  notes: string[];
}

/** Shape of public/species/<key>/front.json (pipeline/front/build_front.py). */
export interface FrontFile {
  version: number;
  kind: string;
  species: { name: string; sci: string; inat_taxon: number };
  years: number[];
  sightings: [number, number, number, number, number, number][];
}

export const isFront = (js: unknown): js is FrontFile => {
  const f = js as FrontFile | null;
  return !!f && f.kind === 'front' && Array.isArray(f.sightings) && Array.isArray(f.years);
};

const TYPICAL_AXIS_YEAR = 2025;
const fmtDoy = (year: number, doy: number) =>
  new Date(doyToMs(year, Math.round(doy))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * A migrant's spring arrival as a tracker, not a forecast: its sightings so far this spring as dots (the last ten
 * days bright, older ones small), so the bright band moves north as the spring plays. Same seams as
 * the species layers (LunaLayer), without hexagons: a migrant's date is not set by warmth (see pipeline/front).
 */
export function createFrontLayer(cfg: FrontConfig, file: FrontFile, initial: Mode = TYPICAL, liveIn: Live | null = null): LunaLayer {
  let live = liveIn;
  const { key, one, words } = cfg;
  const plural = words.plural;
  const past: Sighting[] = file.sightings.map(toSighting);
  const sightingsFor = (m: Mode): Sighting[] => (m === LIVE ? (live?.sightings ?? []) : m === TYPICAL ? past : past.filter((s) => String(s.year) === m));
  let mode: Mode = initial === LIVE && !live ? TYPICAL : initial;
  let shown = sightingsFor(mode);
  const isLive = () => mode === LIVE && live !== null;
  const yearOf = () => (mode === TYPICAL ? TYPICAL_AXIS_YEAR : isLive() ? live!.season : Number(mode));
  const day = (s: Sighting) => (mode === TYPICAL ? s.pdoy : s.doy);
  const filterExt = [new DataFilterExtension({ filterSize: 1 })];
  const rings = ripples<Sighting>(`${key}-ripples`, (s) => [s.lng, s.lat], () => palette.dotRim);
  const profiles = new Map<Mode, SeasonProfile>();
  onTheme(() => profiles.clear());

  // A spring with thousands of dots out at once shrinks them on the zoomed-out map, and they grow back as you zoom in.
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

  let fresh = { key: '', list: [] as Sighting[] };
  let lit: { key: string; pts: [number, number][] } = { key: '', pts: [] };
  const isDot = (id: string) => id === `${key}-dots` || id === `${key}-glow`;

  return {
    id: `${key}-front`,
    tracker: true,
    title: `${cfg.name} arrival`,
    words,
    mode: () => mode,
    setMode(m) {
      mode = m;
      shown = sightingsFor(m);
    },
    live: () => live,
    setLive(l) {
      live = l;
      profiles.delete(LIVE);
      if (mode === LIVE) shown = sightingsFor(mode);
    },
    res: () => 4,
    cellAt: () => null,
    seasonCount: (m: Mode) => sightingsFor(m).length,
    endNote: ['That was the spring arrival.', 'Press replay to watch again'],
    countdown(now) {
      const d = new Date(now);
      const m = d.getUTCMonth();
      return m >= 3 && m <= 6 ? ['Arriving now', ''] : [`Next arrivals: about April ${d.getUTCFullYear() + (m > 6 ? 1 : 0)}`, ''];
    },

    newest(t) {
      const doy = dayOfYear(t);
      if (fresh.key !== `${doy}|${mode}`) fresh = { key: `${doy}|${mode}`, list: shown.filter((s) => day(s) === doy) };
      return fresh.list;
    },

    points(t) {
      const k = `${dayOfYear(t)}|${mode}`;
      if (lit.key !== k) {
        const doy = dayOfYear(t);
        lit = { key: k, pts: shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).map((s) => [s.lng, s.lat]) };
      }
      return lit.pts;
    },

    summary(t) {
      const doy = dayOfYear(t);
      const recent = shown.filter((s) => day(s) <= doy && day(s) > doy - GLOW_DAYS).length;
      return `${fmtDoy(yearOf(), doy)}, ${modeLabel(mode, live)}. ${recent} ${recent === 1 ? one.toLowerCase() : plural} seen in the last ${GLOW_DAYS} days.`;
    },

    // Sightings per day over the slider's range, smoothed over a week; one fixed band keeps the slider cut to the days with sightings.
    profile() {
      let p = profiles.get(mode);
      if (!p) {
        const { start, end } = replayTimeSpec(String(yearOf()));
        const d0 = dayOfYear(start);
        const n = Math.round((end - start) / TimeAxis.DAY) + 1;
        const raw = new Array<number>(n).fill(0);
        for (const s of shown) {
          const i = Math.round(day(s)) - d0;
          if (i >= 0 && i < n) raw[i]!++;
        }
        const seen = raw.map((_, i) => {
          let sum = 0;
          for (let j = i - 3; j <= i + 3; j++) sum += raw[Math.min(n - 1, Math.max(0, j))]!;
          return sum / 7;
        });
        profiles.set(mode, (p = { bands: [{ color: 'rgba(0,0,0,0)', share: new Array<number>(n).fill(1) }], seen, notes: [] }));
      }
      return p;
    },

    render({ t, zoom, playing, frac = 0 }) {
      const doy = dayOfYear(t);
      const anim = animating(playing);
      const d = anim ? doy + frac : doy;
      const radiusScale = dotScale(zoom);
      const recent = {
        getFilterValue: day,
        filterRange: [d - GLOW_DAYS + 0.5, d + 0.5] as [number, number],
        filterSoftRange: [d - 0.5, d + 0.5] as [number, number],
        filterTransformSize: true,
        filterTransformColor: true,
        extensions: filterExt,
      };
      const older = {
        getFilterValue: day,
        filterRange: [-1000, d - GLOW_DAYS + 0.5] as [number, number],
        filterSoftRange: [-1000, d - GLOW_DAYS - 0.5] as [number, number],
        filterTransformSize: true,
        filterTransformColor: true,
        extensions: filterExt,
      };
      return [
        new ScatterplotLayer<Sighting>({
          id: `${key}-older`,
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: [cfg.glow[0], cfg.glow[1], cfg.glow[2], 120],
          radiusUnits: 'pixels',
          getRadius: 2.6,
          radiusScale,
          pickable: false,
          updateTriggers: { getFilterValue: [mode] },
          ...older,
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
          ...recent,
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
          ...recent,
        }),
        new ScatterplotLayer<Sighting>({
          id: `${key}-dots`,
          data: shown,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: (s) => {
            const c = s.flags & APPROXIMATE ? palette.rough : cfg.glow;
            return s.flags & UNCONFIRMED ? [c[0], c[1], c[2], 150] : c;
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
          ...recent,
        }),
        ...rings(anim, doy, (from, to) => shown.filter((s) => day(s) >= from && day(s) <= to)),
      ];
    },

    probe(_lngLat, _t, picked): ProbeCard | null {
      if (!picked || !isDot(picked.layerId)) return null;
      const s = picked.object as Sighting;
      return {
        title: `${one} seen ${fmtDoy(s.year, s.doy)}, ${s.year}`,
        lines: s.flags & APPROXIMATE ? ['Rough location: small, dark dot.'] : [],
        link: { href: `https://www.inaturalist.org/observations/${s.id}`, label: 'Photo on iNaturalist' },
      };
    },

    caveats(): CaveatCard {
      const ys = file.years;
      return {
        title: `${cfg.name}: fine print`,
        severity: 'normal',
        bullets: [
          `A tracker, not a forecast. ${cfg.name}s arrive from the south, so warmth does not set their date and Hatch makes no prediction.`,
          ...cfg.notes,
          isLive()
            ? `Dots: this spring’s iNaturalist photos of ${cfg.adults} (${file.species.sci}), ${shown.length ? `${shown.length.toLocaleString()} so far` : 'none yet'}. Fainter dots are pending: not yet confirmed. Updated nightly.`
            : `Dots: ${past.length.toLocaleString()} iNaturalist photos of ${cfg.adults} (${file.species.sci}), 1 March to 15 July, ${ys[0]}-${ys[ys.length - 1]}. Bright for ${GLOW_DAYS} days, then small.`,
          `Sightings show where people look as much as where ${plural} are. A late first dot may only mean nobody looked sooner.`,
          'Only openly licensed photos are drawn. Gray dots: rough location, so the dot may be off.',
        ],
      };
    },

    legend(): LegendSpec {
      const c = cfg.glow;
      return {
        title: 'Seen',
        items: [
          { color: `rgb(${c[0]},${c[1]},${c[2]})`, label: 'last 10 days', shape: 'dot' },
          { color: `rgba(${c[0]},${c[1]},${c[2]},0.47)`, label: 'earlier', shape: 'dot' },
          ...(isLive() ? [{ color: `rgba(${c[0]},${c[1]},${c[2]},0.59)`, label: 'pending (not yet confirmed)', shape: 'dot' as const }] : []),
        ],
      };
    },

    offSeason: () => null,

    credits() {
      return [
        { text: `${cfg.name} sightings: iNaturalist observers (CC0, CC BY and CC BY-NC records only). Photos are linked, never copied.`, href: `https://www.inaturalist.org/taxa/${file.species.inat_taxon}` },
        { text: 'State outlines: US Census Bureau, via us-atlas.', href: 'https://github.com/topojson/us-atlas' },
      ];
    },
  };
}

