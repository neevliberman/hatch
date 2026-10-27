import './style.css';
import { LayerRegistry } from './core/registry';
import { TimeAxis, type TimeSpec } from './core/timeAxis';
import { makeIntro, type Intro } from './ui/intro';
import { createLunaLayer, modeLabel, replayTimeSpec, setLive, type LunaLayer } from './layers/lunaReplay';
import { findSpecies, SPECIES } from './species';
import { mountSpeciesPicker } from './ui/speciesPicker';
import { atlasKey } from './atlas/index';
import { data, LIVE, TYPICAL, type Mode } from './layers/lunaData';
import { inSeason, liveAvailable, loadLive, type Live } from './layers/liveData';
import { createMap, type Padding, type ProbeHit } from './map/map';
import { basemapLabels, theme } from './map/basemap';
import { mountScrubber } from './ui/scrubber';
import { mountCaveatDrawer } from './ui/caveatDrawer';
import { mountLayerList, mountLegend, showProbe } from './ui/panels';
import { mountFinder } from './ui/finder';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { AIM, WORD, stepCell, type Arrow } from './ui/keyexplore';
import { GRID_RES } from './core/grid';
import { isDark, onTheme, toggleMode } from './theme';
import { markFor } from './ui/mark';
import { isForecast, type HatchLayer, type SeasonProfile } from './core/layer';
import { MIDWEST_MARGIN } from './layers/stages';
import { RADAR_HEAD, RADAR_LINKS } from './radar/index';
import type { Radar, View } from './radar/radarReplay';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN_KEY = 'hatch.seen.v2';

/** The days of a layer's ribbon with anything going on: hexagons between "not yet" and "over", or sightings. */
function activeDays(p: SeasonProfile): [number, number] | null {
  const n = p.seen.length;
  const top = Math.max(...p.seen, ...(p.seenOnly ?? []).flatMap((o) => o.seen)) || 1;
  const busy = (i: number) =>
    1 - (p.bands[0]?.share[i] ?? 0) - (p.bands[p.bands.length - 1]?.share[i] ?? 0) > 0.01 || p.seen[i]! > 0.03 * top;
  let a = 0;
  let b = n - 1;
  while (a < n && !busy(a)) a++;
  while (b > a && !busy(b)) b--;
  return a < n ? [a, b] : null;
}

/**
 * Each species' slider spans its own season, not one fixed April to September for all: the whole months around the
 * days its ribbon has anything in (src/ui/scrubber.ts), so a summer beetle's ribbon isn't 40% empty paper. `s` is the
 * layer's full replay range, which the ribbon's day 0 is; live mode keeps its full range.
 */
function fitSeason(layer: HatchLayer, s: TimeSpec): TimeSpec {
  const p = s.asOf ? undefined : layer.profile?.();
  const on = p && activeDays(p);
  if (!on) return s;
  const DAY = TimeAxis.DAY;
  const a = new Date(s.start + Math.max(0, on[0] - 7) * DAY);
  const b = new Date(s.start + (on[1] + 7) * DAY);
  const start = Math.max(s.start, Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
  const end = Math.min(s.end, Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0));
  return start === s.start && end === s.end ? s : { ...s, start, end };
}

/** A ribbon cut to the slider's range: `off` days in from the layer's full range, `n` days long. */
function cutProfile(p: SeasonProfile, off: number, n: number): SeasonProfile {
  if (!off && n === p.seen.length) return p;
  const cut = (v: number[]) => v.slice(off, off + n);
  return {
    bands: p.bands.map((b) => ({ ...b, share: cut(b.share) })),
    seen: cut(p.seen),
    seenOnly: p.seenOnly?.map((o) => ({ ...o, seen: cut(o.seen) })),
    notes: p.notes.map((k) => ({ ...k, at: k.at - off })).filter((k) => k.at >= 0 && k.at < n),
  };
}

function start() {
  const params = new URLSearchParams(location.search);
  const years = data.years.map(String);
  // Default: every year pooled by day of year (one season alone is too sparse to show the wave). ?year=2025 replays one
  // season; ?season=live (or ?year=live) asks for this year's nightly forecast, which arrives after the first paint.
  const asked = params.get('season') ?? params.get('year');
  const initialMode: Mode = asked && years.includes(asked) ? asked : TYPICAL;
  // ?date=06-10 (or 2025-06-10) puts the cursor on that calendar day; default 10 June, when the wave crosses the middle.
  const md = params.get('date')?.match(/(\d{2})-(\d{2})$/);
  const [month, day] = md ? [Number(md[1]) - 1, Number(md[2])] : [5, 10];
  // ?today=2027-01-15 fakes the clock: the off-season countdown, and whether live mode is in season or its file is late.
  const todayParam = params.get('today');
  const clock = todayParam && !Number.isNaN(Date.parse(todayParam)) ? Date.parse(todayParam) : Date.now();
  // ?at=41.88,-87.63,6.5 reopens a shared link at the same place and zoom. Anything not near the Midwest (a typo,
  // an empty part) is ignored rather than handed to the map, which would throw and stay blank.
  const atParts = params.get('at')?.split(',') ?? [];
  const atNums = atParts.map((x) => (x.trim() === '' ? NaN : Number(x)));
  const sharedAt =
    atNums.length === 3 && atNums.every(Number.isFinite) && Math.abs(atNums[0]! - 43) < 12 && Math.abs(atNums[1]! + 89) < 16
      ? (atNums as [number, number, number])
      : null;

  // Finer hexagons load when the user zooms in; when they arrive (or the level changes) redraw and re-sync the card.
  let onLunaData = () => {};
  const luna = createLunaLayer(initialMode, () => onLunaData());
  const registry = new LayerRegistry();
  registry.register(luna, fitSeason(luna, replayTimeSpec(initialMode, month, day)));
  // The species on screen. Only one is active at a time; each other species loads the first time it is picked.
  let cur: LunaLayer = luna;
  let curKey = 'luna';
  /** A ?species= link's species, until it has loaded (the address bar keeps asking for it meanwhile). */
  let speciesPending: string | null = null;
  const loaded = new Map<string, LunaLayer>([['luna', luna]]);

  const time = new TimeAxis(registry.activeTime()!, clock);
  let spec: TimeSpec | null = registry.activeTime();
  // Playback slows to 8 days/s while the active layer says its season is in full swing and runs 18 days/s otherwise.
  // Reduced motion keeps one steady speed.
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  time.pace = (t) => (still.matches ? 14 : registry.activeLayers().some((l) => l.busy?.(t)) ? 8 : 18);

  let hit: ProbeHit | null = null;
  let pinned = false;
  let resetKeys = () => {}; // set once the keyboard explorer is built; a species or season switch starts it afresh
  let lastPin: [number, number] | null = null; // the last pinned spot, by any means: where the keyboard explorer starts
  // An open radar replay (src/radar/): the map belongs to it for now, so hexagons give no cards.
  let radar: Radar | null = null;
  const probeEl = $('probe');
  // With a mouse, the hex card sits next to the pointer, like a tooltip, so hovering visibly does something.
  // Touch screens and "My area" keep it docked above the time bar.
  const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
  // Placing is separate from rebuilding: a pan only moves the card, so a screen reader doesn't re-read it every frame.
  const placeProbe = () => {
    // A pinned card stays on its hex as the map pans or zooms: re-project the hex rather than reuse the click point.
    const px = hover.matches && !probeEl.hidden && hit?.px ? (pinned ? (map.project(hit.lngLat) ?? hit.px) : hit.px) : undefined;
    probeEl.classList.toggle('at-pointer', !!px);
    probeEl.classList.toggle('pinned', !!px && pinned);
    // A card that follows the pointer would make a screen reader read out every hex swept over; announce it once pinned.
    probeEl.setAttribute('aria-live', px && !pinned ? 'off' : 'polite');
    // A pinned hex panned off-screen hides its card until it comes back, rather than leaving it stuck at the edge.
    probeEl.style.visibility = px && (px[0] < 0 || px[1] < 0 || px[0] > window.innerWidth || px[1] > window.innerHeight) ? 'hidden' : '';
    if (!px) return probeEl.style.removeProperty('transform');
    const { width: w, height: h } = probeEl.getBoundingClientRect();
    const x = Math.max(8, px[0] + 16 + w > window.innerWidth - 8 ? px[0] - 16 - w : px[0] + 16);
    // Its top sits a fixed step above the pointer, so pinning (which adds lines below) never moves the title.
    const y = Math.max(8, Math.min(px[1] - 28, window.innerHeight - h - 8));
    probeEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  // Set once the drawer is mounted: its spot card follows the tapped hex (or My area) and the date.
  let followSpot = (_t: number) => {};
  let placeNote = () => {}; // the after-the-wave margin note, set up once the map exists
  const updateProbe = () => {
    // The pinned or hovered hexagon is the one on screen now: after a zoom changes the level, use that level's cell.
    if (hit && (!hit.picked || isForecast(hit.picked.layerId))) hit.cell = cur.cellAt(hit.lngLat) ?? hit.cell;
    if (pinned && hit) lastPin = hit.lngLat;
    showProbe(probeEl, registry, hit, time.cursor, pinned);
    // A pinned hexagon gets an outline (not a pinned moth dot: its own glow already marks it).
    map.setPicked(pinned && hit && (!hit.picked || isForecast(hit.picked.layerId)) ? hit.cell : null);
    placeProbe();
    followSpot(time.cursor);
  };
  const unpin = () => {
    if (!pinned && !hit) return;
    pinned = false;
    hit = null;
    map.setMarker(null);
    updateProbe();
  };

  let intro: Intro | null = null; // the first visit's opening playback (ui/intro.ts), while it runs
  const colourKey = mountLegend($('legend'), registry);
  time.subscribe(() => time.playing && !intro?.running && colourKey.autoFold());

  // Space the panels leave for the Midwest. On a short screen (a phone on its side) they can add up to more than the
  // window, which makes the map fit throw, so shrink both edges to always leave at least 80px of map.
  const phone = window.matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 500px)');
  // A phone on its side: the caveat folds into the key chip, and the About panel opens at the side.
  const slim = window.matchMedia('(orientation: landscape) and (max-height: 500px)');
  let legendH = 0;
  const padding = (): Padding => {
    const top = $('top').getBoundingClientRect().bottom + 8;
    // On wide screens the legend and card sit in the bottom-left corner, beside the map rather than under it.
    // On a phone the legend sits under the map, so leave room for it, but not for a docked card: that comes and
    // goes with every tap, and would make the map jump each time. (The card replaces the legend while it is up.)
    // Folded to its small chip, it takes no room: the Midwest gets the height.
    const legend = $('legend').offsetHeight;
    if (legend) legendH = legend;
    const floats = $('floats');
    const solid = $('bottom').offsetHeight - floats.offsetHeight;
    const keyH = phone.matches && !$('legend').classList.contains('folded') ? legendH + parseFloat(getComputedStyle(floats).paddingBottom) : 0;
    const drawer = $('drawer');
    const open = drawer.classList.contains('open');
    // A phone's About sheet at its middle stop leaves the map above it in use: fit the Midwest above the sheet.
    // (Its target height, not its offsetHeight, which lags behind while it changes stop.)
    const sheet = open && phone.matches && !slim.matches && !drawer.classList.contains('full') ? window.innerHeight * 0.44 : 0;
    const bottom = Math.max(solid + keyH, sheet) + 8;
    const k = Math.min(1, (window.innerHeight - 80) / (top + bottom));
    // On a wide screen (or a phone on its side) the open About panel sits beside the map: fit the Midwest into what is
    // left. Otherwise, on a phone, the My area / Share stack floats on the right edge: keep the Midwest clear of it.
    const beside = open && (!phone.matches || slim.matches);
    const right = beside ? drawer.offsetWidth : phone.matches ? $('actions').offsetWidth + 8 : 0;
    // The stack sits on the key, low on a tall phone: the map may use the full width above it. Worked out from the
    // padding, not where the stack is now, so a docked card (which lifts it ~20 px) never re-fits the map.
    const dock = solid + (phone.matches ? legendH + parseFloat(getComputedStyle(floats).paddingBottom) : 0) + 8;
    const rightFrom = !beside && phone.matches && !slim.matches ? window.innerHeight - Math.max(bottom, dock) - $('actions').offsetHeight - 30 : undefined;
    return { top: Math.max(0, top * k), bottom: Math.max(0, bottom * k), right: Math.min(right, window.innerWidth / 2), rightFrom, dock: sheet ? 0 : dock };
  };
  let firstDrawn = false;
  let startIntro = () => {}; // set once the first-visit check below has run
  const map = createMap({
    container: $<HTMLDivElement>('map'),
    registry,
    time,
    padding,
    covers: () => [...document.querySelectorAll('#top > :not(#explore), #explore:focus, #legend, #probe, #recenter, #actions > *')],
    onMove: (moved) => {
      $('recenter').hidden = !moved;
      document.querySelector('.brand')!.classList.toggle('over-map', moved);
    },
    // The loading caterpillar bows out as the first frame lands.
    onFirstDraw: () => {
      firstDrawn = true;
      startIntro();
      const l = document.getElementById('loader');
      l?.classList.add('done');
      setTimeout(() => l?.remove(), 250);
    },
    onView: () => {
      if (pinned) placeProbe();
      else if ($('drawer').classList.contains('open')) followSpot(time.cursor);
      placeNote();
      syncUrl(); // a shared link reopens the same place and zoom
    },
    onProbe: (h, clicked) => {
      if (radar) return;
      if (clicked) {
        // Tap pins the card; tapping the same thing again (or empty space) unpins it. Hover alone never unpins.
        // The same picked object is the same thing, even when the pinned hit's cell was re-derived from its point and
        // landed on a neighbour (a point near a hex edge). A hex pinned from My area or the city menu has no picked
        // object, so the cell alone decides.
        const same = pinned && h !== null && hit !== null && (hit.picked ? h.picked?.object === hit.picked.object : h.cell === hit.cell);
        pinned = h !== null && !same;
        hit = pinned ? h : null;
        map.setMarker(null); // any tap replaces the "My area" pin
        colourKey.autoFold(); // the reader has found the map: fold the key to a chip on small screens
      } else if (!pinned) hit = h;
      updateProbe();
    },
  });

  // The map is a canvas, so screen readers get the day's picture in words (read with the map, not announced each frame).
  const srSummary = $('sr-summary');
  // After the season the map goes one flat colour, which reads as "no data". A margin note on empty paper (the
  // layer's own words, sketch and spot, HatchLayer.offSeason) says they are asleep. It only shows on the fitted view,
  // so it never sits on hexes, and fades as soon as any hexagon starts.
  const note = document.createElement('div');
  note.id = 'asleep';
  note.setAttribute('aria-hidden', 'true'); // the screen-reader summary already says every hexagon is over
  let shownNote: unknown = null;
  // When playback reaches the last day, the layer's end note (HatchLayer.endNote) goes on the same empty paper: just
  // under the margin note on a phone, just over it on a wide screen. Never over the map's hexes, the dock or the
  // slider's ribbon: with no room for it, only Replay and the status message say it.
  const endEl = document.createElement('p');
  endEl.id = 'end-note';
  endEl.setAttribute('role', 'status');
  let endWords: [string, string] | null = null;
  let endClear = 0;
  $('app').append(note, endEl);
  // Panels a note must stay clear of: the header, the dock (with the time slider and its ribbon), the key, the card,
  // the phone's button stack, the recenter button, the town finder and an open About panel.
  const blockers = () =>
    [...document.querySelectorAll('#top, #dock, #legend .legend-card, #legend .lg-chip, #probe:not([hidden]), #actions, #recenter:not([hidden]), #finder:not([hidden]), #drawer.open')]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width && r.height);
  const fits = (x: number, y: number, w: number, h: number, block: DOMRect[]) =>
    x >= 4 && y >= 4 && x + w <= window.innerWidth - 4 && y + h <= window.innerHeight - 4 &&
    block.every((r) => x + w <= r.left || x >= r.right || y + h <= r.top || y >= r.bottom);
  const place = (el: HTMLElement, spot: [number, number] | null, tilt: number) => {
    el.classList.toggle('on', !!spot);
    if (spot) el.style.transform = `translate(${Math.round(spot[0])}px, ${Math.round(spot[1])}px) rotate(${tilt}deg)`;
    return spot;
  };
  placeNote = () => {
    // Runs on every pan and zoom frame: the cheap tests first, and no layout read unless a note will show.
    if (map.moved() || (!endWords && !note.classList.contains('on') && !registry.activeLayers().some((l) => l.offSeason?.(time.cursor)))) {
      place(note, null, 0);
      place(endEl, null, 0);
      return;
    }
    // The active layers' own note, only when every one of them has one to show (the layers cache this per day).
    const notes = registry.activeLayers().map((l) => l.offSeason?.(time.cursor));
    const n = notes.length && notes.every(Boolean) ? notes[0]! : null;
    if (n && n !== shownNote) {
      shownNote = n;
      note.innerHTML = `<svg viewBox="0 0 64 34">${n.sketch}</svg><b>${n.title}</b><span>${n.line}</span>`;
    }
    const anchor = n?.at ?? notes.find(Boolean)?.at ?? MIDWEST_MARGIN;
    const atPhone = phone.matches ? map.project(anchor.phone) : null;
    const atWide = map.project(anchor.wide);
    const block = blockers();
    // Phone: centred on its spot under the data. Wide screen: starting at its spot east of the data, on blank paper,
    // which is also where a phone on its side (no room under the data) puts the end note.
    const spotFor = (w: number, h: number): [number, number] | null => {
      const tries: [number, number][] = [];
      if (atPhone) tries.push([atPhone[0] - w / 2, atPhone[1]]);
      if (atWide) tries.push([atWide[0], atWide[1] - h / 2]);
      return tries.find(([x, y]) => fits(x, y, w, h, block)) ?? null;
    };
    let box: [number, number, number, number] | null = null;
    if (n) {
      const { width: w, height: h } = note.getBoundingClientRect();
      const s = place(note, w && h ? spotFor(w, h) : null, -3); // none on a phone on its side (style.css)
      if (s) box = [s[0], s[1], w, h];
    } else place(note, null, 0);
    if (!endWords) return void place(endEl, null, 0);
    const { width: w, height: h } = endEl.getBoundingClientRect();
    let spot: [number, number] | null = null;
    if (box) {
      const [x0, y0, w0, h0] = box;
      const x = x0 + (w0 - w) / 2;
      const tries: [number, number][] = phone.matches ? [[x, y0 + h0 + 6], [x, y0 - h - 8]] : [[x, y0 - h - 8], [x, y0 + h0 + 6]];
      spot = tries.find(([tx, ty]) => fits(tx, ty, w, h, block)) ?? null;
    } else spot = spotFor(w, h);
    place(endEl, spot, -2);
  };
  const showEnd = (words: [string, string] | null) => {
    clearTimeout(endClear);
    endWords = words;
    if (words) endEl.replaceChildren(words[0], Object.assign(document.createElement('small'), { textContent: words[1] }));
    // Emptied once faded, so the same words are announced again at the next ending.
    else endClear = window.setTimeout(() => endEl.replaceChildren(), 450);
    placeNote();
  };
  const refresh = () => {
    map.refresh();
    updateProbe();
    placeNote();
    srSummary.textContent = cur.summary(time.cursor);
  };
  time.subscribe(refresh);
  // The calendar day the reader asked for (a link's ?date=, the slider, playback), kept apart from the cursor: each
  // species' slider spans only its own season (fitSeason), so the cursor may be clamped to fit. Switching species or
  // season asks for this day again, so beetle Sep 30 -> firefly (shows Aug 31) -> back to beetle is Sep 30 again.
  const dayOf = (ms: number): [number, number] => [new Date(ms).getUTCMonth(), new Date(ms).getUTCDate()];
  let wantDay: [number, number] = [month, day];
  let fitting = false; // a switch is moving the cursor (maybe clamping it): not the reader's own pick
  time.subscribe(() => {
    if (!fitting) wantDay = dayOf(time.cursor);
  });
  /** Re-span the slider without letting a clamp overwrite wantDay. */
  const asSwitch = (change: () => void) => {
    fitting = true;
    try {
      change();
    } finally {
      fitting = false;
    }
  };
  time.onFrame(map.refresh); // in-between frames while playing: only the map moves, the card and summary keep the day
  onLunaData = refresh;
  registry.subscribe(() => {
    const next = registry.activeTime();
    if (next && next !== spec) {
      spec = next;
      time.setSpec(next);
    }
    refresh();
  });

  // Season picker: switching keeps the cursor on the same calendar day.
  const picker = $<HTMLSelectElement>('season');
  // This year's live forecast for luna, once its file has loaded. Every species has its own (cur.live()).
  let liveFile: Live | null = null;
  // A ?season=live link opens on the default view until the file arrives: keep "season=live" in the address bar meanwhile.
  let livePending = asked === LIVE;
  // A narrow phone's closed menu shows just the season ("2024"), not its count, which would be cut off ("2024 (1,498
  // beet"); the open menu still lists the counts (style.css).
  /** The season menu's words for a mode, with the species on screen's own live forecast. */
  const label = (m: Mode) => (cur.seasons && m === TYPICAL ? 'typical year' : modeLabel(m, cur.live()));
  /** A layer's slider for a mode (live mode: from that layer's own live forecast). */
  // A tracker has no forecast after its last day, so no paler "forecast" stretch on the time bar.
  const timeFor = (l: LunaLayer, m: Mode, mo?: number, d?: number): TimeSpec => {
    if (l.timeSpec) return l.timeSpec(m, mo, d);
    const s = replayTimeSpec(m, mo, d, clock, l.live());
    return l.tracker ? { ...s, asOf: undefined } : s;
  };
  const face = () => (picker.parentElement!.dataset.face = picker.value === TYPICAL ? (cur.seasons ? 'Typical' : 'All years') : label(picker.value));
  const fillPicker = () => {
    const keep = picker.value || initialMode;
    const live = cur.live() ? [LIVE] : [];
    // The counts are sightings (photos) of the species' own kind (cur.words.countedAs, e.g. first-wave moths), so the
    // menu says "seen", not a number of animals. "All years" goes without one so the closed menu fits a small phone.
    // A species the nightly file has no forecast for (yet): say so at the top of the list rather than drop it silently.
    picker.innerHTML = (__BASEMAP__ && liveFile && !cur.live() ? `<option disabled>${liveFile.season}: not for ${cur.words.plural} yet</option>` : '') +
      (cur.seasons?.() ?? [...live, TYPICAL, ...[...years].reverse().filter((y) => !cur.tracker || cur.seasonCount(y) > 0)])
        .map((m) => `<option value="${m}">${m === LIVE ? label(LIVE) : m === TYPICAL ? (cur.seasons ? 'Typical year' : 'All years') : cur.seasons ? m : `${m} (${cur.seasonCount(m).toLocaleString()} seen)`}</option>`)
        .join('');
    picker.value = keep === LIVE && !live.length ? TYPICAL : keep;
    if (picker.selectedIndex < 0 || picker.options[picker.selectedIndex]!.disabled) picker.value = TYPICAL; // not a season this species has
    face();
    picker.title = `Season to replay (sightings of ${cur.words.countedAs} in parentheses)`;
  };
  fillPicker();
  // This season, live: "next season ... days" would contradict the map.
  const syncCountdown = () => {
    const L = cur.live();
    $('countdown').hidden = picker.value === LIVE && !!L && inSeason(L, clock);
  };
  // Live mode opens on its last day of observed weather (or the day a link asks for); the others keep the calendar day.
  const switchMode = (m: Mode, at?: [number, number]) => {
    cur.setMode(m);
    hit = null;
    pinned = false;
    resetKeys();
    map.setMarker(null);
    $('season-name').textContent = label(m);
    face();
    at ??= m === LIVE ? undefined : wantDay;
    asSwitch(() => registry.setTime(cur.id, fitSeason(cur, timeFor(cur, m, at?.[0], at?.[1]))));
    if (!at) wantDay = dayOf(time.cursor); // live opens on its own last observed day: that becomes the day asked for
    updateProbe(); // a card pinned in the old season describes that season: it went with the switch
    syncCountdown();
  };
  picker.addEventListener('change', () => ((wantLive = null), switchMode(picker.value)));
  /** A species that should open on live mode once its live forecast is attached (see setSpecies), and the day to open
   * on: a link's own date=, else none (live mode opens on that species' as-of day, however it is entered). */
  let wantLive: { key: string; at?: [number, number] } | null = null;
  const goLiveIfWanted = () => {
    if (wantLive?.key !== curKey || !cur.live() || picker.value === LIVE) return;
    const at = wantLive.at;
    wantLive = null;
    picker.value = LIVE;
    switchMode(LIVE, at);
    syncUrl();
  };
  $('season-name').textContent = modeLabel(initialMode);

  // Species picker (src/ui/speciesPicker.ts): a search box over the tree of life, the hand-built species first. Switching
  // keeps the season and the calendar day, and drops any pinned card.
  const speciesPick = mountSpeciesPicker($<HTMLButtonElement>('species'), $('species-sheet'), SPECIES, (k) => void setSpecies(k));
  let asking = 0;
  const loading = new Map<string, Promise<LunaLayer | null>>(); // the latest pick: a slow load that finishes after a newer pick must not switch to its species
  const setSpecies = async (want: string) => {
    const ticket = ++asking;
    const entry = (await findSpecies(want)) ?? SPECIES[0]!;
    if (ticket !== asking) return;
    if (!loaded.has(entry.key)) {
      if (!entry.load) return;
      // One load per species, however many times it is picked meanwhile (a slow Atlas load, a double tap on a card).
      let pending = loading.get(entry.key);
      if (!pending) {
        const mode0 = picker.value === LIVE ? TYPICAL : picker.value;
        // Its live forecast can arrive after the layer (src/species.ts): refill the menu, and go live if that was wanted.
        pending = entry
          .load(mode0, () => onLunaData(), () => {
            if (loaded.get(entry.key) !== cur) return;
            fillPicker();
            goLiveIfWanted();
          })
          .catch(() => null)
          .then((layer) => {
            if (layer && !loaded.has(entry.key)) {
              loaded.set(entry.key, layer);
              registry.register(layer, fitSeason(layer, timeFor(layer, mode0, 5, 10)), false);
            }
            return layer;
          })
          .finally(() => loading.delete(entry.key));
        loading.set(entry.key, pending);
      }
      speciesPick.disabled = true;
      const layer = await pending;
      speciesPick.disabled = loading.size > 0; // still waiting on another species' load
      if (ticket !== asking) return; // a newer pick won
      if (!layer) return say(`Couldn\u2019t load the ${entry.label.toLowerCase()} map. Try again later.`);
    }
    if (ticket !== asking) return;
    const next = loaded.get(entry.key)!;
    if (next === cur) return;
    // Live was wanted for it (picked from live mode, or a ?season=live&species= link): goes live as soon as its live
    // forecast is there, now or when the file arrives.
    const fromLink = speciesPending === entry.key && asked === LIVE;
    wantLive = picker.value === LIVE || fromLink ? { key: entry.key, at: fromLink && md ? [month, day] : undefined } : null;
    // A species with no live season (yet): switching to it from live mode goes to all years, on the same day.
    if (!next.live() && picker.value === LIVE) {
      picker.value = TYPICAL;
      $('season-name').textContent = modeLabel(TYPICAL);
    }
    hit = null;
    pinned = false;
    resetKeys();
    map.setMarker(null);
    // Keep the season if the new species has it (an Atlas species has a typical year and 2026), else all years; a
    // link's own season wins while its species loads.
    const offers = next.seasons?.() ?? [...(next.live() ? [LIVE] : []), TYPICAL, ...years];
    // (A link may name a hand-built species by its Latin key, ?species=photinus-pyralis.)
    const fromThisLink = speciesPending === entry.key || (!!entry.sci && speciesPending === atlasKey(entry.sci));
    const mode = fromThisLink && asked && offers.includes(asked) ? asked : offers.includes(picker.value) ? picker.value : TYPICAL;
    next.setMode(mode);
    const prev = cur;
    cur = next;
    curKey = entry.key;
    speciesPick.show(entry.key, entry.label);
    fillPicker();
    picker.value = mode;
    if (picker.value !== mode) (picker.value = TYPICAL), cur.setMode(TYPICAL); // a tracker's year with no sightings
    $('season-name').textContent = label(picker.value);
    face();
    showMark();
    $('dots-what').textContent = cur.words.plural;
    $('app').classList.toggle('tracker', !!cur.tracker);
    $('app').classList.toggle('atlas', !!cur.seasons); // an Atlas species: a model's field, no dots or forecast
    showCountdown();
    syncCountdown();
    $('map').setAttribute('aria-label', cur.seasons ? `Midwest map: expected share of ${cur.words.sightingsOf} in insect photos` : `Midwest map: ${cur.words.sightingsOf} sightings${cur.tracker ? '' : ' over forecast hexagons'}`);
    $('explore-help').hidden = !!cur.tracker; // a tracker has no hexagons or forecast to read
    // Live mode opens on this species' own as-of day (each species' live forecast can run to its own), unless a link
    // gave a date; any other season keeps the calendar day.
    const live = picker.value === LIVE;
    const at = live ? wantLive?.at : wantDay;
    if (live) wantLive = null;
    asSwitch(() => {
      registry.setTime(cur.id, fitSeason(cur, timeFor(cur, picker.value, at?.[0], at?.[1])));
      // Old one off first, so the two never draw together for a frame.
      registry.setActive(prev.id, false);
      registry.setActive(cur.id, true);
    });
    if (live && !at) wantDay = dayOf(time.cursor); // its as-of day becomes the day asked for, as in switchMode
    syncUrl();
    goLiveIfWanted();
  };
  // The one-file preview has no species files next to it, so it offers luna only.
  if (!__BASEMAP__) speciesPick.button.parentElement!.hidden = true;
  // On narrow phones the closed menu shows just the species' sketch mark (style.css), so it stays one small square.
  const markImg = $('mark') as HTMLImageElement;
  let markSeq = 0;
  const showMark = () => {
    const sketch = cur.words.mark;
    const seq = ++markSeq;
    void markFor(sketch).then((url) => {
      if (seq !== markSeq) return; // the species or the theme changed meanwhile
      markImg.src = url;
      speciesPick.button.style.setProperty('--mark', `url("${url}")`);
    });
  };
  showMark();
  // "Also out here" on an Atlas card switches to that species.
  probeEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-species]');
    if (b?.dataset.species) void setSpecies(b.dataset.species);
  });
  // ?species=<key> opens on that species (?species=firefly links from before the list still work).
  const askedSpecies = params.get('species');
  if (askedSpecies && askedSpecies !== 'luna') {
    speciesPending = askedSpecies;
    void setSpecies(askedSpecies).finally(() => (speciesPending = null));
  }

  const setRibbon = mountScrubber($('bar'), time, () => registry.activeLayers().find((l) => l.endNote)?.endNote, showEnd);
  // The slider's track pictures the active species' season; a season or species change redraws it.
  // The registry can fire several times in one change (layer off, layer on): draw the ribbon once per frame.
  // The ribbon covers the layer's full replay range; the slider may span less of it (fitSeason).
  const ribbonNow = () => {
    const p = registry.activeLayers().find((l) => l.profile)?.profile?.();
    const off = Math.round((time.start - timeFor(cur, picker.value).start) / TimeAxis.DAY);
    return p && off >= 0 ? cutProfile(p, off, time.steps + 1) : p;
  };
  let ribbonFrame = 0;
  const drawRibbon = () =>
    (ribbonFrame ||= requestAnimationFrame(() => {
      ribbonFrame = 0;
      setRibbon(ribbonNow());
    }));
  registry.subscribe(drawRibbon);
  setRibbon(ribbonNow());
  mountLayerList($('layers'), registry);
  const toggleDrawer = mountCaveatDrawer($('info-btn'), $('drawer'), registry);
  // With nothing pinned, the panel's example is the area in view (once the map has left the whole-Midwest fit).
  followSpot = (t) => {
    const view = !pinned && map.moved() && $('drawer').classList.contains('open') ? map.center(padding())?.lngLat : undefined;
    toggleDrawer.setSpot(pinned && hit ? hit.lngLat : null, t, pinned ? hit?.label : undefined, view);
  };
  // "why?" opens the About drawer at the part that says how sure the forecast is (marked data-why), and flashes it,
  // so the tap visibly lands even when the drawer is already open.
  let flashTimer = 0;
  $('why').addEventListener('click', () => {
    toggleDrawer(true, true); // the reading stop, on a phone
    const drawer = $('drawer');
    const target = drawer.querySelector<HTMLElement>('[data-why]');
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    // Scroll the drawer itself: scrollIntoView would also nudge the fixed page and leave a gap at the bottom.
    // The drawer's title bar sticks to its top, so land the target just below it.
    const head = drawer.querySelector<HTMLElement>('.drawer-head')?.offsetHeight ?? 0;
    const top = target ? target.getBoundingClientRect().top - drawer.getBoundingClientRect().top + drawer.scrollTop - head - 12 : 0;
    drawer.scrollTo({ top, behavior });
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true }); // a screen reader lands on the answer, not on the close button
    }
    const flash = target ?? drawer.querySelector<HTMLElement>('.cav') ?? drawer;
    flash.classList.remove('flash');
    void flash.offsetWidth; // restart the animation on a repeat tap
    flash.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => flash.classList.remove('flash'), 1500);
  });

  // Keep the address bar in step with the view, so any link copied or shared reopens the same season and day.
  const viewUrl = () => {
    const q = new URLSearchParams(location.search);
    const d = new Date(time.cursor);
    q.set('date', `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    q.delete('season');
    const sp = speciesPending ?? curKey;
    if (sp === 'luna') q.delete('species');
    else q.set('species', sp);
    if (livePending) (q.delete('year'), q.set('season', LIVE));
    else if (picker.value === TYPICAL) q.delete('year');
    else if (picker.value === LIVE) (q.delete('year'), q.set('season', LIVE));
    else q.set('year', picker.value);
    // The place and zoom, once the view has left the whole-Midwest fit (a link from the default view stays short). A radar
    // replay's link names the replay instead, which brings its own view.
    const c = map.center(padding());
    if (map.moved() && c && !radar) q.set('at', `${c.lngLat[1].toFixed(3)},${c.lngLat[0].toFixed(3)},${c.zoom.toFixed(1)}`);
    else q.delete('at');
    if (radar) q.set('radar', radar.id);
    else q.delete('radar');
    q.delete('noauto');
    q.delete('today');
    return `${location.pathname}?${q}`;
  };
  // Throttled, not debounced: playback updates every frame, and the address bar should still keep up.
  let urlTimer = 0;
  const syncUrl = () => {
    if (urlTimer) return;
    urlTimer = window.setTimeout(() => {
      urlTimer = 0;
      if (intro?.running) return; // the opening's passing days are not a view to link to; it syncs when it lands
      history.replaceState(null, '', viewUrl());
    }, 400);
  };
  time.subscribe(syncUrl);
  // A reload (the map's Redraw) or leaving must not drop the last move still waiting on the timer.
  addEventListener('pagehide', () => { intro?.finish(); clearTimeout(urlTimer); urlTimer = 0; history.replaceState(null, '', viewUrl()); });
  picker.addEventListener('change', syncUrl);

  const msg = $('action-msg');
  const finderEl = $('finder'); // held on to: the town box can sit inside the About panel for a while
  let msgTimer = 0;
  // A status line beside the button it answers (above it in the time bar, to its left in a phone's button stack), or
  // under the header when no button asked.
  const say = (text: string, from?: Element | null) => {
    msg.textContent = text;
    msg.classList.toggle('at', !!from);
    const b = from?.getBoundingClientRect();
    if (b?.width) {
      const { width: w, height: h } = msg.getBoundingClientRect();
      const column = getComputedStyle(from!.parentElement!).flexDirection === 'column';
      const x = column ? b.left - 8 - w : b.right - w;
      // In the time bar it clears the bar's own text line too, sitting just over the paper.
      let y = column ? b.top + (b.height - h) / 2 : Math.min(b.top, from!.closest('#dock')?.getBoundingClientRect().top ?? b.top) - 6 - h;
      // A card docked in that corner keeps its lines readable: the message goes above it.
      const c = probeEl.hidden ? null : probeEl.getBoundingClientRect();
      if (c && !column && x < c.right && x + w > c.left && y < c.bottom && y + h > c.top) y = c.top - 6 - h;
      msg.style.left = `${Math.round(Math.max(8, x))}px`;
      msg.style.top = `${Math.round(Math.max(8, y))}px`;
    } else msg.style.left = msg.style.top = '';
    clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => (msg.textContent = ''), 6000);
  };

  $('share').addEventListener('click', async () => {
    const url = new URL(viewUrl(), location.href).href;
    try {
      if (navigator.share) await navigator.share({ title: `Hatch: when ${cur.words.shareName} come out`, url });
      else {
        await navigator.clipboard.writeText(url);
        say('Link copied', $('share'));
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say('Couldn\u2019t share. Copy the link from the address bar.', $('share'));
    }
  });

  // The hexagons within k rings of lat/lng, nearest centre first.
  const nearby = (lat: number, lng: number, k: number) =>
    gridDisk(latLngToCell(lat, lng, GRID_RES), k)
      .map((c) => {
        const [la, ln] = cellToLatLng(c);
        return { cell: c, lngLat: [ln, la] as [number, number], d: (la - lat) ** 2 + (ln - lng) ** 2 };
      })
      .sort((a, b) => a.d - b.d);
  // Pin the card (and the About panel's spot) on the hexagon at lat/lng, named `label`, and bring the map to it.
  // Lakeshore cities (Chicago, Milwaukee, Cleveland) can sit in a hex whose centre is in the lake, so fall back to
  // the nearest land hex within two rings.
  const showPlace = (lat: number, lng: number, label: string): 'exact' | 'nearby' | null => {
    const ring = nearby(lat, lng, 2);
    const first = { cell: latLngToCell(lat, lng, GRID_RES), lngLat: [lng, lat] as [number, number] };
    const here: ProbeHit | undefined = [first, ...ring].find((h) => cur.probe?.(h.lngLat, time.cursor));
    if (!here) return null;
    hit = { ...here, label };
    pinned = true;
    map.setMarker(null);
    // Close enough to see the town's neighbours, and never further out than the current view.
    map.focus([lng, lat], Math.max(map.fitZoom() + 1.5, map.zoom() ?? 0), padding(), true);
    updateProbe();
    return here === first ? 'exact' : 'nearby';
  };
  // "Explore map with keys": arrows walk a pinned selection hex to hex (the same pinned card, announced by its live
  // region), Enter or Space pins where it starts, Escape lets go (the handler below). It starts at the last pinned hex,
  // or else the middle of the free map, and pans the map when the selection leaves the view.
  let col = 0; // the longitude of the column an up or down walk keeps to
  let row = 0; // the latitude of the row a left or right walk keeps to
  // The selection the keys last made. Pinned any other way since, the walk starts afresh from there. (The selection
  // itself, not its hexagon: a zoom swaps the hexagon for one of the new size, and the walk and its count go on.)
  let keyHit: ProbeHit | null = null;
  let steps = 0;
  let nudge = false; // alternates a trailing space, so a repeated message is announced again
  resetKeys = () => ((keyHit = null), (steps = 0));
  const hasForecast = (p: [number, number]) => !!cur.probe?.(p, time.cursor);
  // The free area of the map, inside a margin: where a selected hexagon is in view.
  const inView = (lngLat: [number, number]) => {
    const p = padding();
    const at = map.project(lngLat);
    return !!at && at[0] > 24 && at[1] > p.top + 24 && at[0] < innerWidth - (p.right ?? 0) - 24 && at[1] < innerHeight - p.bottom - 24;
  };
  // What the card says first, new at every step so a screen reader reads each one: the nearest town in the map's own
  // names (when one is close), and how many steps and which way.
  const where = (lngLat: [number, number], dir: string) => {
    let town = '';
    let best = 0.35 ** 2; // degrees, squared
    for (const [name, lng, lat, , kind] of basemapLabels()) {
      const d = (lng - lngLat[0]) ** 2 + (lat - lngLat[1]) ** 2;
      if ((kind === 'city' || kind === 'town') && d < best) (best = d), (town = name);
    }
    return `${steps ? `Step ${steps} ${dir}` : 'Start'}${town ? `, near ${town}` : ''}`;
  };
  const selectCell = (cell: string, dir = '') => {
    const [la, ln] = cellToLatLng(cell);
    hit = { cell, lngLat: [ln, la] };
    hit.note = where(hit.lngLat, dir);
    keyHit = hit;
    pinned = true;
    // Off the free area (or near its edge): bring the hexagon to the middle of it, as the town finder does.
    if (!inView(hit.lngLat)) map.focus(hit.lngLat, map.zoom() ?? 0, padding(), true);
    updateProbe();
  };
  // Where a first key press lands: the last pinned hexagon if it is in view, else the middle of the free map; the
  // nearest hexagon with a forecast, within view, if that spot has none.
  const startCell = (): string | null => {
    const mid = map.center(padding())?.lngLat;
    const from = lastPin && inView(lastPin) ? lastPin : mid;
    if (!from) return null;
    const at = [{ lngLat: from }, ...nearby(from[1], from[0], 4)].find((h) => inView(h.lngLat) && hasForecast(h.lngLat));
    return at ? cur.cellAt(at.lngLat) : null;
  };
  // Enter or Space. An arrow comes here too when the pinned card has no forecast hexagon under it (a sighting past
  // the shore, land beyond the Midwest): the arrows can't move that one, so they start a walk from the nearest hexagon
  // rather than say "Already pinned", which would be wrong.
  const pin = (arrowed = false) => {
    if (radar) return; // the radar replay has the map: no hexagon to walk under it
    if (pinned && !arrowed) return say('Pinned. Arrow keys move it, Escape lets go.');
    const c = startCell();
    if (!c) return say('No forecast in view');
    steps = 0;
    [row, col] = cellToLatLng(c);
    selectCell(c);
  };
  const arrow = (a: Arrow) => {
    if (radar) return;
    const from = pinned && hit ? cur.cellAt(hit.lngLat) : null;
    if (!from) return pin(true);
    if (hit !== keyHit) ([row, col] = cellToLatLng(from)), (steps = 0); // pinned by mouse, tap or town since: start afresh there
    const next = stepCell(from, a, col, row, (c) => hasForecast(cellToLatLng(c).reverse() as [number, number]));
    if (!next) return say(`No forecast to the ${WORD[a]}${(nudge = !nudge) ? '\u00a0' : ''}`);
    // A new column (left and right) or row (up and down); the walk keeps the other.
    if (a === 'ArrowLeft' || a === 'ArrowRight') col = cellToLatLng(next)[1];
    else row = cellToLatLng(next)[0];
    steps++;
    selectCell(next, WORD[a]);
  };
  // The time slider listens on the window for these same keys (and Home, End): while this has focus it owns them.
  $('explore').addEventListener('keydown', (e) => {
    const move = e.key in AIM;
    const own = move || ['Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key);
    if (e.ctrlKey || e.metaKey || e.altKey || !own) return;
    e.preventDefault();
    e.stopPropagation();
    if (move) arrow(e.key as Arrow);
    else if (e.key === 'Enter' || e.key === ' ') pin();
  });
  // Find a town (needs the map's town names, so not in the one-file build). The About panel's "Find a town" opens the
  // same box inside the panel: a way to read a place's season without pointing at the map.
  if (__BASEMAP__) {
    const finder = mountFinder($('find'), $('finder'), (lat, lng, name) => {
      radar?.close(false); // a town's card replaces the radar replay; the map goes to the town, not back to the Midwest
      // On a phone, drop the About sheet to its middle stop first, so the place lands in the map above it.
      if ($('drawer').classList.contains('open') && phone.matches && !slim.matches) toggleDrawer(true);
      if (!showPlace(lat, lng, name)) say(`No forecast for ${name}`, $('find'));
    }, say);
    $('drawer').addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-find]');
      if (!b) return;
      // On a phone the sheet goes to its tall stop first, so the box shows above the keyboard.
      if (phone.matches && !slim.matches) toggleDrawer(true, true);
      finder.open(b);
    });
    toggleDrawer.onLeave(finder.leave);
  } else $('find').hidden = true;

  // "My area": one location fix (never stored or sent anywhere), then the forecast card for that hex, pinned.
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return say('Location is not available in this browser', $('locate'));
    const btn = $<HTMLButtonElement>('locate');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    const done = () => {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    };
    say('Finding you…', btn);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        done();
        const at = showPlace(coords.latitude, coords.longitude, 'you');
        if (!at) {
          map.setMarker(null);
          say('Outside Hatch\u2019s 7 states (IL, IN, IA, MI, MN, OH, WI)', btn);
          return;
        }
        map.setMarker([coords.longitude, coords.latitude]);
        // The marker is the accent brown; the pale yellow dots are moths.
        say(at === 'exact' ? 'You are the brown dot' : 'You are the brown dot (the card shows the nearest land hexagon)', btn);
      },
      (err) => (
        done(),
        say(
          err.code === err.PERMISSION_DENIED
            ? `Location is off for this site. ${__BASEMAP__ ? 'Find a town' : 'Tap the map'} instead.`
            : `Could not get your location. ${__BASEMAP__ ? 'Find a town' : 'Tap the map'} instead.`,
          btn,
        )
      ),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });

  // Each species has its own season: the firefly's starts weeks after the luna moth's. (?today= fakes the clock.)
  function showCountdown() {
    const [short, more] = cur.countdown(clock);
    const moreEl = document.createElement('span');
    moreEl.className = 'more';
    moreEl.textContent = more;
    $('countdown').replaceChildren(short, moreEl);
  }
  showCountdown();
  // A phone's bar has no room for it, so there it opens the About panel instead (re-added each time the panel redraws).
  // Phones hide the strip's countdown; it shows in About instead, under the opening line.
  const aboutCountdown = () => {
    const text = $('countdown').hidden ? '' : ($('countdown').textContent ?? '').trim();
    const hook = $('drawer').querySelector('.ex-hook');
    if (!text || !hook) return;
    const p = document.createElement('p');
    p.className = 'cd';
    p.textContent = text;
    hook.after(p);
  };
  registry.subscribe(aboutCountdown);
  aboutCountdown();

  // First visit: the map comes first. The About button and Play glow briefly to show where the story and the
  // replay are; the panel itself opens only when asked (or with ?caveats).
  let seen = true;
  try {
    seen = localStorage.getItem(SEEN_KEY) === '1';
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage blocked: skip the hint rather than repeat it every visit */
  }
  const hinted = ['info-btn', 't-play', 'why'];
  if (!seen && !params.has('noauto') && !params.has('caveats')) for (const id of hinted.slice(0, 2)) $(id).classList.add('hint');
  const clearHint = () => hinted.slice(0, 2).forEach((x) => $(x).classList.remove('hint'));
  for (const id of hinted) $(id).addEventListener('click', clearHint);
  time.subscribe(() => time.playing && !intro?.running && clearHint());
  // A first visit with a plain link opens on the season playing itself, so the forecast is seen moving before anything
  // is read. A link that asks for a view (a day, a year, a place, a species, a radar night) opens on that view instead.
  const plain = !['date', 'season', 'year', 'at', 'species', 'radar', 'noauto', 'caveats'].some((k) => params.has(k));
  // In season the live forecast becomes the default view once its file arrives, so the opening waits for that and
  // lands on today; off-season it is set up now, before the first frame. Not if the reader has already touched something.
  let touched = false;
  const touch = (e: Event) => {
    if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return; // as intro.ts
    touched = true;
    for (const ev of ['pointerdown', 'keydown', 'wheel']) removeEventListener(ev, touch, true);
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel']) addEventListener(ev, touch, true);
  const openIntro = () => {
    if (seen || !plain || still.matches || document.hidden || touched || intro) return;
    const opening = (intro = makeIntro(time, time.cursor));
    opening.begin();
    // A beat for the loader to bow out, then play. A touch before then lands it on the landing day instead.
    startIntro = () => {
      startIntro = () => {};
      setTimeout(opening.start, 400);
    };
    if (firstDrawn) startIntro();
  };

  document.documentElement.style.setProperty('--bg', theme.bg);
  map.fit(padding());
  if (sharedAt) map.focus([sharedAt[1], sharedAt[0]], sharedAt[2], padding());
  $('recenter').addEventListener('click', () => map.fit(padding(), true));
  // Re-fit whenever the room for the map changes: the window, the panels (fonts arriving, a wrapped line, the
  // About panel opening beside the map) or the map itself (a late stylesheet). A view the user has panned or
  // zoomed is theirs, so it is left alone; the recenter button still fits it.
  let fitTimer = 0;
  // Not mid-drag either: a re-fit would yank the map out from under the finger.
  let dragging = false;
  $('map').addEventListener('pointerdown', () => (dragging = true));
  // Capture phase: the phone drawer swallows the taps that close it, and this must still hear them end.
  window.addEventListener('pointerup', () => (dragging = false), true);
  window.addEventListener('pointercancel', () => (dragging = false), true);
  // A change the reader made (the key folding, the About panel opening) glides; a window resize just fits.
  let glide = false;
  const refit = (smooth = false, wait = 120) => {
    clearTimeout(fitTimer);
    glide ||= smooth;
    fitTimer = window.setTimeout(() => {
      if (dragging) return refit();
      if (!map.moved()) map.fit(padding(), glide);
      else map.rebound(padding());
      glide = false;
      placeProbe();
    }, wait);
  };
  const ro = new ResizeObserver(() => refit());
  for (const id of ['map', 'top', 'bottom']) ro.observe($(id));
  // A phone on its side opens About beside the map and above the time bar (style.css), so the bar stays whole.
  new ResizeObserver(() => $('app').style.setProperty('--dock-h', `${$('dock').offsetHeight}px`)).observe($('dock'));
  // The key folding to its chip (or opening) frees or takes room. Not while a card is up, though: a card hides the
  // key, and the tap that pinned it also folds it, and the map must not slide out from under that card.
  let keySeen = false; // the observer's first call is just it starting up
  // A window resize can resize the key too: that refit is the window's, so it fits at once rather than gliding.
  let resizedAt = -1e9;
  new ResizeObserver(() => (keySeen ? hit || refit(performance.now() - resizedAt > 1000) : (keySeen = true))).observe($('legend'));
  window.addEventListener('resize', () => ((resizedAt = performance.now()), (glide = false), refit()));
  document.fonts?.ready.then(() => refit());
  // The About panel slides in beside the map (or the phone sheet changes stop) without resizing anything the observer
  // watches. Glide with it, starting as it starts. (Mid-drag, the class flips only on letting go.)
  // Only a change of stop counts: not the classes that come and go while it is dragged or scrolled.
  let drawerState = 'falsefalse';
  new MutationObserver(() => {
    const d = $('drawer').classList;
    const now = `${d.contains('open')}${d.contains('full')}`;
    if (now !== drawerState) (drawerState = now), refit(true, 0), followSpot(time.cursor);
  }).observe($('drawer'), { attributes: true, attributeFilter: ['class'] });

  // Close a pinned card: its × button, Escape, or (with a mouse) the pointer leaving the map for a panel.
  // The × goes away with the card, so hand keyboard focus to the time slider rather than drop it on the page.
  // A tap pins its card before the browser sends that tap's click, and a docked card (a phone on its side) can open
  // right under the finger: a pointer click on the card counts only if the press started on the card. Keyboard and
  // screen-reader activations (detail 0) always count.
  let pressOnCard = false;
  window.addEventListener('pointerdown', (e) => (pressOnCard = probeEl.contains(e.target as Node)), true);
  probeEl.addEventListener('click', (e) => {
    if (e.detail > 0 && !pressOnCard) return void (e.preventDefault(), e.stopPropagation());
    if (!(e.target as Element).closest('.probe-close')) return;
    unpin();
    $('t-range').focus({ preventScroll: true });
  });
  // Capture phase, so this sees the About panel before its own Escape handler closes it: one Escape, one thing closed.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !pinned || $('drawer').classList.contains('open') || !finderEl.hidden) return;
    const hadFocus = probeEl.contains(document.activeElement);
    unpin();
    if (hadFocus) $('t-range').focus({ preventScroll: true });
  }, true);
  $('map').addEventListener('mouseleave', () => {
    if (!pinned && hit) (hit = null), updateProbe();
  });
  // A sighting's card is about one day; once playback moves on, it would describe a dot that has gone out.
  time.subscribe(() => {
    if (time.playing && pinned && hit?.picked && !isForecast(hit.picked.layerId)) unpin();
  });
  // Radar replays (src/radar/): a real evening when a weather radar saw insects come off the water. Its code and frames
  // load only when one is opened, from the About panel's link or a ?radar= link; not in the one-file build (no files
  // beside it). While open, its card takes the key's place and the time bar steps aside: it has its own play button.
  let radarAsking = 0;
  // Where × goes back to, carried over while one replay hands over to another (the map is at the old radar by then).
  let radarBack: View | null | undefined;
  // A pen radar: the dish's dot, two range rings and the sweep.
  const RADAR_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="10" stroke-dasharray="3 2.4"/><path d="M12 12l6.4-6.6"/></g><circle cx="12" cy="12" r="1.9" fill="currentColor"/></svg>';
  const openRadar = async (id: string) => {
    if (!__BASEMAP__) return;
    if ($('drawer').classList.contains('open')) toggleDrawer(false);
    if (radar?.id === id) return;
    // Switching: the open one closes where it is, and the next one takes over its way back. radar-on stays, so the
    // time bar doesn't flash up while the next one loads.
    if (radar) {
      const old = radar;
      radar = null;
      radarBack = old.before;
      old.close(false);
    }
    const ticket = ++radarAsking;
    time.pause();
    unpin();
    say('Loading the radar replay…');
    const opened = await import('./radar/radarReplay')
      .then((m) => m.openRadar(id, {
        map,
        padding,
        mount: $('floats'),
        before: radarBack,
        stale: () => ticket !== radarAsking,
        onClose: () => {
          // Only the open one owns the page's radar state: one closed for a switch, or a late one, leaves it be.
          if (radar?.id !== id) return;
          radar = null;
          $('app').classList.remove('radar-on');
          syncUrl();
        },
      }))
      .catch(() => null);
    // A later click took over while this one loaded: it is that one's turn.
    if (ticket !== radarAsking) return opened?.close(false);
    const back = radarBack;
    radarBack = undefined;
    if (!opened) {
      // Nothing opened after a switch: the map is still at the old radar, so take it back.
      if (back !== undefined) {
        $('app').classList.remove('radar-on');
        if (back) map.focus(back.lngLat, back.zoom, padding(), true);
        else map.fit(padding(), true);
        syncUrl();
      }
      return say('Couldn\u2019t load the radar replay. Try again later.');
    }
    msg.textContent = '';
    radar = opened;
    $('app').classList.add('radar-on');
    syncUrl();
  };
  // The About panel's way in, under its opening lines (re-added each time the panel redraws): a short row of evenings.
  const aboutRadar = () => {
    const hook = $('drawer').querySelector('.ex-hook');
    // Not without WebGL: there is no map to replay it on.
    if (!__BASEMAP__ || document.getElementById('no-webgl') || !hook || hook.parentElement!.querySelector('.ex-radar')) return;
    const links = RADAR_LINKS.map((r) => `<button type="button" class="ex-radar" data-radar="${r.id}" title="${r.title}">${RADAR_ICON}${r.label}</button>`);
    (hook.parentElement!.querySelector('.cd') ?? hook).insertAdjacentHTML('afterend',
      `<div class="ex-radars" role="group" aria-labelledby="ex-radars-h"><p id="ex-radars-h">${RADAR_HEAD}</p>${links.join('')}</div>`);
  };
  registry.subscribe(aboutRadar);
  aboutRadar();
  $('drawer').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-radar]');
    if (b) void openRadar(b.dataset.radar!);
  });
  const askedRadar = params.get('radar');
  if (askedRadar && !document.getElementById('no-webgl') && RADAR_LINKS.some((r) => r.id === askedRadar)) void openRadar(askedRadar);

  // Light or dark (src/theme.ts): the button flips it; the map's colours are then redrawn from the new palette.
  const themeBtn = $('theme-btn');
  themeBtn.addEventListener('click', toggleMode);
  onTheme(() => {
    themeBtn.setAttribute('aria-pressed', String(isDark()));
    document.documentElement.style.setProperty('--bg', theme.bg);
    map.recolor();
    showMark();
    registry.refresh(); // legend, ribbon and About panel hold colours too
    updateProbe();
    // An open radar replay baked its colours into its picture: open it again.
    if (radar) {
      const id = radar.id;
      const old = radar;
      radar = null;
      radarBack = old.before;
      old.close(false);
      void openRadar(id);
    }
  });
  themeBtn.setAttribute('aria-pressed', String(isDark()));

  refresh();
  // For the test scripts: the app's clock, layers and map, and the Atlas (loaded on first ask).
  (window as unknown as { __hatch: unknown }).__hatch = {
    time, registry, luna, map, padding, current: () => cur,
    atlas: () => (__BASEMAP__ ? import('./atlas/atlas').then((m) => m.loadAtlas()) : Promise.resolve(null)),
  };

  // This year's nightly forecast, fetched after the first paint (none in the one-file build, or if the file is missing
  // or broken). It goes at the top of the season menu (each species finds its own part), and becomes the default during its season
  // (1 Mar - 30 Sep) when the link names no season, day or species, so shared links still open what they showed.
  // Fetched only when live mode is wanted: a link asks for it, the live season is on now (its in-season default), or
  // the reader reaches for the season menu (hover, focus, touch), so an off-season first visit never downloads it.
  const cursor0 = time.cursor;
  let liveStarted = false;
  const startLive = () => {
    if (liveStarted) return;
    liveStarted = true;
    void loadLive().then(onLive).finally(() => liveFirst && openIntro()); // in season the opening lands on live's today
  };
  const onLive = (live: Live | null) => {
    livePending = false;
    // A placeholder file (written before the pipeline's first real run) only shows when a link asks for it.
    if (!live || (live.stub && asked !== LIVE)) return syncUrl();
    setLive(live);
    liveFile = live;
    fillPicker();
    if (cur !== luna || speciesPending) return syncUrl(); // the default switch is luna's first view only
    if (picker.value !== initialMode || time.cursor !== cursor0) return syncUrl(); // the user got there first: leave their choice
    const explicit = params.has('season') || params.has('year') || params.has('date') || params.has('species');
    if (asked !== LIVE && (explicit || !inSeason(live, clock))) return syncUrl();
    picker.value = LIVE;
    switchMode(LIVE, md ? [month, day] : undefined);
    syncUrl();
  };
  const liveFirst = asked === LIVE || inSeason({ season: new Date(clock).getUTCFullYear() }, clock);
  if (liveFirst) startLive();
  else if (liveAvailable()) {
    for (const ev of ['pointerenter', 'pointerdown', 'focus', 'keydown'] as const) picker.addEventListener(ev, startLive, { once: true });
  }
  if (!liveFirst) openIntro();
}

start();

// Offline + install to home screen: only the deployed build has a dist/sw.js, and only https (not file://, artifacts).
if (__HATCH_SW__ && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
