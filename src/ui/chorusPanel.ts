import { Chorus, type Note } from '../chorus/synth';
import { castFor, type Cast } from '../chorus/cast';
import { hourWeight, tempo, toF } from '../chorus/songs';
import { tempAt, weather, type Day } from './weather';

/**
 * "Listen here": pin a place and the singing insects the Atlas expects there on the map's date are played from their
 * song traits, at the tempo the real air temperature sets (src/chorus/). An hour slider walks the day: crickets and
 * katydids take the night, cicadas the hot afternoon.
 *
 * Analogy: the map shows who is out; this opens the window. Sounds are synthesised, never recorded.
 */

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const clock = (h: number) => `${((Math.floor(h) + 11) % 12) + 1} ${Math.floor(h) % 24 < 12 ? 'am' : 'pm'}`;
const WINDOW = 14; // seconds the roll shows
const LANES = matchMedia('(max-width: 600px)').matches ? 4 : 6;

export const chorusEnabled = () => !new URLSearchParams(location.search).has('nochorus');

export interface ChorusPanel {
  sync(hit: { lngLat: [number, number]; label?: string } | null, ms: number, card: HTMLElement): void;
}

export function mountChorus(probeEl: HTMLElement): ChorusPanel {
  const root = document.createElement('aside');
  root.id = 'chorus';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Singing insects at this place');
  root.innerHTML = `<div class="ch-head"><span id="ch-title"></span><button type="button" class="ch-x" aria-label="Close">&times;</button></div>
    <canvas id="ch-roll" role="img" aria-label="The singers, as a scrolling roll of their songs"></canvas>
    <div class="ch-bar"><button type="button" id="ch-play" aria-pressed="true" aria-label="Pause the sound">❚❚</button>
    <input id="ch-hour" type="range" min="0" max="23.75" step="0.25" value="21" aria-label="Hour of the day">
    <output id="ch-read" aria-live="off"></output></div>
    <div class="ch-note" id="ch-note"></div>`;
  document.body.append(root);
  const canvas = root.querySelector<HTMLCanvasElement>('#ch-roll')!;
  const g = canvas.getContext('2d')!;
  const hourEl = root.querySelector<HTMLInputElement>('#ch-hour')!;
  const playBtn = root.querySelector<HTMLButtonElement>('#ch-play')!;
  const readEl = root.querySelector<HTMLOutputElement>('#ch-read')!;
  const noteEl = root.querySelector<HTMLElement>('#ch-note')!;
  const titleEl = root.querySelector<HTMLElement>('#ch-title')!;

  let ctx: AudioContext | null = null;
  let chorus: Chorus | null = null;
  let timer = 0;
  let raf = 0;
  let cast: Cast | null = null;
  let day: Day | null = null;
  let spot: { lngLat: [number, number]; label?: string } | null = null;
  let at = 0;
  let lastKey = '';
  let playing = true;
  let opener: HTMLElement | null = null;

  const words = () => {
    const t = tempAt(day, +hourEl.value);
    if (t === null) return 'No weather for this day';
    return `${clock(+hourEl.value)} · ${t.toFixed(0)} °C · ${Math.round(toF(t))} °F`;
  };

  /** Push the hour's weather to the engine and say why it may be quiet. */
  const apply = () => {
    const h = +hourEl.value;
    const t = tempAt(day, h);
    readEl.textContent = words();
    if (t !== null && chorus) chorus.weather = { c: t, hour: h };
    if (!cast) return;
    if (!cast.inside) noteEl.textContent = 'Outside the Atlas map.';
    else if (!cast.singers.length) noteEl.textContent = 'No singers in season here yet.';
    else if (t !== null && !cast.singers.some((s) => tempo(s.song, t) > 0 && hourWeight(s.song, h) > 0))
      noteEl.textContent = t < 12 ? 'Too cool for any of them to sing.' : 'Nobody sings at this hour. Try dusk or night.';
    else noteEl.textContent = 'Synthesised from song traits. Tempo follows the air temperature.';
  };

  const draw = () => {
    raf = requestAnimationFrame(draw);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w * devicePixelRatio) {
      canvas.width = w * devicePixelRatio;
      canvas.height = h * devicePixelRatio;
    }
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(root);
    const ink = css.getPropertyValue('--text').trim() || '#222';
    const faint = css.getPropertyValue('--muted').trim() || '#888';
    const lanes = (cast?.singers ?? []).slice(0, LANES);
    const row = h / Math.max(lanes.length, 1);
    const label = 112;
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    const now = ctx?.currentTime ?? 0;
    const notes: Note[] = chorus?.notes ?? [];
    lanes.forEach((s, i) => {
      const y = row * (i + 0.5);
      g.fillStyle = faint;
      let nm = cast!.name(s.sp) ?? '';
      while (nm.length > 3 && g.measureText(nm).width > label - 8) nm = nm.slice(0, -2).trimEnd() + '…';
      g.fillText(nm, 0, y);
      g.strokeStyle = faint;
      g.globalAlpha = 0.25;
      g.beginPath();
      g.moveTo(label, y);
      g.lineTo(w, y);
      g.stroke();
      g.globalAlpha = 1;
      g.strokeStyle = ink;
      g.lineWidth = 2;
      g.lineCap = 'round';
      for (const n of notes) {
        if (n.sp !== s.sp) continue;
        const x0 = label + ((n.at - now + WINDOW * 0.85) / WINDOW) * (w - label);
        const x1 = label + ((n.at + n.dur - now + WINDOW * 0.85) / WINDOW) * (w - label);
        if (x1 < label || x0 > w) continue;
        g.beginPath();
        g.moveTo(Math.max(label, x0), y);
        g.lineTo(Math.max(label + 1, x1), y);
        g.stroke();
      }
    });
    // "Now" mark.
    const nx = label + 0.85 * (w - label);
    g.strokeStyle = css.getPropertyValue('--accent').trim() || '#c60';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(nx, 0);
    g.lineTo(nx, h);
    g.stroke();
  };

  const start = async () => {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
      chorus = new Chorus(ctx);
      timer = window.setInterval(() => chorus?.run(ctx!.currentTime + 1.2), 250);
    }
    await ctx.resume().catch(() => {});
    if (cast) chorus!.setCast(cast.singers, ctx.currentTime);
    apply();
  };

  const setPlay = (on: boolean) => {
    playing = on;
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.setAttribute('aria-label', on ? 'Pause the sound' : 'Play the sound');
    playBtn.textContent = on ? '❚❚' : '▶';
    if (on) void start();
    else void ctx?.suspend();
  };

  const load = async () => {
    if (!spot) return;
    const [lng, lat] = spot.lngLat;
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${fmtDate(at)}`;
    if (key === lastKey) return;
    lastKey = key;
    titleEl.textContent = `${spot.label ? `Near ${spot.label}` : 'Here'} · ${fmtDate(at)}`;
    noteEl.textContent = 'Finding the singers…';
    const [c, d] = await Promise.all([castFor(lat, lng, at), weather(lat, lng, at)]);
    if (key !== lastKey) return;
    cast = c;
    day = d;
    canvas.setAttribute('aria-label', c?.singers.length ? `Singers in season: ${c.singers.map((x) => c.name(x.sp)).join(', ')}` : 'No singers in season');
    if (chorus && ctx) chorus.setCast(cast?.singers ?? [], ctx.currentTime);
    apply();
  };

  const close = () => {
    root.hidden = true;
    void ctx?.suspend();
    opener?.isConnected ? opener.focus() : null;
    lastKey = '';
    cancelAnimationFrame(raf);
  };
  root.querySelector('.ch-x')!.addEventListener('click', close);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  playBtn.addEventListener('click', () => setPlay(!playing));
  hourEl.addEventListener('input', apply);

  probeEl.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('.ch-open')) return;
    opener = probeEl.querySelector('.ch-open');
    root.hidden = false;
    cancelAnimationFrame(raf);
    draw();
    setPlay(true);
    void load();
    root.querySelector<HTMLElement>('.ch-x')!.focus();
  });
  addEventListener('pagehide', () => clearInterval(timer));

  return {
    sync(hit, ms, card) {
      if (hit && !card.hidden && !card.querySelector('.ch-open')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ch-open';
        b.textContent = 'Listen here';
        card.append(b);
      }
      if (hit) {
        spot = hit;
        at = ms;
      } else if (!root.hidden) at = ms;
      if (!root.hidden) void load();
    },
  };
}
