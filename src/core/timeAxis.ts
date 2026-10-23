const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365.25 * DAY; // nominal; year-step axes use stepMs = YEAR and snap to whole steps

type Listener = () => void;

/** What a layer wants the scrubber to span. All values are absolute UTC milliseconds. */
export interface TimeSpec {
  start: number;
  end: number;
  /** Native step: DAY for a season layer, YEAR for a spread sim, MINUTE*5 for radar. */
  stepMs: number;
  /** Where the cursor starts (defaults to start). */
  initial?: number;
  /** Custom date label, e.g. "Jun 10 · typical year" when the year itself means nothing. */
  label?: (ms: number) => string;
  /** Live data: the last day of observed weather (later days are forecast), and whether the nightly file looks late. */
  asOf?: { at: number; stale: boolean };
}

/**
 * The single clock of the app: absolute UTC ms, any range, any step.
 * Layers never keep their own clock; they are handed `cursor` at render time.
 */
export class TimeAxis {
  static readonly MINUTE = MINUTE;
  static readonly HOUR = HOUR;
  static readonly DAY = DAY;
  static readonly YEAR = YEAR;

  start = 0;
  end = 0;
  stepMs = DAY;
  cursor = 0;
  label: (ms: number) => string = (ms) => formatTime(ms, this.stepMs);
  asOf: TimeSpec['asOf'] = undefined;
  /** Real "now" (injectable for tests). Shown as a marker when it falls inside the range. */
  readonly now: number;
  playing = false;
  /** Playback speed in steps per second. */
  speed = 14;
  /** While playing, how far the clock is into the next step (0..1), for in-between frames. 0 at rest, and always 0
   * under reduced motion (no in-between frames at all then). */
  frac = 0;
  /** Optional story pacing: the speed (steps/s) wanted at a cursor. Playback eases toward it over ~0.5 s. */
  pace?: (cursor: number) => number;

  private listeners = new Set<Listener>();
  private frames = new Set<Listener>();
  private raf = 0;
  private last = 0;
  private acc = 0;
  /** Set when frames run slow during a playback (a slow phone, a software-rendered browser): the rest of that
   * playback steps a day at a time, with no in-between frames, like reduced motion. Cleared by the next play(). */
  private slow = false;
  /** Set once the first frames of a playback come fast enough: only then does it glide. */
  private fast = false;
  private frameMs: number[] = [];
  private lastFrame = 0;
  /** Reduced motion: playback still steps a day at a time, but nothing glides between days. */
  private readonly still = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  constructor(spec: TimeSpec, now = Date.now()) {
    this.now = now;
    this.setSpec(spec);
  }

  setSpec(spec: TimeSpec): void {
    this.pause();
    this.start = spec.start;
    this.end = spec.end;
    this.stepMs = spec.stepMs;
    this.label = spec.label ?? ((ms) => formatTime(ms, this.stepMs));
    this.asOf = spec.asOf;
    this.cursor = this.snap(spec.initial ?? spec.start);
    this.emit();
  }

  /** Number of steps across the range. */
  get steps(): number {
    return Math.floor((this.end - this.start) / this.stepMs);
  }

  /** Is playback drawing in-between frames (playing, reduced motion off, and frames proven fast)? Layers
   * blend, glide and ripple only while this is true. */
  get gliding(): boolean {
    return this.playing && this.fast && !this.slow && !this.still?.matches;
  }

  get stepIndex(): number {
    return Math.round((this.cursor - this.start) / this.stepMs);
  }

  /** Where "now" sits as a 0..1 fraction of the range, or null if outside. */
  get nowFraction(): number | null {
    if (this.now < this.start || this.now > this.end) return null;
    return (this.now - this.start) / (this.end - this.start);
  }

  private snap(ms: number): number {
    const i = Math.round((ms - this.start) / this.stepMs);
    return this.start + Math.min(this.steps, Math.max(0, i)) * this.stepMs;
  }

  setCursor(ms: number): void {
    const next = this.snap(ms);
    if (next === this.cursor) return;
    this.cursor = next;
    this.emit();
  }

  setStepIndex(i: number): void {
    this.setCursor(this.start + i * this.stepMs);
  }

  /** Move by n native steps. */
  step(n: number): void {
    this.setCursor(this.cursor + n * this.stepMs);
  }

  play(): void {
    if (this.playing) return;
    if (this.cursor >= this.start + this.steps * this.stepMs) this.cursor = this.start;
    this.playing = true;
    this.last = this.lastFrame = performance.now();
    this.acc = 0;
    this.slow = this.fast = false;
    this.frameMs = [];
    const tick = (t: number) => {
      if (!this.playing) return;
      const raw = t - this.last;
      // A slow device still moves at about the set speed; a hidden tab (no frames for seconds) jumps at most a few days.
      const dt = Math.min(0.25, raw / 1000);
      this.last = t;
      this.watch(raw);
      this.ease(dt);
      this.acc += dt * this.speed;
      const whole = Math.floor(this.acc);
      const smooth = this.gliding;
      if (whole >= 1) {
        this.acc -= whole;
        this.frac = smooth ? this.acc : 0; // before the step, so its listeners already see the new day's fraction
        this.lastFrame = t;
        this.step(whole); // the day's own listeners redraw this frame, so the frame listeners sit it out
        if (this.stepIndex >= this.steps) return this.pause(); // stop on the last day instead of looping
      } else if (smooth && t - this.lastFrame >= 30) {
        // In-between frames at most about 30 a second: smooth enough, and half the drawing on a 60 Hz screen.
        this.lastFrame = t;
        this.frac = this.acc;
        this.frames.forEach((fn) => fn());
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.frac = 0;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Frame-time watch. A playback starts in plain day steps and only glides once its first 3 frames (after the
   * first, which carries the click) come fast, so a slow device never builds the blending layers at all. Whenever 2
   * frames take over 80 ms, or the last 3 to 8 average over 50 ms, the rest of this playback stays in day steps. */
  private watch(ms: number): void {
    if (this.slow || this.still?.matches) return;
    const f = this.frameMs;
    f.push(ms);
    if (f.length < 2) return;
    const seen = f.slice(1);
    const recent = seen.slice(-8);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if ((recent.length >= 3 && avg > 50) || seen.filter((x) => x > 80).length >= 2) {
      this.slow = true;
      this.frac = 0;
      if (this.fast) this.emit(); // redraw the day without its in-between state (no blend, no ripples)
    } else if (!this.fast && seen.length >= 3) {
      this.fast = true;
      this.emit(); // start gliding: the hexes switch to their blending layer
    }
  }

  /** Move speed toward pace() at up to 20 steps/s per second: 8 to 18 takes half a second, so it never jerks. */
  private ease(dt: number): void {
    if (!this.pace) return;
    const d = this.pace(this.cursor) - this.speed;
    this.speed += Math.sign(d) * Math.min(Math.abs(d), dt * 20);
  }

  /** Called on the in-between animation frames while playing (frac changes but the step does not; a frame that
   * changes the step goes to subscribe() listeners instead, so no frame draws twice). At most about 30 a second,
   * and never under reduced motion or once frames run slow. */
  onFrame(fn: Listener): void {
    this.frames.add(fn);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}

/** Format a cursor according to the axis step: years, days, or date+time for sub-day steps. */
export function formatTime(ms: number, stepMs: number): string {
  const d = new Date(ms);
  if (stepMs >= YEAR * 0.99) return String(d.getUTCFullYear());
  if (stepMs >= DAY) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return (
    d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) +
    ' UTC'
  );
}

export function dayOfYear(ms: number): number {
  const d = new Date(ms);
  return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
}
