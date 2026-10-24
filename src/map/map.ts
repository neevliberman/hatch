import { Deck, FlyToInterpolator, LinearInterpolator, MapView, WebMercatorViewport } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { latLngToCell } from 'h3-js';
import { GRID_RES, MIDWEST_BOUNDS } from '../core/grid';
import { isForecast, isHexes } from '../core/layer';
import type { LayerRegistry } from '../core/registry';
import type { TimeAxis } from '../core/timeAxis';
import { basemapLabels, basemapLayers, loadBasemap, padsFor, theme } from './basemap';
import { createLabels } from './labels';
import { palette } from '../theme';

export interface ProbeHit {
  cell: string;
  lngLat: [number, number];
  picked?: { layerId: string; object: unknown };
  /** Screen position of the pointer, when the hit came from the pointer (not from "My area"). */
  px?: [number, number];
  /** A name for the place, when it came from the city menu or My area ("Madison, WI", "you"). */
  label?: string;
  /** A line of words for where a keyboard walk has got to ("Step 3 north, near Madison"). */
  note?: string;
}

export interface MapHandle {
  /** Re-render layers (call when time or layer set changes). */
  refresh(): void;
  /** Re-fit the Midwest into the free area between header and bottom bar (and beside an open side panel). `glide`
   * eases there in about a third of a second instead of cutting. */
  fit(padding: Padding, glide?: boolean): void;
  /** Whether a pan or zoom has left the fitted view (a re-fit on resize would throw that away). */
  /** After a resize that keeps the reader's view: the zoom-out limit follows the new whole-Midwest fit. */
  rebound(padding: Padding): void;
  moved(): boolean;
  /** Centre lngLat in the free area at a zoom level (the city menu, My area and shared links). `fly` flies there. */
  focus(lngLat: [number, number], zoom: number, padding: Padding, fly?: boolean): void;
  /** The middle of the free area (between the panels) and the zoom, for links; null before the first frame. */
  center(padding: Padding): { lngLat: [number, number]; zoom: number } | null;
  /** The zoom that fits the whole Midwest. */
  fitZoom(): number;
  /** Show a "you are here" ring at lngLat (null hides it). */
  setMarker(lngLat: [number, number] | null): void;
  /** Outline the hexagon whose card is pinned (null clears it). */
  setPicked(cell: string | null): void;
  /** Screen position of lngLat in the current view, and the current zoom (null before the first frame). */
  project(lngLat: [number, number]): [number, number] | null;
  zoom(): number | null;
  /** Jump (or, given `ms`, fly) to lngLat at a zoom level (also used by the zoomed-in smoke test, scripts/fine.mjs). */
  view(lngLat: [number, number], zoom: number, ms?: number): void;
}

export interface Padding {
  top: number;
  bottom: number;
  /** Width an open side panel takes on the right (desktop About drawer), or the phone's button stack. */
  right?: number;
  /** For the phone's button stack: the height (from the top of the map) where it starts. Above it, the right edge is free. */
  rightFrom?: number;
  /** On a phone, the bottom room for the time bar and the key even while the key is folded: where the card docks. */
  dock?: number;
}

interface Opts {
  container: HTMLDivElement;
  registry: LayerRegistry;
  time: TimeAxis;
  /** cell = H3 id under the pointer (null if none); lngLat is where; picked = the data object hit; clicked distinguishes tap from hover. */
  onProbe: (hit: ProbeHit | null, clicked: boolean) => void;
  padding: () => Padding;
  /** Called when the view leaves (true) or comes back to (false) the fitted whole-Midwest view. */
  onMove?: (moved: boolean) => void;
  /** Called after any pan or zoom has been drawn. */
  onView?: () => void;
  /** Panels that float over the map, which place names keep clear of. */
  covers?: () => Element[];
  /** Called once, when the map has drawn its first frame. */
  onFirstDraw?: () => void;
}

export function createMap({ container, registry, time, onProbe, padding, onMove, onView, covers, onFirstDraw }: Opts): MapHandle {
  // deck.gl 9 needs WebGL2. Without it (GPU blocklisted, hardware acceleration off) say so, instead of an empty map.
  const gl = document.createElement('canvas').getContext('webgl2');
  gl?.getExtension('WEBGL_lose_context')?.loseContext(); // only a test: give the context back
  if (!gl) {
    // Beside the map, not in it: the map's role="img" would hide the message from screen readers.
    container.removeAttribute('role');
    container.removeAttribute('aria-describedby');
    container.insertAdjacentHTML('afterend', `<p id="no-webgl" role="status">This map needs a graphics feature (WebGL) that isn't working in this
      browser. Try another browser, or turn on hardware acceleration in this one's settings.</p>`);
    onFirstDraw?.();
    return { refresh() {}, fit() {}, rebound() {}, moved: () => false, focus() {}, center: () => null, fitZoom: () => 4, setMarker() {}, setPicked() {}, project: () => null, zoom: () => null, view() {} };
  }
  const size = () => ({ width: container.clientWidth || 800, height: container.clientHeight || 600 });
  // The size the last fit was worked out for. Before layout (an in-app browser still sliding in) the map can be 0 x 0,
  // and a fit for the 800 x 600 guess above comes out zoomed in.
  let fitFor = '';
  const fitState = (p: Padding) => {
    const { width, height } = size();
    fitFor = `${container.clientWidth}x${container.clientHeight}`;
    // Panels can be taller than the map while the page is still laying out (or on a very short screen): shrink the
    // padding so at least 40 px are left to fit into, or fitBounds throws.
    const v = Math.min(1, Math.max(0, height - 40) / Math.max(1, p.top + p.bottom));
    const right = 12 + (p.right ?? 0);
    const h = Math.min(1, Math.max(0, width - 40) / (12 + right));
    const fit = (r: number) => new WebMercatorViewport({ width, height }).fitBounds(MIDWEST_BOUNDS, {
      padding: { top: p.top * v, bottom: p.bottom * v, left: 12 * h, right: r * h },
    });
    let vp = fit(right);
    // fitBounds centres the Midwest in the free area; on a tall phone the width limits the fit, leaving `gap` spare
    // above it and below it. ys: where its north and south edges land.
    const ys = (w: WebMercatorViewport): [number, number] => [w.project([MIDWEST_BOUNDS[0][0], MIDWEST_BOUNDS[1][1]])[1]!, w.project(MIDWEST_BOUNDS[0])[1]!];
    let gap = ys(vp)[0] - p.top * v;
    // The button stack on a phone's right edge starts low down (rightFrom). When the whole Midwest fits above it, pinned
    // under the header, use the full width instead: a bigger map, and the stack sits in the room left below it.
    let clear = Infinity; // how far the Midwest may reach down
    if (gap > 1 && p.rightFrom !== undefined && right > 12) {
      const wide = fit(12);
      const [n, s] = ys(wide);
      if (s - n <= p.rightFrom - 12 - p.top * v) {
        vp = wide;
        gap = n - p.top * v;
        clear = p.rightFrom - 12;
      }
    }
    // Centred, short of the stack: the spare height is shared above and below, rather than one empty band under the
    // map. Centred between the header and the dock (where the key and a docked card sit, which stays put whether the
    // key is folded or a card is up, so a tap never moves the map). Moving the map up by `up` px.
    if (gap > 1) {
      const [n, s] = ys(vp);
      const dock = height - Math.max(p.bottom, p.dock ?? 0) * v;
      let to = p.top * v + Math.max(0, (dock - p.top * v - (s - n)) / 2); // where the north edge goes
      to -= Math.max(0, to + (s - n) - clear);
      const up = n - Math.max(p.top * v, to);
      const [longitude, latitude] = vp.unproject([width / 2, height / 2 + up]);
      vp = new WebMercatorViewport({ width, height, longitude, latitude, zoom: vp.zoom });
    }
    // Zoom stops at the whole Midwest (zooming further out only shrinks it into a speck in empty sea) and in at about
    // town scale, where a finest hexagon (about 6 km) is still a few dozen pixels, rather than one blank hexagon.
    return { longitude: vp.longitude, latitude: vp.latitude, zoom: vp.zoom, minZoom: Math.max(2, vp.zoom), maxZoom: 9.5 };
  };
  // A centre that puts lngLat in the middle of the free area (between the panels), not the middle of the screen.
  const focusState = (lngLat: [number, number], z: number, p: Padding) => {
    const { width, height } = size();
    const vp = new WebMercatorViewport({ width, height, longitude: lngLat[0], latitude: lngLat[1], zoom: z });
    const [longitude, latitude] = vp.unproject([width / 2 + (p.right ?? 0) / 2, height / 2 + (p.bottom - p.top) / 2]);
    return { longitude: longitude!, latitude: latitude!, zoom: z };
  };

  // deck.gl 9 creates its view manager asynchronously, so deck.getViewports() is NOT safe right after
  // `new Deck()` (it asserts). Zoom is tracked from onViewStateChange instead.
  const initial = fitState(padding());
  let zoom = initial.zoom;
  // The fitted view, to tell when a pan or zoom has left it (that's when the recenter button shows).
  let fitted = initial;
  let moved = false;
  let current: { longitude: number; latitude: number; zoom: number } = initial;
  // deck.gl only re-applies initialViewState when it differs from the last one, so a recenter that lands on the
  // same fit would be ignored; a vanishing zoom nudge that alternates makes each fit a new value.
  let nudge = 0;
  let overSighting = false;
  let redrawQueued = false;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  // While the camera glides, the frames in between say nothing about whether the reader moved the map.
  // Each glide gets a number: a glide that starts before the last one ends must not have its flag cleared by it.
  let gliding = 0;
  let glides = 0;
  // Where the glide is headed, and whether the reader has grabbed the map since it set off. A resize mid-glide (a phone
  // keyboard closing after Find a town) makes deck stop the glide where it is; it should land where it was going.
  let target: { longitude: number; latitude: number; zoom: number } | null = null;
  let grabbed = false;
  let down = 0; // pointers on the map right now: a glide that starts under a finger is already grabbed
  const land = (v: { longitude: number; latitude: number; zoom: number }) => {
    nudge = nudge ? 0 : 1e-9;
    current = { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom };
    zoom = v.zoom;
    deck.setProps({ initialViewState: { ...fitted, ...current, zoom: v.zoom + nudge, transitionDuration: 0 } });
    refresh();
  };
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2);
  const glide = (ms: number, to: { longitude: number; latitude: number; zoom: number }, fly = false) => {
    const id = ++glides;
    const end = () => void (gliding === id && ((gliding = 0), (target = null)));
    // Cut short by anything but the reader (a new glide has a new number, so it never lands here): land anyway.
    const cut = () => {
      if (gliding !== id) return;
      const to = target;
      end();
      if (to && !grabbed) land(to);
    };
    gliding = ms && !still.matches ? id : 0;
    target = gliding ? to : null;
    grabbed = down > 0;
    return gliding
      ? {
          transitionDuration: ms,
          transitionInterpolator: fly ? new FlyToInterpolator() : new LinearInterpolator(),
          ...(fly ? {} : { transitionEasing: ease }),
          onTransitionEnd: end,
          onTransitionInterrupt: cut,
        }
      : { transitionDuration: 0 };
  };
  // The first frame: the forecast washes in from south to north, like watercolour soaking into paper. Milliseconds
  // since the first draw, handed to the layers; undefined once done (and from the start, for reduced motion).
  let wash: number | undefined = still.matches ? undefined : 0;
  let drawn = false;
  // The map stays hidden until a frame is drawn at its real size, fitted for that size: otherwise a phone can flash a
  // blurry, zoomed-in first frame (drawn for a guessed size, then stretched) before the re-fit. Two seconds at most.
  const readyToShow = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const vp = deck.isInitialized ? deck.getViewports()[0] : undefined;
    if (!w || !h || !vp || Math.abs(vp.width - w) > 1 || Math.abs(vp.height - h) > 1) return false; // deck redraws on resize
    if (!moved && fitFor !== `${w}x${h}`) {
      handle.fit(padding());
      return false;
    }
    return true;
  };
  setTimeout(() => drawn || firstDraw(), 2000);
  const firstDraw = () => {
    drawn = true;
    container.classList.add('drawn');
    onFirstDraw?.();
    if (wash === undefined) return;
    const t0 = performance.now();
    const step = () => {
      const e = performance.now() - t0;
      wash = e < 900 ? e : undefined;
      refresh();
      if (wash !== undefined) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const setMoved = (m: boolean) => {
    if (m !== moved) onMove?.((moved = m));
  };

  const hit = (info: PickingInfo): ProbeHit | null => {
    if (!info.object || !info.coordinate) return null;
    const [lng, lat] = info.coordinate as [number, number];
    // A forecast hexagon is its own cell (res 4, 5 or 6 by zoom); anything else is placed on the res-4 grid.
    const id = (info.object as { id?: unknown }).id;
    return {
      cell: isForecast(info.layer?.id) && typeof id === 'string' ? id : latLngToCell(lat, lng, GRID_RES),
      lngLat: [lng, lat],
      picked: info.layer ? { layerId: info.layer.id, object: info.object } : undefined,
      px: [info.x, info.y],
    };
  };

  const deck: Deck<MapView> = new Deck({
    parent: container,
    views: new MapView({ repeat: false }),
    // Retina is plenty; 3x phones would triple the fill cost for no visible gain.
    useDevicePixels: Math.min(window.devicePixelRatio || 1, 2),
    initialViewState: initial,
    // No rotate/tilt: flat data map. Keyboard off so arrow keys drive the time scrubber.
    controller: { dragRotate: false, touchRotate: false, keyboard: false, doubleClickZoom: true },
    // Pointer only over sightings (they open an iNaturalist photo); a hex just shows its card, so it keeps the arrow.
    getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? (overSighting ? 'pointer' : 'default') : 'grab'),
    layers: [],
    onViewStateChange: ({ viewState }) => {
      // Never draw a view that is not a number (the whole map would vanish, leaving plain water): go back to a real one.
      if (![viewState.longitude, viewState.latitude, viewState.zoom].every(Number.isFinite)) {
        const back = target ?? current;
        gliding = 0;
        target = null;
        requestAnimationFrame(() => land(back));
        return { ...viewState, ...back }; // deck draws what this returns
      }
      zoom = viewState.zoom;
      // Only the view, not deck's whole viewState: that carries a stale width/height that would skew center().
      current = { longitude: viewState.longitude, latitude: viewState.latitude, zoom: viewState.zoom };
      // Half a zoom step, or the centre shifting by ~a tenth of the screen, counts as having moved.
      const scale = 360 / (512 * 2 ** fitted.zoom) * size().width;
      if (!gliding) setMoved(Math.abs(viewState.zoom - fitted.zoom) > 0.5 ||
        Math.abs(viewState.longitude - fitted.longitude) > scale * 0.1 || Math.abs(viewState.latitude - fitted.latitude) > scale * 0.08);
      if (onView) requestAnimationFrame(onView); // after deck has drawn the new view
      // Layers can depend on zoom (finer hexagons when zoomed in): redraw once per frame while the view moves.
      if (!redrawQueued) {
        redrawQueued = true;
        requestAnimationFrame(() => {
          redrawQueued = false;
          refresh();
        });
      }
    },
    onHover: (info: PickingInfo) => {
      overSighting = !!info.object && !isForecast(info.layer?.id);
      onProbe(hit(info), false);
    },
    // The canvas gets a Tab stop for deck's keyboard controls, which are off: drop it, so Tab goes straight to the controls.
    onLoad: (): void => deck.getCanvas()?.setAttribute('tabindex', '-1'),
    // Place names follow the drawn view (they skip the work when neither the view nor the dots changed).
    onAfterRender: () => {
      if (!drawn && !readyToShow()) return;
      if (!drawn) firstDraw();
      const vp = deck.isInitialized ? (deck.getViewports()[0] as WebMercatorViewport) : undefined;
      placeRings(vp); // the drawn view, so the rings ride along with glides and resizes
      labels?.update(vp, padding(),
        registry.activeLayers().map((l) => l.points?.(time.cursor) ?? []), covers?.() ?? []);
    },
  });

  // While paused, today's newest dots breathe: a paper ring over each swells and settles by about half a pixel every
  // 2.4 s. CSS draws it (src/style.css, .breath), so the map itself never redraws for it. It rests after 15 s without
  // input and during playback; the browser stops it in a hidden tab; reduced motion never shows it.
  // A tap or click pins its card, picked here rather than through deck's onClick. deck holds each tap back to rule out
  // a double tap and only lets it go on the next touch (carrying that touch's spot), so a tap never pinned anything;
  // and it drops a click whose press and lift land more than 250 ms apart, which a busy main thread (a big screen
  // drawing slowly) stamps on an ordinary click. A short, still press of one finger or the main button is a tap.
  // Double-tap and double-click zoom still work: the first press toggles the pin, the rest of a double click don't.
  let touchDown: { x: number; y: number; t: number } | null = null;
  let lastClick = { x: 0, y: 0, t: -Infinity };
  container.addEventListener('pointerdown', (e) => {
    const ok = e.isPrimary && (e.pointerType === 'touch' || (e.button === 0 && !e.ctrlKey)); // ctrl-click: Mac menu
    touchDown = ok ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  });
  // Mouse 5 px, finger or pen 10. A press that wandered further is a pan, even if it comes back.
  const slop = (e: PointerEvent) => (e.pointerType === 'mouse' ? 5 : 10);
  container.addEventListener('pointermove', (e) => {
    if (touchDown && e.isPrimary && Math.hypot(e.clientX - touchDown.x, e.clientY - touchDown.y) > slop(e)) touchDown = null;
  });
  container.addEventListener('pointerup', (e) => {
    const d = touchDown;
    touchDown = null;
    // 1 s, not the usual 0.5: a busy device can stamp the lift late, and a press that long still didn't move.
    if (!d || e.timeStamp - d.t > 1000 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop(e)) return;
    if (e.pointerType !== 'touch') {
      // Pressed within 300 ms and 10 px of the last lift: the 2nd (or 3rd...) click of a double click, which zooms.
      const again = d.t - lastClick.t < 300 && Math.hypot(d.x - lastClick.x, d.y - lastClick.y) < 10;
      lastClick = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (again) return;
    }
    const r = container.getBoundingClientRect();
    const info = deck.pickObject({ x: e.clientX - r.left, y: e.clientY - r.top });
    onProbe(info ? hit(info) : null, true);
  });
  container.addEventListener('pointercancel', () => (touchDown = null));
  // Capture phase: deck's own handler (on the canvas inside) stops the glide first, and must find this already set.
  for (const type of ['pointerdown', 'wheel']) container.addEventListener(type, () => (grabbed = true), { capture: true, passive: true });
  container.addEventListener('pointerdown', () => down++, { capture: true });
  for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => (down = Math.max(0, down - 1)), { capture: true });
  // A phone can take the graphics context back to save memory, which leaves only plain water. Ask for it back
  // (preventDefault is what lets the browser offer a restore), then redraw by reloading: the link in the address bar
  // keeps the place, zoom and day (main.ts writes it on pagehide). Automatic reloads are capped at one a minute and
  // three a visit, so a phone short on memory can't loop; past that, or while the tab is hidden, a Redraw button waits.
  let lost = false;
  const stamp = (): [number, number] => {
    try { const [n, t] = (sessionStorage.getItem('hatch-redraw') ?? '0:0').split(':').map(Number); return [n || 0, t || 0]; }
    catch { return [3, 0]; } // no storage, no count: don't reload on our own
  };
  const mayReload = () => { const [n, t] = stamp(); return n < 3 && Date.now() - t > 60_000; };
  const recover = () => {
    if (!lost || document.visibilityState !== 'visible' || !mayReload()) return;
    try { sessionStorage.setItem('hatch-redraw', `${stamp()[0] + 1}:${Date.now()}`); } catch { return; }
    location.reload();
  };
  const onLost = () => {
    if (lost) return;
    lost = true;
    const auto = document.visibilityState === 'visible' && mayReload();
    container.insertAdjacentHTML('afterend', auto ? '<p id="map-lost" role="alert">Redrawing the map…</p>'
      : '<p id="map-lost" role="alert">The browser paused the map to save memory. <button type="button">Redraw</button></p>');
    const button = document.querySelector<HTMLButtonElement>('#map-lost button');
    button?.addEventListener('click', () => location.reload());
    button?.focus();
    // Lost while in view usually means no restore is coming: give the browser a moment, then try once.
    if (auto) setTimeout(recover, 1500);
  };
  container.addEventListener('webglcontextlost', (e) => { e.preventDefault(); onLost(); }, true);
  container.addEventListener('webglcontextrestored', recover, true);
  document.addEventListener('visibilitychange', recover);
  // Back from the back/forward cache with a dead context, no lost event fires.
  addEventListener('pageshow', (e) => {
    if (e.persisted && container.querySelector('canvas')?.getContext('webgl2')?.isContextLost()) { onLost(); recover(); }
  });
  const rings = document.createElement('div');
  rings.className = 'breath';
  rings.setAttribute('aria-hidden', 'true');
  container.append(rings);
  let restTimer = 0;
  const wake = () => {
    rings.classList.remove('rest');
    clearTimeout(restTimer);
    restTimer = window.setTimeout(() => rings.classList.add('rest'), 15000);
  };
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) addEventListener(type, wake, { passive: true });
  time.subscribe(wake);
  wake();
  const placeRings = (vp?: WebMercatorViewport) => {
    const pts = !vp || time.playing ? [] : registry.activeLayers().flatMap((l) => l.newest?.(time.cursor) ?? []);
    while (rings.children.length > pts.length) rings.lastChild!.remove();
    while (rings.children.length < pts.length) rings.append(document.createElement('i'));
    pts.forEach((s, i) => {
      const [x, y] = vp!.project([s.lng, s.lat]);
      (rings.children[i] as HTMLElement).style.translate = `${x!.toFixed(1)}px ${y!.toFixed(1)}px`; // before the CSS scale
    });
  };

  // The one-file build has no basemap files beside it (see basemap.ts), so it leaves the names code out entirely.
  const labels = __BASEMAP__ ? createLabels(container) : null;
  if (labels)
    loadBasemap(initial.zoom, () => {
      labels.setLabels(basemapLabels());
      refresh();
    });

  // The marker and the pinned outline are built when they change, not on every frame (fresh data would re-upload).
  let marker: [number, number] | null = null;
  let markerBuilt: Layer[] = [];
  const markerLayers = (): Layer[] =>
    marker
      ? [
          new ScatterplotLayer<[number, number]>({
            id: 'you-are-here',
            data: [marker],
            getPosition: (d) => d,
            getRadius: 7,
            radiusUnits: 'pixels',
            stroked: true,
            filled: true,
            getFillColor: palette.marker,
            getLineColor: palette.dotRim,
            getLineWidth: 3,
            lineWidthUnits: 'pixels',
          }),
        ]
      : [];

  let picked: string | null = null;
  let pickedBuilt: Layer[] = [];
  const pickedLayers = (): Layer[] =>
    picked
      ? [
          new H3HexagonLayer<string>({
            id: 'picked-hex',
            data: [picked],
            getHexagon: (d) => d,
            filled: false,
            stroked: true,
            extruded: false,
            getLineColor: palette.pick,
            lineWidthUnits: 'pixels',
            getLineWidth: 3,
          }),
        ]
      : [];

  // Shore hexagons (see padsFor): each forecast or stripes layer gets a copy under it, over the hexagons just past the
  // shores and state lines, in a forecast neighbour's colour; the basemap's mask over them trims them to the edge.
  // Not pickable: a tap past the shore is not a forecast. Built once per level's data, so playback reuses them.
  const padCache = new WeakMap<object, { id: string; src: unknown }[]>();
  // (The one-file build has no basemap, so no mask to trim them: it leaves this out.)
  const padLayers = (hexes: Layer[]): Layer[] => !__BASEMAP__ ? [] :
    hexes.flatMap((l) => {
      const res = /-r(\d)/.exec(l.id)?.[1];
      const pairs = res ? padsFor(+res) : null;
      const data = l.props.data as { id: string }[] | undefined;
      if (!pairs || !Array.isArray(data)) return [];
      let pads = padCache.get(data);
      if (!pads) {
        const byId = new Map(data.map((d) => [d.id, d]));
        pads = pairs.flatMap(([id, src]) => (byId.has(src) ? [{ id, src: byId.get(src) }] : []));
        padCache.set(data, pads);
      }
      // Accessors read the neighbour; constants pass through.
      const via = (f: unknown) => (typeof f === 'function' ? (p: { src: unknown }, i: unknown) => f(p.src, i) : f);
      const { getFillColor, getLineColor } = l.props as { getFillColor?: unknown; getLineColor?: unknown };
      return [l.clone({ id: `${l.id}-pad`, data: pads, getFillColor: via(getFillColor), getLineColor: via(getLineColor),
        pickable: false, autoHighlight: false } as never)];
    });

  const refresh = () => {
    const { under, mid } = basemapLayers(zoom);
    // `playing` is whether playback glides: a slow device's playback draws plain day steps (see TimeAxis.gliding).
    const dataLayers: Layer[] = registry.activeLayers().flatMap((l) => l.render({ t: time.cursor, zoom, theme, wash, playing: time.gliding, frac: time.frac }));
    // Lakes, rivers, roads and state lines go over the hexagons (and their shore copies) but under the sighting dots.
    const hexes = dataLayers.filter((l) => isHexes(l.id));
    const rest = dataLayers.filter((l) => !isHexes(l.id));
    deck.setProps({ layers: [...under, ...padLayers(hexes), ...hexes, ...mid, ...rest, ...pickedBuilt, ...markerBuilt] });
  };

  const handle: MapHandle = {
    refresh,
    fit(p, smooth) {
      const v = fitState(p);
      zoom = v.zoom;
      fitted = v;
      setMoved(false);
      nudge = nudge ? 0 : 1e-9;
      current = v;
      const g = glide(smooth ? 320 : 0, v);
      deck.setProps({ initialViewState: { ...v, zoom: v.zoom + nudge, ...g } });
      refresh(); // the hexagon size follows zoom: zooming back out must swap the small hexagons for big ones
      if (onView) requestAnimationFrame(onView);
    },
    rebound(p) {
      const was = fitted.minZoom;
      fitted = fitState(p);
      if (Math.abs(fitted.minZoom - was) < 1e-6) return;
      const v = target ?? current; // mid-glide: land where it was going
      land({ ...v, zoom: Math.max(fitted.minZoom, v.zoom) });
    },
    moved: () => moved,
    fitZoom: () => fitted.zoom,
    // The middle of the free area, not of the screen: focus() puts it back there, whatever the other screen's panels.
    center(p) {
      const { width, height } = size();
      const vp = new WebMercatorViewport({ width, height, ...current });
      const [lng, lat] = vp.unproject([(width - (p.right ?? 0)) / 2, p.top + (height - p.top - p.bottom) / 2]);
      return { lngLat: [lng!, lat!], zoom: current.zoom };
    },
    focus(lngLat, z, p, fly) {
      const v = focusState(lngLat, Math.min(fitted.maxZoom, Math.max(fitted.minZoom, z)), p);
      // Longer for a longer trip: half a second next door, under a second across the Midwest.
      const px = Math.hypot(v.longitude - current.longitude, v.latitude - current.latitude) * (512 * 2 ** current.zoom) / 360;
      handle.view([v.longitude, v.latitude], v.zoom, fly ? Math.min(900, Math.max(500, 400 + Math.abs(v.zoom - current.zoom) * 90 + px / 3)) : 0);
    },
    view([longitude, latitude], z, ms = 0) {
      z = Math.min(fitted.maxZoom, Math.max(fitted.minZoom, z));
      zoom = z;
      setMoved(true);
      nudge = nudge ? 0 : 1e-9;
      current = { longitude, latitude, zoom: z };
      const g = glide(ms, current, true);
      deck.setProps({ initialViewState: { ...fitted, longitude, latitude, zoom: z + nudge, ...g } });
      refresh();
      if (onView) requestAnimationFrame(onView);
    },
    setMarker(lngLat) {
      if (!lngLat && !marker) return;
      marker = lngLat;
      markerBuilt = markerLayers();
      refresh();
    },
    setPicked(cell) {
      if (cell === picked) return;
      picked = cell;
      pickedBuilt = pickedLayers();
      refresh();
    },
    project(lngLat) {
      const vp = deck.isInitialized ? deck.getViewports()[0] : undefined;
      const p = vp?.project(lngLat);
      return p ? [p[0]!, p[1]!] : null;
    },
    zoom() {
      const vp = deck.isInitialized ? deck.getViewports()[0] : undefined;
      return vp ? vp.zoom : null;
    },
  };
  return handle;
}
