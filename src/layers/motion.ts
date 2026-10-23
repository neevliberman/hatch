import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';

// Playback motion any species layer can share: in-between frames, hex colour blending and arrival ripples.

const still = matchMedia('(prefers-reduced-motion: reduce)');

/** Draw in-between frames? Only while playing, never under reduced motion, so a hand-scrubbed map matches the slider. */
export const animating = (playing?: boolean) => !!playing && !still.matches;

/** Forecast hexes blend into their next colour over 140 ms while playing. 1 ms, not 0, at rest: turning a colour
 * transition off makes deck draw the hexes from a freed buffer (blank). */
export const hexFade = (anim: boolean) => ({ getFillColor: anim ? 140 : 1 });

type Ring<T> = { s: T; at: number };

/**
 * Rings that spread from each sighting on the day it is seen, while playing: 4 to 18 px, fading out over 0.6 s with
 * an ease-out, at most 40. One per layer (it remembers the rings in flight); `color` is the layer's own rim colour.
 */
export function ripples<T>(id: string, pos: (s: T) => [number, number], color: readonly number[]) {
  let rings: Ring<T>[] = [];
  let ringDay = -1;
  return (anim: boolean, doy: number, today: () => T[]): Layer[] => {
    const now = performance.now();
    if (!anim) rings = [];
    else if (ringDay !== doy) rings = [...rings, ...today().map((s) => ({ s, at: now }))].slice(-40);
    ringDay = anim ? doy : -1;
    rings = rings.filter((r) => now - r.at < 600);
    const age = (r: Ring<T>) => 1 - (1 - (now - r.at) / 600) ** 3;
    return rings.length
      ? [
          new ScatterplotLayer<Ring<T>>({
            id,
            data: rings,
            getPosition: (r) => pos(r.s),
            filled: false,
            stroked: true,
            radiusUnits: 'pixels',
            lineWidthUnits: 'pixels',
            getLineWidth: 2,
            // A new array every frame, so these are re-read each frame (40 rings at most).
            getRadius: (r) => 4 + 14 * age(r),
            getLineColor: (r) => [color[0]!, color[1]!, color[2]!, 204 - 204 * age(r)],
          }),
        ]
      : [];
  };
}
