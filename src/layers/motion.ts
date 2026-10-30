import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';

// Playback motion any species layer can share: in-between frames, hex colour blending and arrival ripples.

const still = matchMedia('(prefers-reduced-motion: reduce)');

/** Draw in-between frames? Only while playing, never under reduced motion, so a hand-scrubbed map matches the slider. */
export const animating = (playing?: boolean) => !!playing && !still.matches;

/**
 * Forecast hexes blend into their next colour over 140 ms while playback glides. The blending layer gets its own id
 * suffix (`id`), so at rest, on a hand-scrubbed day, or in a slow device's day-step playback, a plain layer with no
 * transition at all draws the hexes: no GPU blend pass and no extra frame per day. Switching one layer's transition
 * off instead (0, null, or a zero duration) made deck draw it from a freed buffer, and the hexes went blank.
 */
const BLEND = { id: '-blend', transitions: { getFillColor: 140 } };
const PLAIN = { id: '', transitions: undefined };
// Hand-scrubbing the day or switching species: a gentle eased wash (not a snap) of fill, with the pale ink edge bleeding
// in a touch slower, like watercolour settling into paper. Only on a change, so a still map costs nothing extra.
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const SOFT = { id: '-soft', transitions: { getFillColor: { duration: 260, easing: easeOut }, getLineColor: { duration: 420, easing: easeOut } } };
export const hexFade = (anim: boolean) => (anim ? BLEND : still.matches ? PLAIN : SOFT);

type Ring<T> = { s: T; at: number };

/**
 * Rings that spread from each sighting on the day it is seen, while playing: 4 to 18 px, fading out over 0.6 s with
 * an ease-out, at most 40. One per layer (it remembers the rings in flight); `color` is the layer's own rim colour.
 * `seen(from, to)` gives the sightings from day `from` to day `to`, both included: a slow frame that moves the clock
 * several days still rings every one of them.
 */
export function ripples<T>(id: string, pos: (s: T) => [number, number], color: () => readonly number[]) {
  let rings: Ring<T>[] = [];
  let ringDay = -1;
  return (anim: boolean, doy: number, seen: (from: number, to: number) => T[]): Layer[] => {
    const now = performance.now();
    if (!anim) rings = [];
    else if (ringDay !== doy) {
      // From the day after the last one rung; just today when starting, or after a jump back or a long skip.
      const from = ringDay >= 0 && doy > ringDay && doy - ringDay <= 7 ? ringDay + 1 : doy;
      rings = [...rings, ...seen(from, doy).map((s) => ({ s, at: now }))].slice(-40);
    }
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
            getLineColor: (r) => {
              const c = color();
              return [c[0]!, c[1]!, c[2]!, 204 - 204 * age(r)];
            },
          }),
        ]
      : [];
  };
}
