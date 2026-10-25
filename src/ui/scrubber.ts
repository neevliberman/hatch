import { TimeAxis } from '../core/timeAxis';
import { NEXT, PAUSE, PLAY, PREV, REPLAY } from './icons';
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
  // Each band runs from its top edge right down to the bottom, painted top band first, so each lower one covers the
  // rest: no hairline seams of paper where two bands meet.
  const base = Array<number>(n).fill(0);
  const areas = p.bands
    .map((b) => {
      b.share.forEach((v, i) => (base[i]! += v));
      return `<path class="band" fill="${b.color}" d="M${edge(base).join('L')}L1000 28L0 28Z"/>`;
    })
    .reverse();
  const top = Math.max(...p.seen) || 1;
  const curve = (seen: number[]) => seen.map((v, i) => `${xs[i]} ${(14 - (v / top) * 12.5).toFixed(2)}`).join('L');
  const line = curve(p.seen);
  const only = (p.seenOnly ?? []).map((o) => `<path class="seen-only" fill="${o.color}" d="M0 14L${curve(o.seen)}L1000 14Z"/>`);
  return `<svg viewBox="0 0 1000 28" preserveAspectRatio="none">${areas.join('')}<path class="seen" d="M0 14L${line}L1000 14Z"/>${only.join('')}` +
    `<path class="seen-line" d="M${line}" vector-effect="non-scaling-stroke"/>` +
    `<rect class="frame" width="1000" height="28" vector-effect="non-scaling-stroke"/></svg>` +
    p.notes
      .map((k) => `<span class="wave" data-full="${k.text}" data-short="${k.text.split(' ')[0]}" style="left:${((k.at / (n - 1)) * 100).toFixed(2)}%">${k.text}</span>`)
      .join('');
}

/** Bottom bar bound to a TimeAxis: play/pause, step, slider over the season ribbon, month ticks, "now" marker, keyboard.
 * When playback reaches the last day, Play turns into Replay and `showEnd` gets the layer's end note (`endNote`) for
 * 5 s, then null; where it shows is up to the caller (main.ts puts it on empty paper). Returns a function that redraws
 * the ribbon (call it when the season or species changes). */
export function mountScrubber(
  root: HTMLElement,
  time: TimeAxis,
  endNote: () => [string, string] | undefined = () => undefined,
  showEnd: (words: [string, string] | null) => void = () => {},
): (p: SeasonProfile | undefined) => void {
  root.innerHTML = `
    <div class="btns">
      <button id="t-prev" class="icon-btn" aria-label="Back one day (Left arrow)">${PREV}</button>
      <button id="t-play" class="icon-btn play" aria-label="Play (Space)"></button>
      <button id="t-next" class="icon-btn" aria-label="Forward one day (Right arrow)">${NEXT}</button>
    </div>
    <div class="date"><span id="t-date"></span><small id="t-doy"></small><span id="t-asof" class="asof" hidden></span></div>
    <div class="track">
      <div class="ribbon" id="t-ribbon" aria-hidden="true"></div>
      <div class="fc-wash" id="t-fc" aria-hidden="true" hidden></div>
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
  // Playback that reaches the season's last day "ends": Replay, and the end note for a few seconds (see sync).
  let ended = false;
  let wasPlaying = false;
  let noteOn = false;
  let noteTimer = 0;
  const endNoteOff = () => {
    clearTimeout(noteTimer);
    if (noteOn) (noteOn = false), showEnd(null);
  };
  // While playing, the slider takes the in-between value too, so the thumb (and the phone's date pill) glides
  // instead of hopping a day at a time (not under reduced motion: frac stays 0 and the thumb hops). A screen reader
  // still hears whole days.
  const glide = () => {
    range.step = time.gliding ? 'any' : '1';
    range.value = String(time.stepIndex + time.frac);
    range.setAttribute('aria-valuenow', String(time.stepIndex));
    // Where the thumb is, 0-1: the phone's date pill rides above it.
    root.style.setProperty('--p', String((time.stepIndex + time.frac) / Math.max(1, time.steps)));
  };
  const asOfEl = $('t-asof');
  const fcEl = $('t-fc');
  const md = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // Wave notes sit just right of their peak. When the thumb would cover one, or it would run off the ribbon's end,
  // slide it to the nearest free spot on the ribbon: pulled in from the end, left of the peak, or just past the thumb
  // on either side. On a narrow track (a phone, or a desktop band squeezed by the About panel) a note that still runs
  // into another or off the ribbon shortens to its first word ("2nd"), then all do, and one that still collides is
  // left out.
  const placeWaves = () => {
    const waves = [...ribbonEl.querySelectorAll<HTMLElement>('.wave')];
    if (!waves.length) return;
    const w = ribbonEl.clientWidth;
    const half = range.offsetWidth - w; // the ribbon is inset half a thumb each side, so this is one thumb
    const x = (time.stepIndex / Math.max(1, time.steps)) * w;
    const clear = half / 2 + 4;
    const lay = (short: (i: number) => boolean) =>
      waves.map((el, i) => {
        el.hidden = false;
        el.textContent = (short(i) ? el.dataset.short : el.dataset.full) ?? el.textContent;
        el.style.transform = '';
        const lw = el.offsetWidth;
        const anchor = el.offsetLeft; // label's left edge (peak + its margin)
        const peak = anchor - 4;
        const hits = (l: number) => x + clear > l && x - clear < l + lw;
        const spot = [anchor, w - lw, peak - 4 - lw, x + clear, x - clear - lw]
          .filter((l) => l >= 0 && l + lw <= w && !hits(l))
          .sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor))[0] ?? anchor;
        if (spot !== anchor) el.style.transform = `translateX(${(spot - anchor).toFixed(1)}px)`;
        return [spot, spot + lw] as const;
      });
    const off = (r: readonly (readonly [number, number])[]) =>
      r.map(([l, rt], i) => l < 0 || rt > w || r.some(([l2, r2], j) => j !== i && l < r2 + 4 && l2 < rt + 4));
    let spots = lay(() => false);
    const bad = off(spots);
    if (bad.some(Boolean)) spots = lay((i) => bad[i]!);
    if (off(spots).some(Boolean)) {
      spots = lay(() => true);
      // Still in the way: drop the later notes (keep the first wave's) until the rest fit.
      const kept: (readonly [number, number])[] = [];
      spots.forEach((s, i) => {
        if (off([...kept, s]).some(Boolean)) waves[i]!.hidden = true;
        else kept.push(s);
      });
    }
  };

  let rangeKey = '';
  const drawTicks = () => {
    const span = time.end - time.start;
    const parts = makeTicks(time.start, time.end).map(
      (k) => `<span class="tick" style="left:${(((k.at - time.start) / span) * 100).toFixed(2)}%"><i></i>${k.label}</span>`,
    );
    // Live data: an "as of" flag on the last day of observed weather, and the ribbon washed paler after it (forecast).
    // Data from before the track starts makes all of it forecast; data past its end, none.
    const a = time.asOf;
    const af = a && a.at >= time.start && a.at <= time.end ? (a.at - time.start) / span : null;
    fcEl.hidden = !a || a.at >= time.end;
    root.style.setProperty('--fc', String(af ?? 0));
    asOfEl.hidden = !a;
    // Fresh data says how fresh ("as of yesterday", not the date the pill already shows), counted in the reader's own
    // calendar days; data more than 3 days old (a past season's file) says its age. Amber only when the nightly run is
    // late (isStale): a frozen off-season file or a rerun is old on purpose.
    const n = new Date(time.now);
    const days = a ? Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - a.at) / 86_400_000) : 0;
    asOfEl.classList.toggle('stale', !!a?.stale);
    if (a) {
      asOfEl.innerHTML =
        days > 3
          ? `data ${days} days old`
          : `as of ${days <= 0 ? 'today' : days === 1 ? 'yesterday' : md(a.at)}${a.stale ? '<span class="long"> · data may be stale</span><span class="phone-only"> · stale?</span>' : ''}`;
      asOfEl.title =
        (days > 3
          ? `Real weather ends ${md(a.at)}, ${days} days ago.`
          : `Weather observed up to ${md(a.at)}.${a.stale ? " Tonight's update looks late, so this may be out of date." : ''}`) + ' Later days are forecast.';
    }
    if (af !== null) {
      parts.push(`<span class="now asof-flag" style="left:${(af * 100).toFixed(2)}%" title="Last day of observed weather: ${md(a!.at)}"><b>as of</b></span>`);
    }
    // The clock's own "now" flag still shows, unless it would sit on top of the as-of flag (the usual night: as of yesterday).
    const nf = a && Math.abs(time.now - a.at) <= 2 * 86_400_000 ? null : time.nowFraction;
    if (nf !== null) {
      parts.push(`<span class="now" style="left:${(nf * 100).toFixed(2)}%" title="Today"><b>now</b></span>`);
    }
    ticks.innerHTML = parts.join('');
  };

  const sync = () => {
    range.max = String(time.steps);
    glide();
    const label = time.label(time.cursor);
    const after = time.asOf ? (time.cursor > time.asOf.at ? 'forecast' : '') : time.cursor > time.now ? 'after today' : '';
    doyEl.classList.toggle('fc', !!time.asOf);
    // Screen readers hear when a day is forecast, as sighted users see from the washed ribbon.
    range.setAttribute('aria-valuetext', label + (time.asOf && time.cursor > time.asOf.at ? ' (forecast)' : ''));
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
    const key = `${time.start}|${time.end}|${time.asOf?.at}|${time.asOf?.stale}`;
    if (rangeKey !== key) {
      rangeKey = key;
      drawTicks();
      root.style.setProperty('--half', `${Math.ceil(dateBox.offsetWidth / 2) + 4}px`); // the as-of badge may have changed
    }
    // Playback stops on the last day: Play turns into Replay and a short note says what just happened.
    const end = !time.playing && time.stepIndex === time.steps;
    if (wasPlaying && end) {
      ended = true;
      const words = endNote(); // the layer's own copy
      if (words) {
        clearTimeout(noteTimer);
        noteOn = true;
        showEnd(words);
        noteTimer = window.setTimeout(endNoteOff, 5000);
      }
    } else if (!end) ended = false;
    if (!ended) endNoteOff();
    wasPlaying = time.playing;
    play.setAttribute('aria-label', time.playing ? 'Pause (Space)' : ended ? 'Replay (Space)' : 'Play (Space)');
    play.classList.toggle('on', time.playing || ended);
    play.innerHTML = time.playing ? PAUSE : ended ? REPLAY : PLAY;
    placeWaves();
  };

  // The first Play of a visit starts from the beginning of the season, so it shows the wave rolling north
  // rather than the end of it. Once the reader has moved the time themselves, Play starts where they left it.
  let touched = false;
  let glideRaf = 0;
  let glideTimer = 0;
  let rewinding = false; // the first Play's rewind (its own raf and timer, apart from the playback clock's frames)
  const touch = () => ((touched = true), (rewinding = false), cancelAnimationFrame(glideRaf), clearTimeout(glideTimer));
  const playFromStart = () => {
    touched = true;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || time.stepIndex === 0) return (time.setStepIndex(0), time.play());
    const from = time.stepIndex;
    const { start, end } = time;
    rewinding = true;
    const t0 = performance.now();
    const frame = (t: number) => {
      if (time.start !== start || time.end !== end) return touch(); // the season changed under the rewind
      const k = Math.min(1, (t - t0) / 400);
      time.setStepIndex(Math.round(from * (1 - (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)))); // ease in-out
      if (k < 1) glideRaf = requestAnimationFrame(frame);
      else glideTimer = window.setTimeout(() => ((rewinding = false), time.play()), 250);
    };
    glideRaf = requestAnimationFrame(frame);
  };

  range.addEventListener('input', () => (touch(), time.setStepIndex(Number(range.value))));
  range.addEventListener('pointerdown', () => (touch(), time.pause()));
  // A press during the rewind stops it, like Pause would. Replay (after the last day) is a plain press too: touch()
  // stops any rewind, and play() starts the season over.
  const togglePlay = () => (rewinding ? touch() : !touched && !time.playing ? playFromStart() : (touch(), time.toggle()));
  play.addEventListener('click', togglePlay);
  $('t-prev').addEventListener('click', () => (touch(), time.pause(), time.step(-1)));
  $('t-next').addEventListener('click', () => (touch(), time.pause(), time.step(1)));

  // Scroll wheel or two-finger swipe over the slider steps the day: down or right is later. Whichever axis moves more
  // wins (a mouse wheel is vertical, a trackpad swipe is usually horizontal). Small trackpad deltas add up until they
  // make a whole step, so slow swipes still move. Pinch-zoom (ctrl) and the rest of the page keep their wheel.
  const WHEEL_PX = 30; // pixels of scroll per day
  let wheelAcc = 0;
  root.querySelector<HTMLElement>('.track')!.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) return;
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines and pages to pixels
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * lines;
      if (!d) return;
      e.preventDefault();
      if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0; // turned around: drop the leftover
      wheelAcc += d;
      const n = Math.trunc(wheelAcc / WHEEL_PX);
      if (!n) return;
      wheelAcc -= n * WHEEL_PX;
      touch();
      time.pause();
      time.step(n);
    },
    { passive: false },
  );

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
  time.onFrame(glide);
  sync();
  // The track narrows without a window resize too (the desktop About panel), so watch the ribbon itself.
  new ResizeObserver(placeWaves).observe(ribbonEl);
  return (p) => {
    ribbonEl.innerHTML = p ? ribbon(p) : '';
    placeWaves();
  };
}
