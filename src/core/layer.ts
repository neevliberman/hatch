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
 * The seam every data layer plugs into (plan section 6).
 * The app owns space (H3 cells) and time (TimeAxis); a layer only turns (cell, time) into pixels.
 */
export interface EmergenceLayer {
  id: string;
  title: string;
  kind: 'cell' | 'point' | 'volume';
  time: { start: Date; end: Date; stepMs: number; forecastFrom?: Date };
  resolutions: { min: number; max: number };
  load(q: { cells: string[]; res: number; t0: number; t1: number }): Promise<void>;
  render(ctx: { t: number; res: number; zoom: number; theme: Theme }): Layer[];
  probe?(cell: string, t: number): ProbeCard;
  caveats(): CaveatCard;
  legend(): LegendSpec;
}
