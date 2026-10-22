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
  items?: { color: string; label: string; shape: 'hex' | 'dot' }[];
  note?: string;
}

/**
 * The seam every data layer plugs into (plan v2 section 6). Deliberately tiny:
 * the app owns the map and the clock; a layer loads its own data and turns (time, zoom) into deck layers.
 * Which time range a layer wants to be scrubbed over is registration metadata (see registry.ts), not part of this contract.
 */
export interface HatchLayer {
  id: string;
  title: string;
  render(ctx: { t: number; zoom: number; theme: Theme }): Layer[];
  /** Honesty one tap away. Required. */
  caveats(): CaveatCard;
  legend(): LegendSpec;
  /** "What's here" for hover/tap. `picked` is the data object under the pointer, if it belongs to this layer. */
  probe?(lngLat: [number, number], t: number, picked?: { layerId: string; object: unknown }): ProbeCard | null;
  /** Data sources to credit, rendered in the drawer. */
  credits?(): string[];
}
