import type { TimeAxis } from '../core/timeAxis';

const DAY = 86_400_000;
/** How far before the landing day the opening starts: early enough that only the far south has begun. */
const LEAD_DAYS = 60;
/** Days a second: about 4 s from first moths in the south to the landing day. */
const SPEED = 14;

export interface Intro {
  /** Is the opening playing right now? Playback listeners that react to the reader's own Play can ignore it. */
  readonly running: boolean;
  /** Start playing. Separate from setup so the caller holds the Intro before playback's first listeners run. */
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
  const stop = () => {
    if (!running) return;
    running = false;
    off();
    removeEventListener('pointerdown', stop, true);
    removeEventListener('keydown', stop, true);
    removeEventListener('wheel', stop, true);
    time.pace = pace;
    time.pause();
    time.setCursor(target);
  };
  const start = () => {
    if (running) return;
    running = true;
    addEventListener('pointerdown', stop, true);
    addEventListener('keydown', stop, true);
    addEventListener('wheel', stop, true);
    off = time.subscribe(() => running && time.cursor >= target && stop());
    time.pace = () => SPEED;
    time.speed = SPEED;
    time.setCursor(Math.max(time.start, target - LEAD_DAYS * DAY));
    time.play();
  };
  return {
    get running() {
      return running;
    },
    start,
    finish: stop,
  };
}
