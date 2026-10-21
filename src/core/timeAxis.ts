const DAY = 86_400_000;

type Listener = () => void;

/**
 * The single clock of the app. Everything is UTC milliseconds so there is no
 * timezone/DST drift (a "day" is always exactly 86,400,000 ms).
 * Layers never keep their own clock; they are handed `cursor` at render time.
 */
export class TimeAxis {
  static readonly DAY = DAY;

  year: number;
  start = 0;
  end = 0;
  cursor = 0;
  /** Real "now" (injectable for tests). Shown as a marker when it falls inside the range. */
  readonly now: number;
  playing = false;
  /** Playback speed in days per second. */
  speed = 14;

  private listeners = new Set<Listener>();
  private raf = 0;
  private last = 0;
  private acc = 0;

  constructor(year: number, now = Date.now()) {
    this.now = now;
    this.year = year;
    this.setYear(year, Date.UTC(year, 5, 15));
  }

  /** Season window: 1 Mar - 31 Oct (inclusive) of the chosen year. */
  setYear(year: number, cursor?: number): void {
    const keepDoy = this.cursor ? (this.cursor - this.start) / DAY : 0;
    this.year = year;
    this.start = Date.UTC(year, 2, 1);
    this.end = Date.UTC(year, 9, 31);
    this.setCursor(cursor ?? this.start + Math.round(keepDoy) * DAY);
  }

  get days(): number {
    return Math.round((this.end - this.start) / DAY);
  }

  /** Cursor as a whole-day offset from the start (0..days). */
  get dayIndex(): number {
    return Math.round((this.cursor - this.start) / DAY);
  }

  /** Where "now" sits as a 0..1 fraction of the range, or null if outside the season. */
  get nowFraction(): number | null {
    if (this.now < this.start || this.now > this.end + DAY) return null;
    return (this.now - this.start) / (this.end - this.start);
  }

  setCursor(ms: number): void {
    const snapped = this.start + Math.round((ms - this.start) / DAY) * DAY;
    const next = Math.min(this.end, Math.max(this.start, snapped));
    if (next === this.cursor) return;
    this.cursor = next;
    this.emit();
  }

  setDayIndex(i: number): void {
    this.setCursor(this.start + i * DAY);
  }

  step(days: number): void {
    this.setCursor(this.cursor + days * DAY);
  }

  play(): void {
    if (this.playing) return;
    if (this.cursor >= this.end) this.cursor = this.start;
    this.playing = true;
    this.last = performance.now();
    this.acc = 0;
    const tick = (t: number) => {
      if (!this.playing) return;
      this.acc += ((t - this.last) / 1000) * this.speed;
      this.last = t;
      const whole = Math.floor(this.acc);
      if (whole >= 1) {
        this.acc -= whole;
        if (this.cursor >= this.end) this.cursor = this.start - DAY; // loop
        this.step(whole);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}

export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function dayOfYear(ms: number): number {
  const d = new Date(ms);
  return Math.round((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
}
