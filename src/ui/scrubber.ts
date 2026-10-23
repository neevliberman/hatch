import { TimeAxis } from '../core/timeAxis';

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

// Drawn with the About sketches' pen (scripts/ui-icons.mjs prints these paths), so the controls match the hand.
const svg = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
const PREV = svg('M14.9 4.7l-.6.1-.7.5-.7.6-.8.6-2.8 2.4-.8.6-.8.7-.6.9-.3 1.1.3 1.2.7.8.8.7.9.5 1.4 1 .6.6.8.6.7.7.8.6.6.4.7.2.3-.4-.1-.6-1-1.4-1.3-1.5-1.4-1.4-.8-.6-1.3-1.1-.3-.3 0-.1.3-.3.5-.6.7-.6.8-.6.7-.7.6-.7.6-.8.7-.7.6-.8.4-.6.2-.7zm.2.2l-.5.3-.6.6-.7.6-1.5 1.5-.7.6-.6.6-1.6 1-.7.6-.5.6-.2.9.3.7.6.7.8.5.9.6.8.5 1.4 1.2 2.1 2.1.6.5.4.4.2-.2-.3-.5-1.1-1.3-.6-.8-.7-.8-.7-.7-.7-.6-.9-.6-.8-.6-.7-.5-.5-.4-.1-.3 0-.3.4-.4.6-.5.7-.5.8-.6.7-.6.7-.7 1.4-1.6 1.2-1.4.3-.5z');
const NEXT = svg('M8.9 4.9l.2.7.4.6.5.7.6.8.6.7.6.8.7.6.7.7.8.6.8.8 0 .1-.3.4-.6.5-1.5 1.3-.7.7-.6.7-.7.7-.6.8-.5.7-.4.7-.2.6.4.3.6-.1 1.3-1.1.8-.6.7-.7 1.3-1.1.7-.5.9-.6.7-.7.7-.8.4-1.2-.3-1.2-.7-.8-.8-.7-.8-.6-.7-.5-.6-.5-1.4-1.2-.7-.7-.7-.6-.6-.4-.6-.2zm-.4-.4l.3.6.6.6 1.3 1.5 1.4 1.4.6.7 1.4 1.2.5.5.4.5.1.3-.1.4-.3.5-.4.6-1.3 1.3-1.2 1.4-1.6 1.4-1.3 1.3-.4.6.2.2.6-.3.7-.5 1.7-1.3 1.5-1.3.6-.7.7-.6.7-.7.6-.7.4-.8.2-.9-.3-.8-.5-.7-.7-.7-.7-.5-1.4-1.2-.6-.6-2.3-2-.6-.6-.6-.2z');
export const PLAY = svg('M8.5 18.6l10.1-6.8-10.4-6.5zm-.5-13.6l.4.6.7.6 1.8 1.4 1 .6 1 .7 1 .6 1.1.7 1.2.6 1 .6 1 .5.8.1.2-.2-.5-.7-.8-.7-1-.7-1.1-.8-1.1-.7-1-.6-.9-.6-1.1-.7-1-.6-1.8-.9-.7-.1zm10.9 6.5l-.8.1-.9.4-1 .6-1.1.6-1 .7-1 .6-.9.7-1 .7-1.9 1.5-.7.7-.3.7.2.3.8-.1.8-.4 1.1-.5 1-.7 1.1-.7.9-.6.9-.7 1-.7 1.9-1.5.7-.7.4-.7zm-10.2 7.8l.2-.8.1-1.1 0-8.1-.1-1.4 0-1.3-.1-1.1-.3-.8-.3-.1-.3.8-.2 1.1-.3 4.2 0 2.7.2 2.8.2 1.3.2 1.1.3.7z');
export const PAUSE = svg('M8.5 4.9l-.7.8-.3 1.1-.3 3.8 0 2.5.2 2.7.2 1.3.2 1.1.7.7.7.1.7-.8.4-2.3.2-1.4 0-1.4.1-1.2-.1-1.3 0-1.3-.4-2.6-.3-1-.7-.8zm.5-.2l-.5.7-.2 1-.1 1.3-.2 1.3-.1 1.3 0 4.1.1 1.5 0 1.3.2 1.2.4.8.4 0 .4-.8.1-1.1.3-4.3 0-6.5-.1-1-.4-.8zm5.7.5l-.9.7-.3 1-.3 1.2-.2 1.3-.1 1.3 0 2.4.1 1.4.2 1.4.3 1.2.3 1.1.9.7.9 0 .8-.8.3-1 .3-1.3.2-2.7 0-2.4-.1-1.3-.2-1.3-.2-1.1-.3-1-.8-.8zm.5-.2l-.4.7-.3.9-.6 3.7-.1 1.3.2 2.7.4 2.7.3 1 .4.8.4 0 .2-.9 0-2.4-.1-1.3 0-3.7.2-2.5 0-2.2-.2-.7z');
/** A loop arrow, for starting the season over. */
export const REPLAY = svg('M6.1 7.8l-.3.2-.2.2-.6.8-.3.5-.2.4-.2.5-.2.4-.3 1.5 0 .9.1.5 0 .5.2.4.1.5.1.4.2.4.2.5.3.4.2.5.9 1.2.4.3.3.4.4.3.5.3.4.3.5.2.5.1.5.2.5 0 .5.1.4.1.4 0 .5.1.9 0 1.4-.3.5-.2.4-.2.5-.2.4-.2.4-.3.4-.2.8-.6.4-.4.4-.3.3-.4.3-.5.2-.4.4-1 .5-2.2 0-1.4-.1-.5 0-.5-.1-.5-.2-.5-.1-.5-.4-.8-.2-.5-.3-.3-.6-.8-.3-.3-.4-.3-1-.6-.4-.2-.4-.1-.3 0-.2.3.1.3.4.2.4.3.3.3.4.3.3.3.6.9.2.4.2.3.4 1.6 0 .4.1.4 0 .8-.1.4 0 .4-.1.3-.3 1.2-.1.3-.1.4-.2.4-.2.3-.2.2-.2.3-.3.3-.3.2-.3.3-.3.2-.4.2-.3.2-.4.2-.3.2-.4.1-.4.2-.3 0-.3.1-1.8 0-.4-.1-.4 0-1.2-.3-.3-.1-.9-.6-.3-.3-.3-.2-.3-.3-.7-1-.2-.4-.2-.3-.2-.4-.1-.4-.2-.3-.2-.8-.1-.3 0-1.1.1-.5 0-.4.2-.8.2-.4.1-.4.6-1.2 0-.3zm-.2-.4l-.3.2-.2.4-.6.8-.3.5-.2.5 0 1.5.1.4 0 .5.1.4 0 1.6.1.5.1.4.6 1.5.3.4.3.5.3.4.3.3.2.4.3.3.4.2.3.3.4.3 1 .4.5.1.6.2 1 .2.8.2 1.3 0 .5-.1.4-.1.8-.4.4-.3.4-.2 1.6-1.2 1.2-1.2.2-.4.2-.3.2-.8.1-.3.1-.4.2-.4.1-.4.4-1 .1-.6 0-.5-.1-.5-.2-.6-.2-.4-.3-.5-.2-.4-.3-.4-.2-.4-.6-.6-.2-.4-.9-.9-.3-.4-1.2-1.2-.2.1.1.3.2.4.3.3.3.5.3.4.3.3.2.4.3.3.2.4.3.3.2.3.6 1.2.3.4.1.4.2.4 0 .7-.1.4-.2.4-.1.5-.2.4-.2.5-.1.4-.3.9-.2.3-.2.2-.2.3-.7.7-1.2.9-.4.2-.3.2-.4.2-.6.4-.3.1-1.3 0-.4-.1-.4 0-.5-.1-.4-.2-1-.2-.5-.2-.3-.2-.4-.1-1-1-.2-.3-.3-.3-.6-.8-.2-.5-.4-.8-.1-.3 0-.4-.1-.3 0-.8-.1-.5 0-.4-.3-1.4 0-.7.1-.4.2-.5.3-.4.2-.5.2-.4.1-.3zm14.5-2.3l-.7-.3-.9-.2-1.2-.1-1.2.1-1.1.2-1 .6-.3 1.2.2 1.1.4 1.1.5 1.1.4.8.6.5.3-.1.1-.7-.6-2-.2-1-.1-.8.1-.2.2-.1.7-.2 1.1-.2 1.1 0 .9-.2.7-.3z');
/** The close and fold cross. */
export const CROSS = svg('M6.4 6.5l.2 1 .7 1 .9 1.1 2 2.2 2 2 2.2 2 1.2.9.9.7 1 .2.4-.4-.3-1-.7-.9-.9-1.1-2-2.2-2-2-2.2-2-1.1-.9-1-.7-.9-.3zm11-.1l-.9.3-.9.6-1.1.9-1.2.9-1.1 1-1 1-2 2.2-1.9 2.3-.7 1-.3 1 .4.3.9-.4.9-.7 1.1-1 1.1-1.1 1.1-1 1-1 .9-1 2.1-2.1.9-1 .7-1 .3-.8z');

/** Bottom bar bound to a TimeAxis: play/pause, step, slider, month ticks, "now" marker, keyboard. */
export function mountScrubber(root: HTMLElement, time: TimeAxis): void {
  root.innerHTML = `
    <div class="bar-row">
      <div class="btns">
        <button id="t-prev" class="icon-btn" aria-label="Back one day (Left arrow)">${PREV}</button>
        <button id="t-play" class="icon-btn play" aria-label="Play (Space)"></button>
        <button id="t-next" class="icon-btn" aria-label="Forward one day (Right arrow)">${NEXT}</button>
      </div>
      <div class="date"><span id="t-date"></span><small id="t-doy"></small></div>
    </div>
    <div class="track">
      <input id="t-range" type="range" min="0" step="1" aria-label="Date within season" />
      <div class="ticks" id="t-ticks" aria-hidden="true"></div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const range = $<HTMLInputElement>('t-range');
  const play = $<HTMLButtonElement>('t-play');
  const dateEl = $('t-date');
  const doyEl = $('t-doy');
  const ticks = $('t-ticks');

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
    range.style.setProperty('--pct', `${(time.stepIndex / Math.max(1, time.steps)) * 100}%`);
    // "Jun 10 (all years)": the aside in brackets is set in the handwriting face.
    const [day, aside] = time.label(time.cursor).split(/ (?=\()/);
    const em = document.createElement('em');
    em.textContent = aside ?? '';
    dateEl.replaceChildren(day!, ...(aside ? [' ', em] : []));
    range.setAttribute('aria-valuetext', time.label(time.cursor));
    doyEl.textContent = time.cursor > time.now ? 'after today' : '';
    if (rangeKey !== `${time.start}|${time.end}`) {
      rangeKey = `${time.start}|${time.end}`;
      drawTicks();
    }
    play.setAttribute('aria-label', time.playing ? 'Pause (Space)' : 'Play (Space)');
    play.classList.toggle('on', time.playing);
    play.innerHTML = time.playing ? PAUSE : PLAY;
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
}
