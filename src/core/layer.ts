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
  lines: string[];
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
  score?: { title: string; text: string; bars: { label: string; days: number; best?: boolean }[] };
  finePrintLabel: string;
}

export interface HatchLayer {
  id: string;
  title: string;
  render(ctx: { t: number; zoom: number; theme: Theme }): Layer[];
  /** Honesty one tap away. Required. */
  caveats(): CaveatCard;
  legend(): LegendSpec;
  /** "What's here" for hover/tap. `picked` is the data object under the pointer, if it belongs to this layer. */
  probe?(lngLat: [number, number], t: number, picked?: { layerId: string; object: unknown }): ProbeCard | null;
  /** Visual About panel; see Explainer. */
  explainer?(): Explainer;
  /** Data sources to credit, rendered in the drawer. */
  /** Data sources, each a line of text; `href` links the line's source. */
  credits?(): { text: string; href?: string }[];
}
