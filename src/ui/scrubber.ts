import { TimeAxis } from '../core/timeAxis';
import { NEXT, PAUSE, PLAY, PREV } from './icons';
import type { SeasonProfile } from '../core/layer';

/** Pick sensible tick marks for any range: years, months, days or hours. */
function makeTicks(start: number, end: number): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  const span = end - start;
  const s = new Date(start);
  if (span > 400 * TimeAxis.DAY) {
    const every = Math.ceil(span / TimeAxis.YEAR / 8);
    for (let y = s.getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= end; y += every) out.push({ at: Date.UTC(y, 0, 1), label: String(y) });
  } else if (span > 45 * TimeAxis.DAY) {
    for (let t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1); t <= end; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1))
      if (t >= start) out.push({ at: t, label: new Date(t).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) });
  } else if (span > 2 * TimeAxis.DAY) {
    for (let t = Math.ceil(start / TimeAxis.DAY) * TimeAxis.DAY; t <= end; t += TimeAxis.DAY * Math.ceil(span / TimeAxis.DAY / 8))
      out.push({ at: t, label: new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) });
  } else {
    for (let t = Math.ceil(start / TimeAxis.HOUR) * TimeAxis.HOUR; t <= end; t += TimeAxis.HOUR * Math.ceil(span / TimeAxis.HOUR / 8))
      out.push({ at: t, label: new Date(t).toISOString().slice(11, 16) });
  }
  return out;
}

/** The season ribbon in the track: stacked stage shares below, sightings as an ink line above. Drawn in a 1000 x 28
 * box stretched to the track, so the line keeps its width with non-scaling-stroke. */
function ribbon(p: SeasonProfile): string {
  const n = p.seen.length;
  if (n < 2) return '';
  const xs = p.seen.map((_, i) => ((i / (n - 1)) * 1000).toFixed(1));
  const edge = (h: number[]) => h.map((v, i) => `${xs[i]} ${(28 - v * 14).toFixed(2)}`);
  const base = Array<number>(n).fill(0);
  const areas = p.bands.map((b) => {
    const lo = edge(base).reverse();
    b.share.forEach((v, i) => (base[i]! += v));
    return `<path class="band" fill="${b.color}" vector-effect="non-scaling-stroke" d="M${edge(base).join('L')}L${lo.join('L')}Z"/>`;
  });
  const top = Math.max(...p.seen) || 1;
  const line = p.seen.map((v, i) => `${xs[i]} ${(13.5 - (v / top) * 12).toFixed(2)}`).join('L');
  return `<svg viewBox="0 0 1000 28" preserveAspectRatio="none">${areas.join('')}<path class="seen" d="M0 13.5L${line}L1000 13.5Z"/>` +
    `<path class="seen-line" d="M${line}" vector-effect="non-scaling-stroke"/>` +
    `<rect class="frame" width="1000" height="28" vector-effect="non-scaling-stroke"/></svg>` +
    p.notes.map((k) => `<span class="wave" style="left:${((k.at / (n - 1)) * 100).toFixed(2)}%">${k.text}</span>`).join('');
}

/** Bottom bar bound to a TimeAxis: play/pause, step, slider over the season ribbon, month ticks, "now" marker, keyboard.
 * Returns a function that redraws the ribbon (call it when the season or species changes). */
export function mountScrubber(root: HTMLElement, time: TimeAxis): (p: SeasonProfile | undefined) => void {
  root.innerHTML = `
    <div class="btns">
      <button id="t-prev" class="icon-btn" aria-label="Back one day (Left arrow)">${PREV}</button>
      <button id="t-play" class="icon-btn play" aria-label="Play (Space)"></button>
      <button id="t-next" class="icon-btn" aria-label="Forward one day (Right arrow)">${NEXT}</button>
    </div>
    <div class="date"><span id="t-date"></span><small id="t-doy"></small></div>
    <div class="track">
      <div class="ribbon" id="t-ribbon" aria-hidden="true"></div>
      <input id="t-range" type="range" min="0" step="1" aria-label="Date within season"
        aria-description="Behind the slider: how much of the map is at each stage on each day, and a line of sightings per day." />
      <div class="ticks" id="t-ticks" aria-hidden="true"></div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const range = $<HTMLInputElement>('t-range');
  const play = $<HTMLButtonElement>('t-play');
  const dateEl = $('t-date');
  const doyEl = $('t-doy');
  const ticks = $('t-ticks');
  const ribbonEl = $('t-ribbon');
  const dateBox = root.querySelector<HTMLElement>('.date')!;

  // Wave notes sit just right of their peak. When the thumb would cover one, slide it to the nearest free spot:
  // left of the peak, or just past the thumb on either side.
  const placeWaves = () => {
    const waves = ribbonEl.querySelectorAll<HTMLElement>('.wave');
    if (!waves.length) return;
    const w = ribbonEl.clientWidth;
    const half = range.offsetWidth - w; // the ribbon is inset half a thumb each side, so this is one thumb
    const x = (time.stepIndex / Math.max(1, time.steps)) * w;
    const clear = half / 2 + 4;
    for (const el of waves) {
      el.style.transform = '';
      const lw = el.offsetWidth;
      const anchor = el.offsetLeft; // label's left edge (peak + its margin)
      const peak = anchor - 4;
      const hits = (l: number) => x + clear > l && x - clear < l + lw;
      const spot = [anchor, peak - 4 - lw, x + clear, x - clear - lw].find((l) => !hits(l)) ?? anchor;
      if (spot !== anchor) el.style.transform = `translateX(${(spot - anchor).toFixed(1)}px)`;
    }
  };

  let rangeKey = '';
  const drawTicks = () => {
    const span = time.end - time.start;
    const parts = makeTicks(time.start, time.end).map(
      (k) => `<span class="tick" style="left:${(((k.at - time.start) / span) * 100).toFixed(2)}%"><i></i>${k.label}</span>`,
    );
    const nf = time.nowFraction;
    if (nf !== null) {
      parts.push(`<span class="now" style="left:${(nf * 100).toFixed(2)}%" title="Today"><b>now</b></span>`);
    }
    ticks.innerHTML = parts.join('');
  };

  const sync = () => {
    range.max = String(time.steps);
    range.value = String(time.stepIndex);
    // Where the thumb is, 0-1: the phone's date pill rides above it.
    root.style.setProperty('--p', String(time.stepIndex / Math.max(1, time.steps)));
    const label = time.label(time.cursor);
    const after = time.cursor > time.now ? 'after today' : '';
    range.setAttribute('aria-valuetext', label);
    if (dateEl.textContent !== label || doyEl.textContent !== after) {
      // "Jun 10 (all years)": the aside in brackets is set in the handwriting face.
      const [day, aside] = label.split(/ (?=\()/);
      const em = document.createElement('em');
      em.textContent = aside ?? '';
      dateEl.replaceChildren(day!, ...(aside ? [' ', em] : []));
      doyEl.textContent = after;
      // Half the date pill's width, so on a phone the pill stops at the bar's edges instead of hanging off them.
      root.style.setProperty('--half', `${Math.ceil(dateBox.offsetWidth / 2) + 4}px`);
    }
    if (rangeKey !== `${time.start}|${time.end}`) {
      rangeKey = `${time.start}|${time.end}`;
      drawTicks();
    }
    play.setAttribute('aria-label', time.playing ? 'Pause (Space)' : 'Play (Space)');
    play.classList.toggle('on', time.playing);
    play.innerHTML = time.playing ? PAUSE : PLAY;
    placeWaves();
  };

  // The first Play of a visit starts from the beginning of the season, so it shows the wave rolling north
  // rather than the end of it. Once the reader has moved the time themselves, Play starts where they left it.
  let touched = false;
  let glideRaf = 0;
  let glideTimer = 0;
  let gliding = false;
  const touch = () => ((touched = true), (gliding = false), cancelAnimationFrame(glideRaf), clearTimeout(glideTimer));
  const playFromStart = () => {
    touched = true;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || time.stepIndex === 0) return (time.setStepIndex(0), time.play());
    const from = time.stepIndex;
    const { start, end } = time;
    gliding = true;
    const t0 = performance.now();
    const frame = (t: number) => {
      if (time.start !== start || time.end !== end) return touch(); // the season changed under the rewind
      const k = Math.min(1, (t - t0) / 400);
      time.setStepIndex(Math.round(from * (1 - (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)))); // ease in-out
      if (k < 1) glideRaf = requestAnimationFrame(frame);
      else glideTimer = window.setTimeout(() => ((gliding = false), time.play()), 250);
    };
    glideRaf = requestAnimationFrame(frame);
  };

  range.addEventListener('input', () => (touch(), time.setStepIndex(Number(range.value))));
  range.addEventListener('pointerdown', () => (touch(), time.pause()));
  // A press during the rewind stops it, like Pause would.
  const togglePlay = () => (gliding ? touch() : !touched && !time.playing ? playFromStart() : (touch(), time.toggle()));
  play.addEventListener('click', togglePlay);
  $('t-prev').addEventListener('click', () => (touch(), time.pause(), time.step(-1)));
  $('t-next').addEventListener('click', () => (touch(), time.pause(), time.step(1)));

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onRange = t === range; // native range already handles arrows
    // Other controls own their keys: Space ticks a checkbox or opens the season menu, arrows move inside a select.
    if (!onRange && t.closest('input, select, textarea, a, [contenteditable]')) return;
    const onButton = t instanceof HTMLButtonElement;
    const big = e.shiftKey ? 7 : 1;
    // On the slider itself, plain arrows are the slider's own step: let the browser move it.
    if (onRange && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return (touch(), time.pause());
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) touch();
    switch (e.key) {
      case 'ArrowLeft':
        time.pause();
        time.step(-big);
        break;
      case 'ArrowRight':
        time.pause();
        time.step(big);
        break;
      case 'Home':
        time.pause();
        time.setStepIndex(0);
        break;
      case 'End':
        time.pause();
        time.setStepIndex(time.steps);
        break;
      case ' ':
        if (onButton) return; // let the button's own click handle it
        togglePlay();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  time.subscribe(sync);
  sync();
  window.addEventListener('resize', placeWaves);
  return (p) => {
    ribbonEl.innerHTML = p ? ribbon(p) : '';
    placeWaves();
  };
}
