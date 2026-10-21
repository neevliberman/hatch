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
}

export interface LegendSpec {
  title: string;
  /** Colour stops from low to high. */
  stops: { color: string; label: string }[];
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
  /** "What's here" for hover/tap. */
  probe?(lngLat: [number, number], t: number): ProbeCard;
}
