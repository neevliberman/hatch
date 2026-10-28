import type { HatchLayer } from '../core/layer';
import { MIDWEST_MARGIN } from '../layers/stages';
import type { MapHandle } from '../map/map';

export interface MarginNotes {
  /** Put the notes where they fit (or hide them). Cheap when neither shows: runs on every pan and zoom frame. */
  place(): void;
  /** The end note's two lines (the layer's HatchLayer.endNote), or null to fade it. */
  showEnd(words: [string, string] | null): void;
}

// Panels a note must stay clear of: the header, the dock (with the time slider and its ribbon), the key, the card,
// the phone's button stack, the recenter button, the town finder and an open About panel.
const blockers = () =>
  [...document.querySelectorAll('#top, #dock, #legend .legend-card, #legend .lg-chip, #probe:not([hidden]), #actions, #recenter:not([hidden]), #finder:not([hidden]), #drawer.open')]
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width && r.height);
const fits = (x: number, y: number, w: number, h: number, block: DOMRect[]) =>
  x >= 4 && y >= 4 && x + w <= window.innerWidth - 4 && y + h <= window.innerHeight - 4 &&
  block.every((r) => x + w <= r.left || x >= r.right || y + h <= r.top || y >= r.bottom);
const put = (el: HTMLElement, spot: [number, number] | null, tilt: number) => {
  el.classList.toggle('on', !!spot);
  if (spot) el.style.transform = `translate(${Math.round(spot[0])}px, ${Math.round(spot[1])}px) rotate(${tilt}deg)`;
  return spot;
};

/**
 * The notes on the map's empty paper. After the season the map goes one flat colour, which reads as "no data": a
 * margin note (the layer's own words, sketch and spot, HatchLayer.offSeason) says they are asleep. It only shows on
 * the fitted view, so it never sits on hexes, and fades as soon as any hexagon starts. When playback reaches the last
 * day, the layer's end note goes on the same paper: just under the margin note on a phone, just over it on a wide
 * screen. Never over the map's hexes, the dock or the slider's ribbon: with no room for it, only Replay and the
 * status message say it. Analogy: a sticky note on a paper map, moved to wherever it covers nothing.
 */
export function mountMarginNotes(
  app: HTMLElement,
  map: Pick<MapHandle, 'moved' | 'project'>,
  layers: () => readonly HatchLayer[],
  cursor: () => number,
  phone: MediaQueryList,
): MarginNotes {
  const note = document.createElement('div');
  note.id = 'asleep';
  note.setAttribute('aria-hidden', 'true'); // the screen-reader summary already says every hexagon is over
  let shownNote: unknown = null;
  const endEl = document.createElement('p');
  endEl.id = 'end-note';
  endEl.setAttribute('role', 'status');
  let endWords: [string, string] | null = null;
  let endClear = 0;
  app.append(note, endEl);

  const place = () => {
    // Runs on every pan and zoom frame: the cheap tests first, and no layout read unless a note will show.
    if (map.moved() || (!endWords && !note.classList.contains('on') && !layers().some((l) => l.offSeason?.(cursor())))) {
      put(note, null, 0);
      put(endEl, null, 0);
      return;
    }
    // The active layers' own note, only when every one of them has one to show (the layers cache this per day).
    const notes = layers().map((l) => l.offSeason?.(cursor()));
    const n = notes.length && notes.every(Boolean) ? notes[0]! : null;
    if (n && n !== shownNote) {
      shownNote = n;
      note.innerHTML = `<svg viewBox="0 0 64 34">${n.sketch}</svg><b>${n.title}</b><span>${n.line}</span>`;
    }
    const anchor = n?.at ?? notes.find(Boolean)?.at ?? MIDWEST_MARGIN;
    const atPhone = phone.matches ? map.project(anchor.phone) : null;
    const atWide = map.project(anchor.wide);
    const block = blockers();
    // Phone: centred on its spot under the data. Wide screen: starting at its spot east of the data, on blank paper,
    // which is also where a phone on its side (no room under the data) puts the end note.
    const spotFor = (w: number, h: number): [number, number] | null => {
      const tries: [number, number][] = [];
      if (atPhone) tries.push([atPhone[0] - w / 2, atPhone[1]]);
      if (atWide) tries.push([atWide[0], atWide[1] - h / 2]);
      return tries.find(([x, y]) => fits(x, y, w, h, block)) ?? null;
    };
    let box: [number, number, number, number] | null = null;
    if (n) {
      const { width: w, height: h } = note.getBoundingClientRect();
      const s = put(note, w && h ? spotFor(w, h) : null, -3); // none on a phone on its side (style.css)
      if (s) box = [s[0], s[1], w, h];
    } else put(note, null, 0);
    if (!endWords) return void put(endEl, null, 0);
    const { width: w, height: h } = endEl.getBoundingClientRect();
    let spot: [number, number] | null = null;
    if (box) {
      const [x0, y0, w0, h0] = box;
      const x = x0 + (w0 - w) / 2;
      const tries: [number, number][] = phone.matches ? [[x, y0 + h0 + 6], [x, y0 - h - 8]] : [[x, y0 - h - 8], [x, y0 + h0 + 6]];
      spot = tries.find(([tx, ty]) => fits(tx, ty, w, h, block)) ?? null;
    } else spot = spotFor(w, h);
    put(endEl, spot, -2);
  };
  return {
    place,
    showEnd(words) {
      clearTimeout(endClear);
      endWords = words;
      if (words) endEl.replaceChildren(words[0], Object.assign(document.createElement('small'), { textContent: words[1] }));
      // Emptied once faded, so the same words are announced again at the next ending.
      else endClear = window.setTimeout(() => endEl.replaceChildren(), 450);
      place();
    },
  };
}
