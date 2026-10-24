import './style.css';
import { LayerRegistry } from './core/registry';
import { TimeAxis, type TimeSpec } from './core/timeAxis';
import { createLunaLayer, modeLabel, replayTimeSpec, setLive, type LunaLayer } from './layers/lunaReplay';
import { GROUP_AFTER, SPECIES } from './species';
import { data, LIVE, TYPICAL, type Mode } from './layers/lunaData';
import { inSeason, loadLive, type Live } from './layers/liveData';
import { createMap, type Padding, type ProbeHit } from './map/map';
import { basemapLabels, theme } from './map/basemap';
import { mountScrubber } from './ui/scrubber';
import { mountCaveatDrawer } from './ui/caveatDrawer';
import { mountLayerList, mountLegend, showProbe } from './ui/panels';
import { mountFinder } from './ui/finder';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { AIM, WORD, stepCell, type Arrow } from './ui/keyexplore';
import { GRID_RES } from './core/grid';
import { isForecast } from './core/layer';
import { MIDWEST_MARGIN } from './layers/stages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN_KEY = 'hatch.seen.v2';

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
  registry.register(luna, replayTimeSpec(initialMode, month, day));
  // The species on screen. Only one is active at a time; each other species loads the first time it is picked.
  let cur: LunaLayer = luna;
  let curKey = 'luna';
  /** A ?species= link's species, until it has loaded (the address bar keeps asking for it meanwhile). */
  let speciesPending: string | null = null;
  const loaded = new Map<string, LunaLayer>([['luna', luna]]);

  const time = new TimeAxis(registry.activeTime()!);
  let spec: TimeSpec | null = registry.activeTime();
  // Playback slows to 8 days/s while the active layer says its season is in full swing and runs 18 days/s otherwise.
  // Reduced motion keeps one steady speed.
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  time.pace = (t) => (still.matches ? 14 : registry.activeLayers().some((l) => l.busy?.(t)) ? 8 : 18);

  let hit: ProbeHit | null = null;
  let pinned = false;
  let resetKeys = () => {}; // set once the keyboard explorer is built; a species or season switch starts it afresh
  let lastPin: [number, number] | null = null; // the last pinned spot, by any means: where the keyboard explorer starts
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
    const y = Math.max(8, Math.min(px[1] - h / 2, window.innerHeight - h - 8));
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

  const colourKey = mountLegend($('legend'), registry);
  time.subscribe(() => time.playing && colourKey.autoFold());

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
      const l = document.getElementById('loader');
      l?.classList.add('done');
      setTimeout(() => l?.remove(), 250);
    },
    onView: () => {
      if (pinned) placeProbe();
      placeNote();
      syncUrl(); // a shared link reopens the same place and zoom
    },
    onProbe: (h, clicked) => {
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
  // This year's live forecast (luna only), once its file has loaded.
  let liveFile: Live | null = null;
  // A ?season=live link opens on the default view until the file arrives: keep "season=live" in the address bar meanwhile.
  let livePending = asked === LIVE;
  const fillPicker = () => {
    const what = cur.words.plural;
    const keep = picker.value || initialMode;
    const live = liveFile && cur === luna ? [LIVE] : [];
    picker.innerHTML = [...live, TYPICAL, ...[...years].reverse()]
      // The count is the species' own (cur.words.countedAs, e.g. first-wave moths); "All years" goes without it so the closed menu fits a small phone.
      .map((m) => `<option value="${m}">${m === LIVE ? modeLabel(LIVE) : m === TYPICAL ? 'All years' : `${m} (${cur.seasonCount(m).toLocaleString()} ${what})`}</option>`)
      .join('');
    picker.value = keep === LIVE && !live.length ? TYPICAL : keep;
    picker.title = `Season to replay (${cur.words.countedAs} seen, in parentheses; ${cur.seasonCount(TYPICAL).toLocaleString()} in all years)`;
  };
  fillPicker();
  // This season, live: "next real season ... days from now" would contradict the map.
  const syncCountdown = () => ($('countdown').hidden = picker.value === LIVE && !!liveFile && inSeason(liveFile, clock));
  // Live mode opens on its last day of observed weather (or the day a link asks for); the others keep the calendar day.
  const switchMode = (m: Mode, at?: [number, number]) => {
    const now = new Date(time.cursor);
    cur.setMode(m);
    hit = null;
    pinned = false;
    resetKeys();
    map.setMarker(null);
    $('season-name').textContent = modeLabel(m);
    at ??= m === LIVE ? undefined : [now.getUTCMonth(), now.getUTCDate()];
    registry.setTime(cur.id, replayTimeSpec(m, at?.[0], at?.[1], clock));
    updateProbe(); // a card pinned in the old season describes that season: it went with the switch
    syncCountdown();
  };
  picker.addEventListener('change', () => switchMode(picker.value));
  $('season-name').textContent = modeLabel(initialMode);

  // Species menu, from the one species list (src/species.ts): a native menu stays small in the header however long the
  // list gets, and a phone opens it as its own scrolling picker. Past GROUP_AFTER species it gets group headings.
  // Switching keeps the season and the calendar day, and drops any pinned card.
  const speciesSel = $<HTMLSelectElement>('species');
  const opt = (e: (typeof SPECIES)[number]) => `<option value="${e.key}">${e.label}</option>`;
  const groups = [...new Set(SPECIES.map((e) => e.group))];
  speciesSel.innerHTML = SPECIES.length > GROUP_AFTER
    ? groups.map((g) => `<optgroup label="${g}">${SPECIES.filter((e) => e.group === g).map(opt).join('')}</optgroup>`).join('')
    : SPECIES.map(opt).join('');
  let asking = 0; // the latest pick: a slow load that finishes after a newer pick must not switch to its species
  const setSpecies = async (want: string) => {
    const entry = SPECIES.find((e) => e.key === want) ?? SPECIES[0]!;
    const ticket = ++asking;
    if (!loaded.has(entry.key)) {
      if (!entry.load) return;
      speciesSel.disabled = true;
      const mode0 = picker.value === LIVE ? TYPICAL : picker.value;
      const layer = await entry.load(mode0, () => onLunaData());
      speciesSel.disabled = false;
      if (!layer) {
        if (ticket === asking) speciesSel.value = curKey;
        return say(`Couldn\u2019t load the ${entry.label.toLowerCase()} map. Try again later.`);
      }
      loaded.set(entry.key, layer);
      registry.register(layer, replayTimeSpec(mode0, 5, 10), false);
    }
    if (ticket !== asking) return;
    const next = loaded.get(entry.key)!;
    speciesSel.value = entry.key;
    if (next === cur) return;
    // Only luna has a live season: switching to another species from live mode goes to all years, on the same day.
    if (next !== luna && picker.value === LIVE) {
      picker.value = TYPICAL;
      $('season-name').textContent = modeLabel(TYPICAL);
    }
    const now = new Date(time.cursor);
    hit = null;
    pinned = false;
    resetKeys();
    map.setMarker(null);
    next.setMode(picker.value);
    const prev = cur;
    cur = next;
    curKey = entry.key;
    fillPicker();
    $('tagline').textContent = cur.words.tagline;
    ($('mark') as HTMLImageElement).src = cur.words.mark;
    showMark();
    $('dots-what').textContent = cur.words.plural;
    showCountdown();
    syncCountdown();
    $('map').setAttribute('aria-label', `Map of the Midwest: ${cur.words.sightingsOf} sightings over hexagons colored by the forecast`);
    registry.setTime(cur.id, replayTimeSpec(picker.value, now.getUTCMonth(), now.getUTCDate()));
    // Old one off first, so the two never draw together for a frame.
    registry.setActive(prev.id, false);
    registry.setActive(cur.id, true);
    syncUrl();
  };
  // The one-file preview has no species files next to it, so it offers luna only.
  if (!__BASEMAP__) speciesSel.closest('label')!.hidden = true;
  // On narrow phones the closed menu shows just the species' sketch mark (style.css), so it stays one small square.
  const showMark = () => speciesSel.style.setProperty('--mark', `url("${cur.words.mark}")`);
  showMark();
  speciesSel.addEventListener('change', () => void setSpecies(speciesSel.value));
  // ?species=<key> opens on that species (?species=firefly links from before the list still work).
  const askedSpecies = params.get('species');
  if (askedSpecies && askedSpecies !== 'luna' && SPECIES.some((e) => e.key === askedSpecies && e.load)) {
    speciesPending = askedSpecies;
    void setSpecies(askedSpecies).finally(() => (speciesPending = null));
  }

  const setRibbon = mountScrubber($('bar'), time, () => registry.activeLayers().find((l) => l.endNote)?.endNote, showEnd);
  // The slider's track pictures the active species' season; a season or species change redraws it.
  // The registry can fire several times in one change (layer off, layer on): draw the ribbon once per frame.
  let ribbonFrame = 0;
  const drawRibbon = () =>
    (ribbonFrame ||= requestAnimationFrame(() => {
      ribbonFrame = 0;
      setRibbon(registry.activeLayers().find((l) => l.profile)?.profile?.());
    }));
  registry.subscribe(drawRibbon);
  setRibbon(registry.activeLayers().find((l) => l.profile)?.profile?.());
  mountLayerList($('layers'), registry);
  const toggleDrawer = mountCaveatDrawer($('info-btn'), $('drawer'), registry);
  followSpot = (t) => toggleDrawer.setSpot(pinned && hit ? hit.lngLat : null, t, pinned ? hit?.label : undefined);
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
    // The place and zoom, once the view has left the whole-Midwest fit (a link from the default view stays short).
    const c = map.center(padding());
    if (map.moved() && c) q.set('at', `${c.lngLat[1].toFixed(3)},${c.lngLat[0].toFixed(3)},${c.zoom.toFixed(1)}`);
    else q.delete('at');
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
      history.replaceState(null, '', viewUrl());
    }, 400);
  };
  time.subscribe(syncUrl);
  // A reload (the map's Redraw) or leaving must not drop the last move still waiting on the timer.
  addEventListener('pagehide', () => { clearTimeout(urlTimer); urlTimer = 0; history.replaceState(null, '', viewUrl()); });
  picker.addEventListener('change', syncUrl);

  const msg = $('action-msg');
  let msgTimer = 0;
  const say = (text: string) => {
    msg.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => (msg.textContent = ''), 6000);
  };

  $('share').addEventListener('click', async () => {
    const url = new URL(viewUrl(), location.href).href;
    try {
      if (navigator.share) await navigator.share({ title: `Hatch: when ${cur.words.shareName} come out`, url });
      else {
        await navigator.clipboard.writeText(url);
        say('Link copied');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say('Couldn\u2019t share. Copy the link from the address bar.');
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
  let keyCell = ''; // the hexagon the keys last selected: pinned any other way, the walk starts afresh from there
  let steps = 0;
  let nudge = false; // alternates a trailing space, so a repeated message is announced again
  resetKeys = () => ((keyCell = ''), (steps = 0));
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
    keyCell = cell;
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
  const pin = () => {
    if (pinned) return say('Already pinned. Arrow keys move it, Escape lets go.');
    const c = startCell();
    if (!c) return say('No forecast in view');
    steps = 0;
    col = cellToLatLng(c)[1];
    selectCell(c);
  };
  const arrow = (a: Arrow) => {
    const from = pinned && hit ? cur.cellAt(hit.lngLat) : null;
    if (!from) return pin();
    if (from !== keyCell) (col = cellToLatLng(from)[1]), (steps = 0); // pinned by mouse or tap since: start afresh there
    const next = stepCell(from, a, col, (c) => hasForecast(cellToLatLng(c).reverse() as [number, number]));
    if (!next) return say(`No forecast to the ${WORD[a]}${(nudge = !nudge) ? '\u00a0' : ''}`);
    if (a === 'ArrowLeft' || a === 'ArrowRight') col = cellToLatLng(next)[1]; // a new column; up and down keep theirs
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
  // The About panel's city menu: a way to read a place's season without pointing at the map.
  $('drawer').addEventListener('change', (e) => {
    const sel = (e.target as Element).closest<HTMLSelectElement>('select[data-place]');
    if (!sel?.value) return;
    const [lat, lng] = sel.value.split(',').map(Number) as [number, number];
    const name = sel.selectedOptions[0]?.text ?? '';
    sel.value = ''; // so picking the same city again (after the pin moved) still fires
    // On a phone, drop the sheet to its middle stop first, so the place lands in the map above it.
    if (phone.matches && !slim.matches) toggleDrawer(true);
    if (!showPlace(lat, lng, name)) return say(`No forecast for ${name}`);
  });

  // Find a town: the same path as the city menu above.
  mountFinder($('find'), $('finder'), (lat, lng, name) => {
    if (!showPlace(lat, lng, name)) say(`No forecast for ${name}`);
  }, say);

  // "My area": one location fix (never stored or sent anywhere), then the forecast card for that hex, pinned.
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return say('Location is not available in this browser');
    const btn = $<HTMLButtonElement>('locate');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    const done = () => {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    };
    say('Finding you…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        done();
        const at = showPlace(coords.latitude, coords.longitude, 'you');
        if (!at) {
          map.setMarker(null);
          say('You are outside the 7 states Hatch covers so far (IL, IN, IA, MI, MN, OH, WI)');
          return;
        }
        map.setMarker([coords.longitude, coords.latitude]);
        // The marker is the accent brown; the pale yellow dots are moths.
        say(at === 'exact' ? 'You are the brown dot' : 'You are the brown dot (the card shows the nearest hexagon on land)');
      },
      (err) => (
        done(),
        say(
          err.code === err.PERMISSION_DENIED
            ? 'Location is off for this site. Pick a city in About (i) instead.'
            : 'Could not get your location. Pick a city in About (i) instead.',
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
  time.subscribe(() => time.playing && clearHint());

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
    if (now !== drawerState) (drawerState = now), refit(true, 0);
  }).observe($('drawer'), { attributes: true, attributeFilter: ['class'] });

  // Close a pinned card: its × button, Escape, or (with a mouse) the pointer leaving the map for a panel.
  // The × goes away with the card, so hand keyboard focus to the time slider rather than drop it on the page.
  probeEl.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('.probe-close')) return;
    unpin();
    $('t-range').focus({ preventScroll: true });
  });
  // Capture phase, so this sees the About panel before its own Escape handler closes it: one Escape, one thing closed.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !pinned || $('drawer').classList.contains('open') || !$('finder').hidden) return;
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
  refresh();
  (window as unknown as { __hatch: unknown }).__hatch = { time, registry, luna, map, padding, current: () => cur };

  // This year's nightly forecast, fetched after the first paint (none in the one-file build, or if the file is missing
  // or broken). It goes at the top of the season menu (luna only), and becomes the default during its season
  // (1 Mar - 30 Sep) when the link names no season, day or species, so shared links still open what they showed.
  const cursor0 = time.cursor;
  void loadLive().then((live) => {
    livePending = false;
    // A placeholder file (written before the pipeline's first real run) only shows when a link asks for it.
    if (!live || (live.stub && asked !== LIVE)) return syncUrl();
    setLive(live);
    liveFile = live;
    fillPicker();
    if (cur !== luna || speciesPending) return syncUrl(); // only luna has a live season
    if (picker.value !== initialMode || time.cursor !== cursor0) return syncUrl(); // the user got there first: leave their choice
    const explicit = params.has('season') || params.has('year') || params.has('date') || params.has('species');
    if (asked !== LIVE && (explicit || !inSeason(live, clock))) return syncUrl();
    picker.value = LIVE;
    switchMode(LIVE, md ? [month, day] : undefined);
    syncUrl();
  });
}

start();

// Offline + install to home screen: only the deployed build has a dist/sw.js, and only https (not file://, artifacts).
if (__HATCH_SW__ && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
