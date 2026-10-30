// The radar replay: one evening of a weather radar's scans, drawn at their true place on the map, on a loop.
// Loaded only when someone opens a radar event (main.ts), with its frames (public/radar/<id>/, from
// pipeline/radar/build_radar.py). Nothing here ships in the page.
import { BitmapLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { MapHandle, Padding } from '../map/map';
import { isDark, palette } from '../theme';
import { CROSS, PAUSE, PLAY } from '../ui/icons';
import { MOON } from './moon';
import { EVENTS, type RadarEvent } from './events';
import { createNight, glowRamp, loadWind, NIGHT_SKY, type Night } from './night';
import './radar.css';

interface Meta {
  site: string;
  lat: number;
  lon: number;
  times: string[];
  start: number;
  polar: { rays: number; gates: number; gate_m: number; first_m: number; step_deg: number };
  levels: { dbz_min: number; dbz_step: number; count: number };
  kept: { range_km: [number, number] };
}

export interface RadarHost {
  map: MapHandle;
  padding(): Padding;
  /** Where the card goes (the floating row over the time bar). */
  mount: HTMLElement;
  /** Called once the replay has closed (its × or Escape, or close()). */
  onClose(): void;
  /** Where × goes back to, when this replay takes over from another (that one's own `before`): null is the whole
   * Midwest. Left out, it is wherever the map is now. */
  before?: View | null;
  /** True once the reader has asked for something else while this one loaded: it then opens nothing and returns null. */
  stale?(): boolean;
  /** Open in the night view (a ?night link). */
  night?: boolean;
  /** Called when the night view goes on or off (the link follows it). */
  onNight?(): void;
}

/** A place on the map to go back to (MapHandle.center's answer). */
export type View = NonNullable<ReturnType<MapHandle['center']>>;

export interface Radar {
  id: string;
  /** Where × goes back to: a place the reader had panned to, or null for the whole Midwest. */
  before: View | null;
  /** Close it; `back` (the default) returns the map to `before`. */
  close(back?: boolean): void;
  /** Whether the night view is on. */
  night(): boolean;
}

type RGBA = [number, number, number, number];
// The radar's bins are placed on a sphere of this radius (azimuthal equidistant about the radar, as Py-ART does).
const R = 6370997;
const RAD = Math.PI / 180;

// Echo strength ramp, light to dark, in the map's own colours (theme.ts): the pale "not yet" sage, the leaf greens,
// the ochre of "winding down", the page's terracotta warning colour (style.css --warn), then ink. The pale end is
// see-through like the map's washes.
const anchors = (): RGBA[] => [palette.stages['not yet'], palette.stages.starting, palette.stages.peak, palette.stages['winding down'], isDark() ? [214, 96, 52, 240] : [166, 63, 25, 235], palette.stripes];
function ramp(n: number): RGBA[] {
  const A = anchors();
  return Array.from({ length: n }, (_, i) => {
    const p = (i / (n - 1)) * (A.length - 1);
    const k = Math.min(Math.floor(p), A.length - 2);
    const f = p - k;
    return A[k]!.map((v, j) => Math.round(v * (1 - f) + A[k + 1]![j]! * f)) as RGBA;
  });
}

/** lng/lat of the point `d` metres from (lat0, lon0) along bearing `az` (radians from north), on Py-ART's sphere. */
function fromRadar(lat0: number, lon0: number, az: number, d: number): [number, number] {
  const c = d / R;
  const p0 = lat0 * RAD;
  const lat = Math.asin(Math.sin(p0) * Math.cos(c) + Math.cos(p0) * Math.sin(c) * Math.cos(az));
  const lon = lon0 * RAD + Math.atan2(Math.sin(az) * Math.sin(c) * Math.cos(p0), Math.cos(c) - Math.sin(p0) * Math.sin(lat));
  return [lon / RAD, lat / RAD];
}
const circle = (m: Meta, d: number) => Array.from({ length: 145 }, (_, i) => fromRadar(m.lat, m.lon, (i / 144) * 2 * Math.PI, d));
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
const unMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;

/**
 * Where each texture pixel samples the radar. The frames are the radar's own polar bins (one per 0.5 degree ray and
 * 250 m gate), so every pixel is turned into a distance and a bearing from the radar (azimuthal equidistant, as the radar
 * measures) and takes the bin it falls in: the echo is drawn as the radar saw it, with no gridding or smoothing of ours.
 * The image sits on a lng/lat box (a true rectangle on the Web Mercator map).
 */
function sampler(m: Meta) {
  const { rays, gates, gate_m: gm, first_m: first, step_deg: step } = m.polar;
  const reach = m.kept.range_km[1] * 1000 + gm; // the outermost kept bin's edge, and a little
  const ring = circle(m, reach);
  const west = Math.min(...ring.map((p) => p[0]));
  const east = Math.max(...ring.map((p) => p[0]));
  const south = Math.min(...ring.map((p) => p[1]));
  const north = Math.max(...ring.map((p) => p[1]));
  // About 1.5 texture pixels to a gate (the radar's finest detail), but no more than 1100 wide: it is rebuilt mid-fade.
  const w = Math.min(1100, Math.round((2 * reach) / (gm / 1.5)));
  const yN = mercY(north);
  const yS = mercY(south);
  const h = Math.round((w * (yN - yS)) / ((east - west) * RAD));
  const at = new Int32Array(w * h).fill(-1);
  const p0 = m.lat * RAD;
  for (let j = 0; j < h; j++) {
    const lat = unMercY(yN - ((j + 0.5) / h) * (yN - yS)) * RAD; // row 0 is the north edge
    for (let i = 0; i < w; i++) {
      const dl = (west + ((i + 0.5) / w) * (east - west) - m.lon) * RAD;
      // Forward azimuthal equidistant (Snyder 25-2..25-5): metres east (x) and north (y) of the radar.
      const cc = Math.sin(p0) * Math.sin(lat) + Math.cos(p0) * Math.cos(lat) * Math.cos(dl);
      const c = Math.acos(Math.min(1, Math.max(-1, cc)));
      const k = c < 1e-12 ? 1 : c / Math.sin(c);
      const x = R * k * Math.cos(lat) * Math.sin(dl);
      const y = R * k * (Math.cos(p0) * Math.sin(lat) - Math.sin(p0) * Math.cos(lat) * Math.cos(dl));
      const g = Math.round((Math.hypot(x, y) - first) / gm);
      if (g < 0 || g >= gates) continue;
      const bearing = (Math.atan2(x, y) / RAD + 360) % 360; // clockwise from north
      at[j * w + i] = (Math.round(bearing / step) % rays) * gates + g;
    }
  }
  return { w, h, at, bounds: [west, south, east, north] as [number, number, number, number] };
}

/** The frames' levels, one byte a cell, from the 4-bit pack (high nibble first). */
function unpack(bytes: Uint8Array, bins: number, count: number): Uint8Array[] {
  const per = bins / 2;
  if (bytes.length !== per * count) throw new Error(`radar pack: ${bytes.length} bytes, expected ${per * count}`);
  return Array.from({ length: count }, (_, f) => {
    const out = new Uint8Array(bins);
    for (let i = 0; i < per; i++) {
      const b = bytes[f * per + i]!;
      out[2 * i] = b >> 4;
      out[2 * i + 1] = b & 15;
    }
    return out;
  });
}

async function gunzip(res: Response): Promise<Uint8Array> {
  const buf = new Uint8Array(await res.arrayBuffer());
  // Some servers send a .gz with Content-Encoding: gzip, and the browser has already unpacked it.
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  const out = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** "9:24 pm" and "Sun 20 July 2014" in the event's local time. */
function local(iso: string, tz: RadarEvent['tz']): [string, string] {
  const d = new Date(Date.parse(iso) + tz.offset * 3600_000);
  const h = d.getUTCHours();
  const time = `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(',', '');
  return [time, day];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function openRadar(id: string, host: RadarHost): Promise<Radar | null> {
  const ev = EVENTS[id];
  if (!ev) return null;
  const base = `${import.meta.env.BASE_URL}radar/${id}/`;
  let meta: Meta;
  let frames: Uint8Array[];
  try {
    const [m, f] = await Promise.all([fetch(`${base}meta.json`), fetch(`${base}frames.bin.gz`)]);
    if (!m.ok || !f.ok) return null;
    meta = (await m.json()) as Meta;
    frames = unpack(await gunzip(f), meta.polar.rays * meta.polar.gates, meta.times.length);
  } catch {
    return null;
  }
  if (host.stale?.()) return null;
  const { map } = host;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let pal = ramp(meta.levels.count);
  // Premultiplied colour per level (0 = nothing), so blending neighbours never drags in a dark fringe.
  const PR = new Float32Array(16);
  const PG = new Float32Array(16);
  const PB = new Float32Array(16);
  const PA = new Float32Array(16);
  let r0 = 0;
  let g0 = 0;
  let b0 = 0;
  const colour = (p: RGBA[]) => {
    pal = p;
    p.forEach(([r, g, b, a], i) => ((PR[i + 1] = (r * a) / 255), (PG[i + 1] = (g * a) / 255), (PB[i + 1] = (b * a) / 255), (PA[i + 1] = a)));
    [r0, g0, b0] = p[0]!;
  };
  colour(pal);
  const S = sampler(meta);

  /** Frame `a` blended `f` of the way to frame `b`, one radar bin per pixel-patch, as a texture-ready image. */
  const paint = (a: number, b: number, f: number): ImageData => {
    const img = new ImageData(S.w, S.h);
    const px = img.data;
    const A = frames[a]!;
    const B = frames[b]!;
    for (let q = 0; q < S.at.length; q++) {
      const o = q * 4;
      px[o] = r0;
      px[o + 1] = g0;
      px[o + 2] = b0;
      const i = S.at[q]!;
      if (i < 0) continue;
      const la = A[i]!;
      const lb = B[i]!;
      if (!(la | lb)) continue;
      const al = (1 - f) * PA[la]! + f * PA[lb]!;
      if (al < 1) continue;
      px[o] = ((1 - f) * PR[la]! + f * PR[lb]!) * 255 / al;
      px[o + 1] = ((1 - f) * PG[la]! + f * PG[lb]!) * 255 / al;
      px[o + 2] = ((1 - f) * PB[la]! + f * PB[lb]!) * 255 / al;
      px[o + 3] = al;
    }
    return img;
  };

  // A sheet of paper under the radar's reach, so the forecast hexagons don't read as part of it; the rivers and state
  // lines still draw on top. Range rings at half the reach and at the reach (40 and 80 km, or 60 and 120), and the
  // radar itself as an ink dot.
  const reach = meta.kept.range_km[1] * 1000;
  const disc = [{ ring: circle(meta, reach + meta.polar.gate_m) }];
  const sheetOf = (dark: boolean) => new SolidPolygonLayer<{ ring: [number, number][] }>({
    id: 'radar-sheet',
    data: disc,
    getPolygon: (d) => d.ring,
    getFillColor: dark ? NIGHT_SKY : ([...palette.land.slice(0, 3), 235] as RGBA),
  });
  let sheet = sheetOf(false);
  const rings = new PathLayer<{ path: [number, number][] }>({
    id: 'radar-rings',
    data: [{ path: circle(meta, reach / 2) }, { path: circle(meta, reach) }],
    getPath: (d) => d.path,
    getColor: palette.neighbourLine,
    getWidth: 1,
    widthUnits: 'pixels',
  });
  const site = new ScatterplotLayer<[number, number]>({
    id: 'radar-site',
    data: [[meta.lon, meta.lat]],
    getPosition: (d) => d,
    getRadius: 3.5,
    radiusUnits: 'pixels',
    getFillColor: palette.stripes,
  });
  let drawn = '';
  let image: Layer | null = null;
  let dots: Layer | null = null;
  // The paper goes under the lakes, so they keep their shape; the echo, rings and dot go over them (a swarm off a lake
  // is over the water), still under the rivers and state lines. At night the simulated insects go on top of the echo.
  const compose = () => map.setOverlay([sheet] as Layer[], [image, rings, site, ...(nightOn && dots ? [dots] : [])] as Layer[]);
  const draw = (a: number, b: number, f: number) => {
    const key = `${a}:${b}:${f.toFixed(2)}`;
    if (key === drawn) return;
    drawn = key;
    image = new BitmapLayer({ id: 'radar-frame', bounds: S.bounds, image: paint(a, b, f), pickable: false });
    compose();
  };
  let nightOn = false;
  let night: Night | null = null;

  // The card: play or pause, the time and a one-line caption, "How we know" behind an i, and a close button.
  const card = document.createElement('section');
  card.id = 'radar';
  card.setAttribute('aria-label', 'Radar replay');
  const step = meta.levels;
  const keyStops = pal.map((c) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`).join(',');
  card.innerHTML = `<div class="rd-head">
      <button type="button" class="icon-btn rd-play" aria-label="Pause the replay">${PAUSE}</button>
      <p class="rd-cap"><span class="rd-when"><b class="rd-time"></b> ${esc(ev.tz.name)}, <span class="rd-day"></span></span>
        <span class="rd-what">${esc(ev.caption)}</span></p>
      <button type="button" class="rd-night" aria-pressed="false" title="Night view: simulated insects">${MOON}<span>Night</span></button>
      <button type="button" class="rd-i" aria-expanded="false" aria-controls="radar-more" aria-label="How we know it’s insects" title="How we know">i</button>
      <button type="button" class="rd-x" aria-label="Close the radar replay" title="Close">${CROSS}</button>
    </div>
    <div class="rd-spark" aria-hidden="true" hidden><svg viewBox="0 0 100 14" preserveAspectRatio="none"><path/></svg></div>
    <div class="rd-prog" aria-hidden="true"><i></i></div>
    <p class="rd-sim" hidden>Dots are simulated from the echo and the wind.</p>
    <div id="radar-more" class="rd-more" hidden>
      ${ev.more.map((p) => `<p>${esc(p)}</p>`).join('')}
      <div class="rd-key" aria-hidden="true"><i style="background:linear-gradient(90deg,${keyStops})"></i>
        <span>weak echo, ${step.dbz_min} dBZ</span><span>strong, ${step.dbz_min + step.dbz_step * (step.count - 1)}+</span></div>
      <p>${esc(ev.numbers.lead)}</p>
      <ul>${ev.numbers.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p class="rd-credits">${ev.credits.map((c) => `<a href="${esc(c.href)}" target="_blank" rel="noopener noreferrer">${esc(c.text)}<span class="sr"> (opens in a new tab)</span></a>`).join('')}</p>
    </div>`;
  host.mount.prepend(card);
  const q = <T extends HTMLElement>(s: string) => card.querySelector(s) as T;
  const playBtn = q<HTMLButtonElement>('.rd-play');
  const more = q<HTMLElement>('.rd-more');
  const info = q<HTMLButtonElement>('.rd-i');
  const nightBtn = q<HTMLButtonElement>('.rd-night');
  const spark = q<HTMLElement>('.rd-spark');
  const sim = q<HTMLElement>('.rd-sim');

  // Glide to the radar: its whole reach (80 km, or 120 for an event that keeps more) in the free map between the header
  // and the card.
  const before: View | null = host.before !== undefined ? host.before : map.moved() ? map.center(host.padding()) : null;
  // On a wide screen the card sits in a corner, so the radar only keeps clear of its closed height; on a phone it spans
  // the width, so the radar sits above all of it.
  // A phone on its side has no height to spare: with "How we know" open the radar moves to the right of the card.
  const wide = () => card.offsetWidth < window.innerWidth * 0.6;
  const short = matchMedia('(orientation: landscape) and (max-height: 500px)');
  const beside = () => short.matches && !more.hidden;
  const room = (): Padding => {
    const p = host.padding();
    const r = card.getBoundingClientRect();
    if (beside()) return { ...p, left: r.right + 12, bottom: 8, rightFrom: undefined };
    const top = wide() && !more.hidden ? r.top + more.offsetHeight + 7 : r.top;
    return { ...p, bottom: Math.max(8, window.innerHeight - top + 8), rightFrom: undefined };
  };
  const frame = () => {
    const p = room();
    const w = window.innerWidth - (p.right ?? 0) - (p.left ?? 0) - 24;
    const h = window.innerHeight - p.top - p.bottom - 16;
    const metresPerPx = (2 * (reach + meta.polar.gate_m)) / Math.max(120, Math.min(w, h));
    // Web Mercator, 512 px tiles: metres per pixel = 40075016 cos(lat) / (512 2^zoom).
    const zoom = Math.log2((40075016 * Math.cos(meta.lat * RAD)) / (512 * metresPerPx));
    return { p, zoom };
  };
  const look = (fly: boolean) => {
    const { p, zoom } = frame();
    map.focus([meta.lon, meta.lat], zoom, p, fly);
  };
  // "How we know" makes the card taller: keep the radar clear of it, above it while the map there has room for it, or
  // beside it on a phone on its side.
  info.addEventListener('click', () => {
    more.hidden = !more.hidden;
    info.setAttribute('aria-expanded', String(!more.hidden));
    info.classList.toggle('on', !more.hidden);
    if (short.matches || (!wide() && window.innerHeight - room().top - room().bottom >= 200)) look(true);
  });

  // Playback: each scan holds, then fades into the next; the last one rests a little longer before the loop starts
  // over. Reduced motion: no fade, a slower step, and it opens paused on the scan with the most strong echo.
  const first = Math.min(meta.start, frames.length - 1);
  const last = frames.length - 1;
  const HOLD = 700;
  const FADE = 500;
  const REST = 1800;
  let idx = first;
  let playing = !still.matches;
  if (!playing) {
    // Strong: 25 dBZ or more, where the plume is thickest over the river.
    const strong = Math.ceil((25 - meta.levels.dbz_min) / meta.levels.dbz_step) + 1;
    let most = -1;
    for (let i = first; i <= last; i++) {
      const c = frames[i]!.reduce((s, v) => s + (v >= strong ? 1 : 0), 0);
      if (c > most) (most = c), (idx = i);
    }
  }
  let t0 = performance.now();
  let raf = 0;
  let shown = -1;
  const timeEl = q<HTMLElement>('.rd-time');
  const dayEl = q<HTMLElement>('.rd-day');
  const bar = q<HTMLElement>('.rd-prog i');
  const label = (i: number, f: number) => {
    const at = f >= 0.5 ? (i === last ? first : i + 1) : i;
    if (at !== shown) {
      shown = at;
      const [t, d] = local(meta.times[at]!, ev.tz);
      timeEl.textContent = t;
      dayEl.textContent = d;
    }
    bar.style.width = `${(((i - first + (i === last ? 0 : f)) / (last - first)) * 100).toFixed(1)}%`;
  };
  const tick = (now: number) => {
    raf = 0;
    if (!playing) return;
    const hold = idx === last ? REST : still.matches ? 1600 : HOLD;
    const fade = still.matches ? 0 : FADE;
    let e = now - t0;
    if (e >= hold + fade) {
      idx = idx === last ? first : idx + 1;
      t0 = now;
      e = 0;
    }
    const f = e > hold && fade ? Math.min(1, (e - hold) / fade) : 0;
    const eased = f * f * (3 - 2 * f);
    const next = idx === last ? first : idx + 1;
    // Mid-fade the image is rebuilt about 25 times a second, not every frame: a slow fade looks the same.
    draw(idx, next, f ? Math.round(eased * 12) / 12 : 0);
    label(idx, eased);
    if (nightOn && now - nightAt > 30) glow(simTime(idx, e / (hold + fade)), now);
    raf = requestAnimationFrame(tick);
  };
  // Night: the radar's own echo as glow on a dark sky, and simulated insects on it (night.ts). Built the first time it is
  // asked for, with the wind for that evening. Zoom may go in past town scale, where the glow resolves into dots.
  let nightAt = 0;
  const simTime = (i: number, frac: number) => {
    const t = Date.parse(meta.times[i]!) / 1000;
    return i === last ? t + frac * 300 : t + (Date.parse(meta.times[i + 1]!) / 1000 - t) * frac;
  };
  const glow = (t: number, now = 0) => {
    nightAt = now;
    dots = night!.at(t);
    compose();
  };
  const sparkDraw = () => {
    const v = night!.spark;
    const pts = v.slice(first).map((x, i) => `${((i / (last - first)) * 100).toFixed(1)},${(13.5 - x * 12.5).toFixed(1)}`);
    spark.querySelector('path')!.setAttribute('d', `M0,14L${pts.join('L')}L100,14Z`);
  };
  const setNight = async (on: boolean) => {
    if (on === nightOn) return;
    if (on && !night) {
      const wind = await loadWind(base);
      if (!open || nightOn) return;
      night = createNight(meta, frames, wind, meta.levels.count);
      sparkDraw();
    }
    nightOn = on;
    nightBtn.setAttribute('aria-pressed', String(on));
    nightBtn.classList.toggle('on', on);
    spark.hidden = sim.hidden = !on;
    colour(on ? glowRamp(meta.levels.count) : ramp(meta.levels.count));
    sheet = sheetOf(on);
    q<HTMLElement>('.rd-key i').style.background = `linear-gradient(90deg,${pal.map((c) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`).join(',')})`;
    map.deep(on);
    drawn = '';
    draw(idx, idx, 0);
    if (on) glow(simTime(idx, 0));
    else dots = null;
    compose();
    host.onNight?.();
  };
  nightBtn.addEventListener('click', () => void setNight(!nightOn));
  const setPlaying = (on: boolean) => {
    playing = on;
    playBtn.innerHTML = on ? PAUSE : PLAY;
    playBtn.setAttribute('aria-label', on ? 'Pause the replay' : 'Play the replay');
    cancelAnimationFrame(raf);
    raf = 0;
    if (on) {
      t0 = performance.now();
      raf = requestAnimationFrame(tick);
    } else {
      draw(idx, idx, 0); // settle on the scan in view, not half-way into the next
      label(idx, 0);
      if (nightOn) glow(simTime(idx, 0));
    }
  };
  playBtn.addEventListener('click', () => setPlaying(!playing));
  draw(idx, idx, 0);
  label(idx, 0);
  setPlaying(playing);
  if (host.night) void setNight(true);
  // After the card is laid out, so the glide knows how much room it takes.
  requestAnimationFrame(() => open && look(true));
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => look(false), 150);
  };
  window.addEventListener('resize', onResize);

  let open = true;
  const close = (back = true) => {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    clearTimeout(resizeTimer);
    if (nightOn) map.deep(false);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey, true);
    const hadFocus = card.contains(document.activeElement);
    card.remove();
    map.setOverlay([]);
    host.onClose();
    // Back to where the reader was: the whole Midwest, or the place they had panned to. After the time bar is back.
    if (back) requestAnimationFrame(() => {
      if (before) map.focus(before.lngLat, before.zoom, host.padding(), true);
      else map.fit(host.padding(), true);
    });
    if (hadFocus) document.getElementById('info-btn')?.focus({ preventScroll: true });
  };
  // Step one scan back or on (and pause), for the arrow keys.
  const stepBy = (d: number) => {
    setPlaying(false);
    idx = idx + d > last ? first : idx + d < first ? last : idx + d;
    draw(idx, idx, 0);
    label(idx, 0);
    if (nightOn) glow(simTime(idx, 0));
  };
  // While it is open the keys drive the replay, not the hidden season slider: arrows step a scan, Home and End go to
  // the first and last, Space plays or pauses, Escape closes. Not while something on top (the About panel, the town box) has them.
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || document.getElementById('drawer')?.classList.contains('open')) return;
    if (!document.getElementById('finder')?.hidden) return;
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') close();
    else if (t.closest?.('input, select, textarea, [contenteditable]')) return;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stepBy(e.key === 'ArrowLeft' ? -1 : 1);
    else if (e.key === 'Home' || e.key === 'End') stepBy((e.key === 'Home' ? first : last) - idx);
    else if (e.key === 'PageUp' || e.key === 'PageDown') void 0; // the hidden season slider's keys: kept from it
    else if (e.key === ' ' && !(t instanceof HTMLButtonElement)) setPlaying(!playing);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  q<HTMLButtonElement>('.rd-x').addEventListener('click', () => close());
  playBtn.focus({ preventScroll: true });
  return { id, before, close, night: () => nightOn };
}
