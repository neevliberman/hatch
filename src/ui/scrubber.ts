import { formatTime, TimeAxis } from '../core/timeAxis';

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

/** Bottom bar bound to a TimeAxis: play/pause, step, slider, month ticks, "now" marker, keyboard. */
export function mountScrubber(root: HTMLElement, time: TimeAxis): void {
  root.innerHTML = `
    <div class="bar-row">
      <div class="btns">
        <button id="t-prev" class="icon-btn" aria-label="Back one step (Left arrow)">&#9664;</button>
        <button id="t-play" class="icon-btn play" aria-label="Play (Space)"></button>
        <button id="t-next" class="icon-btn" aria-label="Forward one step (Right arrow)">&#9654;</button>
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
    dateEl.textContent = formatTime(time.cursor, time.stepMs);
    doyEl.textContent = time.cursor > time.now ? 'after today' : '';
    if (rangeKey !== `${time.start}|${time.end}`) {
      rangeKey = `${time.start}|${time.end}`;
      drawTicks();
    }
    play.setAttribute('aria-label', time.playing ? 'Pause (Space)' : 'Play (Space)');
    play.classList.toggle('on', time.playing);
    play.innerHTML = time.playing ? '&#10073;&#10073;' : '&#9654;';
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
    const onButton = t instanceof HTMLButtonElement;
    const big = e.shiftKey ? 7 : 1;
    switch (e.key) {
      case 'ArrowLeft':
        if (!onRange || e.shiftKey) (time.pause(), time.step(-big));
        break;
      case 'ArrowRight':
        if (!onRange || e.shiftKey) (time.pause(), time.step(big));
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
