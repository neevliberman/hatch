import { formatDay, TimeAxis } from '../core/timeAxis';

const MONTHS = ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];

/** Bottom bar bound to a TimeAxis: play/pause, step, slider, month ticks, "now" marker, keyboard. */
export function mountScrubber(root: HTMLElement, time: TimeAxis): void {
  const thisYear = new Date(time.now).getUTCFullYear();
  const years = Array.from({ length: 5 }, (_, i) => thisYear - i);

  root.innerHTML = `
    <div class="bar-row">
      <div class="btns">
        <button id="t-prev" class="icon-btn" aria-label="Back one day (Left arrow)">&#9664;</button>
        <button id="t-play" class="icon-btn play" aria-label="Play (Space)"></button>
        <button id="t-next" class="icon-btn" aria-label="Forward one day (Right arrow)">&#9654;</button>
      </div>
      <div class="date"><span id="t-date"></span><small id="t-doy"></small></div>
      <label class="year"><span class="sr">Year</span>
        <select id="t-year">${years.map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
      </label>
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
  const yearSel = $<HTMLSelectElement>('t-year');

  const drawTicks = () => {
    const span = time.end - time.start;
    const parts = MONTHS.map((m, i) => {
      const f = (Date.UTC(time.year, 2 + i, 1) - time.start) / span;
      return `<span class="tick" style="left:${(f * 100).toFixed(2)}%"><i></i>${m}</span>`;
    });
    const nf = time.nowFraction;
    if (nf !== null) {
      parts.push(`<span class="now" style="left:${(nf * 100).toFixed(2)}%" title="Today"><b>now</b></span>`);
    }
    ticks.innerHTML = parts.join('');
  };

  const sync = () => {
    range.max = String(time.days);
    range.value = String(time.dayIndex);
    range.style.setProperty('--pct', `${(time.dayIndex / time.days) * 100}%`);
    dateEl.textContent = formatDay(time.cursor);
    const ahead = time.cursor > time.now;
    doyEl.textContent = ahead ? 'after today' : '';
    yearSel.value = String(time.year);
    play.setAttribute('aria-label', time.playing ? 'Pause (Space)' : 'Play (Space)');
    play.classList.toggle('on', time.playing);
    play.innerHTML = time.playing ? '&#10073;&#10073;' : '&#9654;';
  };

  range.addEventListener('input', () => time.setDayIndex(Number(range.value)));
  range.addEventListener('pointerdown', () => time.pause());
  play.addEventListener('click', () => time.toggle());
  $('t-prev').addEventListener('click', () => (time.pause(), time.step(-1)));
  $('t-next').addEventListener('click', () => (time.pause(), time.step(1)));
  yearSel.addEventListener('change', () => {
    time.setYear(Number(yearSel.value));
    drawTicks();
    sync();
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
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
        time.setDayIndex(0);
        break;
      case 'End':
        time.pause();
        time.setDayIndex(time.days);
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
  drawTicks();
  sync();
}
