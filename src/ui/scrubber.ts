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

const svg = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
const PREV = svg('M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z');
const NEXT = svg('M8.6 18.6 10 20l8-8-8-8-1.4 1.4 6.6 6.6z');
const PLAY = svg('M8 5v14l11-7z');
const PAUSE = svg('M7 5h4v14H7zm6 0h4v14h-4z');

/** Bottom bar bound to a TimeAxis: play/pause, step, slider, month ticks, "now" marker, keyboard. */
export function mountScrubber(root: HTMLElement, time: TimeAxis): void {
  root.innerHTML = `
    <div class="bar-row">
      <div class="btns">
        <button id="t-prev" class="icon-btn" aria-label="Back one day (Left arrow)">${PREV}</button>
        <button id="t-play" class="icon-btn play" aria-label="Play (Space)"></button>
        <button id="t-next" class="icon-btn" aria-label="Forward one day (Right arrow)">${NEXT}</button>
      </div>
      <div class="date"><span id="t-date"></span><small id="t-doy"></small><span id="t-asof" class="asof" hidden></span></div>
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
  const asOfEl = $('t-asof');
  const md = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  let rangeKey = '';
  const drawTicks = () => {
    const span = time.end - time.start;
    const parts = makeTicks(time.start, time.end).map(
      (k) => `<span class="tick" style="left:${(((k.at - time.start) / span) * 100).toFixed(2)}%"><i></i>${k.label}</span>`,
    );
    // Live data: an "as of" flag on the last day of observed weather, and a paler track after it (the forecast part).
    // Data from before the track starts makes all of it forecast; data past its end, none.
    const a = time.asOf;
    const af = a && a.at >= time.start && a.at <= time.end ? (a.at - time.start) / span : null;
    range.style.setProperty('--fc', !a || a.at > time.end ? '100%' : af === null ? '0%' : `${(af * 100).toFixed(2)}%`);
    asOfEl.hidden = !a;
    asOfEl.classList.toggle('stale', !!a?.stale);
    if (a) {
      asOfEl.innerHTML = `as of ${md(a.at)}${a.stale ? '<span class="long"> · data may be stale</span><span class="phone-only"> · stale?</span>' : ''}`;
      asOfEl.title = a.stale
        ? `Weather observed up to ${md(a.at)}. Tonight's update looks late, so this may be out of date. Later days are forecast.`
        : `Weather observed up to ${md(a.at)}. Later days are forecast.`;
    }
    // The clock's own "now" flag still shows, unless it would sit on top of the as-of flag (the usual night: as of yesterday).
    const nf = a && Math.abs(time.now - a.at) <= 2 * 86_400_000 ? null : time.nowFraction;
    if (af !== null) {
      parts.push(`<span class="now asof-flag" style="left:${(af * 100).toFixed(2)}%" title="Last day of observed weather: ${md(a!.at)}"><b>as of</b></span>`);
    }
    if (nf !== null) {
      parts.push(`<span class="now" style="left:${(nf * 100).toFixed(2)}%" title="Today"><b>now</b></span>`);
    }
    ticks.innerHTML = parts.join('');
  };

  const sync = () => {
    range.max = String(time.steps);
    range.value = String(time.stepIndex);
    range.style.setProperty('--pct', `${(time.stepIndex / Math.max(1, time.steps)) * 100}%`);
    dateEl.textContent = time.label(time.cursor);
    // Screen readers hear when a day is forecast, as sighted users see from the lighter track.
    range.setAttribute('aria-valuetext', time.label(time.cursor) + (time.asOf && time.cursor > time.asOf.at ? ' (forecast)' : ''));
    doyEl.textContent = time.asOf ? (time.cursor > time.asOf.at ? 'forecast' : '') : time.cursor > time.now ? 'after today' : '';
    doyEl.classList.toggle('fc', !!time.asOf);
    const key = `${time.start}|${time.end}|${time.asOf?.at}|${time.asOf?.stale}`;
    if (rangeKey !== key) {
      rangeKey = key;
      drawTicks();
    }
    play.setAttribute('aria-label', time.playing ? 'Pause (Space)' : 'Play (Space)');
    play.classList.toggle('on', time.playing);
    play.innerHTML = time.playing ? PAUSE : PLAY;
  };

  range.addEventListener('input', () => time.setStepIndex(Number(range.value)));
  range.addEventListener('pointerdown', () => time.pause());
  play.addEventListener('click', () => time.toggle());
  $('t-prev').addEventListener('click', () => (time.pause(), time.step(-1)));
  $('t-next').addEventListener('click', () => (time.pause(), time.step(1)));

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onRange = t === range; // native range already handles arrows
    // Other controls own their keys: Space ticks a checkbox or opens the season menu, arrows move inside a select.
    if (!onRange && t.closest('input, select, textarea, a, [contenteditable]')) return;
    const onButton = t instanceof HTMLButtonElement;
    const big = e.shiftKey ? 7 : 1;
    // On the slider itself, plain arrows are the slider's own step: let the browser move it.
    if (onRange && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return time.pause();
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
        time.toggle();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  time.subscribe(sync);
  sync();
}
