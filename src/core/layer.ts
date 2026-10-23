import type { Layer } from '@deck.gl/core';

/** Palette handed to layers so they never hard-code the app's look. */
export interface Theme {
  bg: string;
  hexEdge: [number, number, number, number];
  text: string;
}

export interface CaveatCard {
  title: string;
  /** 'synthetic' is rendered with a loud warning style; 'normal' is the default. */
  severity: 'normal' | 'synthetic';
  bullets: string[];
}

export interface ProbeCard {
  title: string;
  /** Colour chip drawn before the title (the hexagon's stage). */
  swatch?: string;
  lines: string[];
  /** Detail behind a "More" fold (a hover card leaves it out). */
  more?: string[];
  /** Optional outbound link (e.g. the iNaturalist photo). Linked, never rehosted. */
  link?: { href: string; label: string };
}

export interface LegendSpec {
  title: string;
  /** Colour stops from low to high, drawn as a ramp. */
  stops?: { color: string; label: string }[];
  /** Discrete keys, drawn as labelled swatches (hex) or glowing dots (dot). */
  items?: { color: string; label: string; shape: 'hex' | 'dot' | 'striped' }[];
  note?: string;
}

/**
 * The seam every data layer plugs into (plan v2 section 6). Deliberately tiny:
 * the app owns the map and the clock; a layer loads its own data and turns (time, zoom) into deck layers.
 * Which time range a layer wants to be scrubbed over is registration metadata (see registry.ts), not part of this contract.
 */
/** One stretch of a place's season on the explainer timeline, in days of year. */
export interface SpotSegment {
  from: number;
  to: number;
  color: string;
  label: string;
}

/** The explainer's "your spot" card: one place's season, drawn as a strip with today marked. */
export interface SpotStory {
  title: string;
  sentence: string;
  /** Days of year the strip spans, with the stages laid along it and real sightings as ticks. */
  span: [number, number];
  /** Axis labels: the day of year each month starts. */
  months: { doy: number; label: string }[];
  segments: SpotSegment[];
  ticks: number[];
  today: number;
}

/**
 * The visual About panel for a species (plan v2: "wow first, honesty one tap away"). Optional: a layer without one
 * falls back to its caveats() list. The fine print is always caveats(), so the honesty lives in one place.
 */
export interface Explainer {
  name: string;
  sci: string;
  /** Which drawing (ui/explainer.ts) to use for the animal; the strip and timeline take their colour from `accent`. */
  creature: 'moth' | 'firefly';
  accent: string;
  hook: string;
  /** Captions for the three sketched panels: how it spends winter, warmth wakes it, a warm spring vs a cool one. */
  steps: [{ title: string; text: string }, { title: string; text: string }, { title: string; text: string }];
  spotIntro: string;
  /** The season at a place (null = the layer's default spot), on the day `t`, called `name` when it has one (a
   * picked city, "you"). Null when there is nothing to show. */
  spot(lngLat: [number, number] | null, t: number, name?: string): SpotStory | null;
  /** How sure it is. The bold answer line is worked out from the bars (the forecast first, then what it is measured
   * against), so it always says what this layer's own scores say. `points`: a few short lines, each with a
   * handwritten lead-in ("checked", "real test"). */
  score?: { title: string; points: [string, string][]; bars: { label: string; days: number; best?: boolean }[] };
  finePrintLabel: string;
}

/** The season at a glance, drawn in the time slider's track. Each series has one value per day of the layer's range. */
export interface SeasonProfile {
  /** Stacked from the bottom: each colour's share (0-1) of the map on each day. */
  bands: { color: string; share: number[] }[];
  /** Animals seen per day, drawn as a line scaled to its own peak. */
  seen: number[];
  /** Handwritten notes on the line, at a day index. */
  notes: { at: number; text: string }[];
}

export interface OffSeasonNote {
  title: string;
  line: string;
  sketch: string;
  at: { wide: [number, number]; phone: [number, number] };
}

export interface HatchLayer {
  id: string;
  title: string;
  /** `wash`: ms since the map's first frame while the forecast washes in (south first, 900 ms in all), else undefined.
   * `playing` and `frac` (how far into the next step, 0 at rest) let a layer draw in-between frames during playback. */
  render(ctx: { t: number; zoom: number; theme: Theme; wash?: number; playing?: boolean; frac?: number }): Layer[];
  /** Is the season in full swing on day t (e.g. any hexagon starting or at peak)? Playback slows down for those days. */
  busy?(t: number): boolean;
  /** The note shown beside the replay button when playback reaches the last day: a headline and a nudge to replay. */
  endNote?: [string, string];
  /** Honesty one tap away. Required. */
  caveats(): CaveatCard;
  legend(): LegendSpec;
  /** "What's here" for hover/tap. `picked` is the data object under the pointer, if it belongs to this layer. */
  probe?(lngLat: [number, number], t: number, picked?: { layerId: string; object: unknown }): ProbeCard | null;
  /** Visual About panel; see Explainer. */
  explainer?(): Explainer;
  /** Points on the map at time t that place names must not cover (the sighting dots). Return the same array while
   * they are unchanged: the names are only re-placed when it changes. */
  points?(t: number): [number, number][];
  /** The season ribbon in the time slider's track (the active layer's own, so each species draws its season). */
  profile?(): SeasonProfile;
  /** The sightings made on day t itself: while paused they breathe (map.ts). */
  newest?(t: number): { lng: number; lat: number }[];
  /** A margin note for when nothing is out (after the season): a handwritten title, a muted line under it, a small
   * pen sketch (SVG markup in a 64x34 box), and where it goes: a [lng, lat] on empty paper beside the map's data, one
   * for a wide screen and one for a phone. Null while anything is out. A layer without it gets no note.
   * Return the same object each time: the note is only redrawn when it changes. */
  offSeason?(t: number): OffSeasonNote | null;
  /** Data sources to credit, rendered in the drawer. */
  /** Data sources, each a line of text; `href` links the line's source. */
  credits?(): { text: string; href?: string }[];
}

/** Forecast hexagon layers are named luna-forecast-r4/-r5/-r6, one per hexagon size (see lunaReplay.ts render). */
export const isForecast = (layerId: string | undefined) => /^(luna|firefly)-forecast/.test(layerId ?? '');
/** The hexagon layers (forecast and its stripes): the map draws lakes, rivers and roads over these, under the dots. */
export const isHexes = (layerId: string) => /^(luna|firefly)-(forecast|unseen)/.test(layerId);
