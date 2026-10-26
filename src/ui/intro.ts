import type { TimeAxis } from '../core/timeAxis';

const DAY = 86_400_000;
/** How far before the landing day the opening starts: early enough that only the far south has begun. */
const LEAD_DAYS = 60;
/** Days a second: about 4 s from first moths in the south to the landing day. */
const SPEED = 14;

export interface Intro {
  /** Is the opening on (set up or playing)? Playback listeners that react to the reader's own Play can ignore it. */
  readonly running: boolean;
  /** Go to the opening's first day and listen for input. Separate from making it, so the caller holds the Intro (and
   * its `running`) before the first day's listeners run. Call it before the map's first frame, so that frame already
   * shows the first day: no flash of the landing day before it jumps back. */
  begin(): void;
  /** Start playing from the first day. Does nothing once finished. */
  start(): void;
  /** Jump to the landing day and stop (any touch, click, key or wheel does this). */
  finish(): void;
}

/** First visit: the season plays itself once, from the first moths in the south to `target`, then stops there, so the
 * first thing a visitor sees is the forecast moving north. Any input skips straight to `target`, which is the same
 * still view a visitor with motion turned off gets. */
export function makeIntro(time: TimeAxis, target: number): Intro {
  const pace = time.pace;
  let running = false;
  let off = () => {};
  const swallow = (e: Event) => (e.stopPropagation(), e.preventDefault());
  const stop = () => {
    if (!running) return;
    running = false;
    off();
    removeEventListener('pointerdown', onInput, true);
    removeEventListener('keydown', onInput, true);
    removeEventListener('wheel', stop, true);
    time.pace = pace;
    time.pause();
    time.setCursor(target);
  };
  // Input lands it; a modifier or Tab alone doesn't count. On Play/Pause, or Space (its shortcut), the press only lands
  // it: the click or toggle that follows is eaten, or it would start playing again from the landing day.
  const onInput = (e: Event) => {
    if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
    const onPlay = e.target instanceof Element && !!e.target.closest('#t-play');
    stop();
    if (e instanceof KeyboardEvent && e.key === ' ') swallow(e);
    if (onPlay) {
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true), 1000); // no click came (a drag off the button)
    }
  };
  const begin = () => {
    if (running) return;
    running = true;
    addEventListener('pointerdown', onInput, true);
    addEventListener('keydown', onInput, true);
    addEventListener('wheel', stop, true);
    off = time.subscribe(() => running && time.cursor >= target && stop());
    time.setCursor(Math.max(time.start, target - LEAD_DAYS * DAY));
  };
  const start = () => {
    if (!running || time.playing) return;
    time.pace = () => SPEED;
    time.speed = SPEED;
    time.play();
  };
  return {
    get running() {
      return running;
    },
    begin,
    start,
    finish: stop,
  };
}
