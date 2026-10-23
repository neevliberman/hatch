import './style.css';
import { LayerRegistry } from './core/registry';
import { TimeAxis, type TimeSpec } from './core/timeAxis';
import { createLunaLayer, modeLabel, replayTimeSpec, type LunaLayer } from './layers/lunaReplay';
import { createFireflyLayer, loadFirefly } from './layers/fireflyReplay';
import type { ReplayFile } from './layers/lunaData';
import { data, firstBroodCount, TYPICAL, type Mode } from './layers/lunaData';
import { createMap, type Padding, type ProbeHit } from './map/map';
import { theme } from './map/basemap';
import { mountScrubber } from './ui/scrubber';
import { mountCaveatDrawer } from './ui/caveatDrawer';
import { mountLayerList, mountLegend, showProbe } from './ui/panels';
import { countdownParts } from './ui/countdown';
import { mountFinder } from './ui/finder';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { GRID_RES } from './core/grid';
import { isForecast } from './core/layer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN_KEY = 'hatch.seen.v2';

function start() {
  const params = new URLSearchParams(location.search);
  const years = data.years.map(String);
  // Default: every year pooled by day of year (one season alone is too sparse to show the wave). ?year=2025 replays one season.
  const asked = params.get('year');
  const initialMode: Mode = asked && years.includes(asked) ? asked : TYPICAL;
  // ?date=06-10 (or 2025-06-10) puts the cursor on that calendar day; default 10 June, when the wave crosses the middle.
  const md = params.get('date')?.match(/(\d{2})-(\d{2})$/);
  const [month, day] = md ? [Number(md[1]) - 1, Number(md[2])] : [5, 10];
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
  // The species on screen. Only one is active at a time; the firefly loads the first time it is picked.
  let cur: LunaLayer = luna;
  let speciesPending = false;
  let firefly: LunaLayer | null = null;
  let seasonCount = firstBroodCount;

  const time = new TimeAxis(registry.activeTime()!);
  let spec: TimeSpec | null = registry.activeTime();
  // Playback slows to 8 days/s while the wave is on (any hex starting or at peak) and runs 18 days/s otherwise.
  // Reduced motion keeps one steady speed.
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  time.pace = (t) => (still.matches ? 14 : luna.busy?.(t) ? 8 : 18);

  let hit: ProbeHit | null = null;
  let pinned = false;
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
  const updateProbe = () => {
    // The pinned or hovered hexagon is the one on screen now: after a zoom changes the level, use that level's cell.
    if (hit && (!hit.picked || isForecast(hit.picked.layerId))) hit.cell = cur.cellAt(hit.lngLat) ?? hit.cell;
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
    const right = open && (!phone.matches || slim.matches) ? drawer.offsetWidth : phone.matches ? $('actions').offsetWidth + 8 : 0;
    return { top: Math.max(0, top * k), bottom: Math.max(0, bottom * k), right: Math.min(right, window.innerWidth / 2) };
  };
  const map = createMap({
    container: $<HTMLDivElement>('map'),
    registry,
    time,
    padding,
    covers: () => [...document.querySelectorAll('#top > *, #legend, #probe, #recenter, #actions > *')],
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
  const refresh = () => {
    map.refresh();
    updateProbe();
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
  const fillPicker = () => {
    const what = cur === luna ? 'moths' : 'fireflies';
    const keep = picker.value || initialMode;
    picker.innerHTML = [TYPICAL, ...[...years].reverse()]
      // The count is first-wave moths (or fireflies) seen; "All years" goes without it so the closed menu fits a small phone.
      .map((m) => `<option value="${m}">${m === TYPICAL ? 'All years' : `${m} (${seasonCount(m).toLocaleString()} ${what})`}</option>`)
      .join('');
    picker.value = keep;
    picker.title = `Season to replay (${cur === luna ? 'first-wave moths' : 'fireflies'} seen, in parentheses; ${seasonCount(TYPICAL).toLocaleString()} in all years)`;
  };
  fillPicker();
  picker.addEventListener('change', () => {
    const now = new Date(time.cursor);
    cur.setMode(picker.value);
    hit = null;
    pinned = false;
    map.setMarker(null);
    $('season-name').textContent = modeLabel(picker.value);
    registry.setTime(cur.id, replayTimeSpec(picker.value, now.getUTCMonth(), now.getUTCDate()));
  });
  $('season-name').textContent = modeLabel(initialMode);

  // Species switcher. Switching keeps the season and the calendar day, and drops any pinned card.
  const speciesSel = $<HTMLSelectElement>('species');
  const setSpecies = async (want: 'luna' | 'firefly') => {
    if (want === 'firefly' && !firefly) {
      speciesSel.disabled = true;
      const file = await loadFirefly();
      speciesSel.disabled = false;
      if (!file) {
        speciesSel.value = 'luna';
        return say('Couldn\u2019t load the fireflies. Try again later.');
      }
      fireflyFile = file;
      const ff = createFireflyLayer(file, picker.value, () => onLunaData());
      firefly = ff;
      registry.register(ff, replayTimeSpec(picker.value, 5, 10), false);
      fireflyCount = ff.seasonCount;
    }
    const next = want === 'firefly' ? firefly! : luna;
    speciesSel.value = want;
    if (next === cur) return;
    const now = new Date(time.cursor);
    hit = null;
    pinned = false;
    map.setMarker(null);
    next.setMode(picker.value);
    cur = next;
    seasonCount = cur === luna ? firstBroodCount : fireflyCount;
    fillPicker();
    $('tagline').textContent = cur === luna ? 'when luna moths fly' : 'when fireflies glow';
    $('dots-what').textContent = cur === luna ? 'moths' : 'fireflies';
    showCountdown();
    $('map').setAttribute('aria-label', `Map of the Midwest: ${cur === luna ? 'luna moth' : 'firefly'} sightings over hexagons colored by the forecast`);
    registry.setTime(cur.id, replayTimeSpec(picker.value, now.getUTCMonth(), now.getUTCDate()));
    // Old one off first, so the two never draw together for a frame.
    registry.setActive((cur === luna ? firefly : luna)!.id, false);
    registry.setActive(cur.id, true);
    syncUrl();
  };
  let fireflyCount = firstBroodCount;
  let fireflyFile: ReplayFile | null = null;
  // The one-file preview has no firefly file next to it, so it offers luna only.
  if (!__BASEMAP__) speciesSel.closest('label')!.hidden = true;
  // On narrow phones both header menus can't show full names, so each species is listed by its first word ("Luna", "Monarch").
  const narrow = matchMedia('(max-width: 430px)');
  const shortNames = () => {
    for (const o of speciesSel.options) o.text = narrow.matches ? (o.dataset.full ??= o.text).split(' ')[0]! : (o.dataset.full ?? o.text);
  };
  shortNames();
  narrow.addEventListener('change', shortNames);
  speciesSel.addEventListener('change', () => void setSpecies(speciesSel.value === 'firefly' ? 'firefly' : 'luna'));
  // Until a ?species=firefly link has loaded, the address bar keeps asking for the firefly.
  if (params.get('species') === 'firefly' && __BASEMAP__) {
    speciesPending = true;
    void setSpecies('firefly').finally(() => (speciesPending = false));
  }

  const setRibbon = mountScrubber($('bar'), time);
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
    if (cur === luna && !speciesPending) q.delete('species');
    else q.set('species', 'firefly');
    if (picker.value === TYPICAL) q.delete('year');
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
      if (navigator.share) await navigator.share({ title: `Hatch: when ${cur === luna ? 'luna moths' : 'fireflies'} come out`, url });
      else {
        await navigator.clipboard.writeText(url);
        say('Link copied');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say('Couldn\u2019t share. Copy the link from the address bar.');
    }
  });

  // Pin the card (and the About panel's spot) on the hexagon at lat/lng, named `label`, and bring the map to it.
  // Lakeshore cities (Chicago, Milwaukee, Cleveland) can sit in a hex whose centre is in the lake, so fall back to
  // the nearest land hex within two rings.
  const showPlace = (lat: number, lng: number, label: string): 'exact' | 'nearby' | null => {
    const ring = gridDisk(latLngToCell(lat, lng, GRID_RES), 2)
      .map((c) => {
        const [la, ln] = cellToLatLng(c);
        return { cell: c, lngLat: [ln, la] as [number, number], d: (la - lat) ** 2 + (ln - lng) ** 2 };
      })
      .sort((a, b) => a.d - b.d);
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

  // ?today=2027-01-15 fakes the clock, to check the off-season countdown.
  const today = params.get('today');
  // Each species has its own season: the firefly's starts weeks after the luna moth's.
  function showCountdown() {
    const now = today && !Number.isNaN(Date.parse(today)) ? Date.parse(today) : Date.now();
    const [short, more] = cur === luna ? countdownParts(now) : countdownParts(now, 'firefly', fireflyFile!);
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
      glide = false;
      placeProbe();
    }, wait);
  };
  const ro = new ResizeObserver(() => refit());
  for (const id of ['map', 'top', 'bottom']) ro.observe($(id));
  // The key folding to its chip (or opening) frees or takes room. Not while a card is up, though: a card hides the
  // key, and the tap that pinned it also folds it, and the map must not slide out from under that card.
  let keySeen = false; // the observer's first call is just it starting up
  new ResizeObserver(() => (keySeen ? hit || refit(true) : (keySeen = true))).observe($('legend'));
  window.addEventListener('resize', () => refit());
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
}

start();

// Offline + install to home screen: only the deployed build has a dist/sw.js, and only https (not file://, artifacts).
if (__HATCH_SW__ && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
