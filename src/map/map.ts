import { Deck, FlyToInterpolator, LinearInterpolator, MapView, WebMercatorViewport } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { latLngToCell } from 'h3-js';
import { GRID_RES, MIDWEST_BOUNDS } from '../core/grid';
import { isForecast, isHexes } from '../core/layer';
import type { LayerRegistry } from '../core/registry';
import type { TimeAxis } from '../core/timeAxis';
import { basemapLabels, basemapLayers, loadBasemap, theme } from './basemap';
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
}

export interface MapHandle {
  /** Re-render layers (call when time or layer set changes). */
  refresh(): void;
  /** Re-fit the Midwest into the free area between header and bottom bar (and beside an open side panel). `glide`
   * eases there in about a third of a second instead of cutting. */
  fit(padding: Padding, glide?: boolean): void;
  /** Whether a pan or zoom has left the fitted view (a re-fit on resize would throw that away). */
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
  /** Width an open side panel takes on the right (desktop About drawer). */
  right?: number;
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
    return { refresh() {}, fit() {}, moved: () => false, focus() {}, center: () => null, fitZoom: () => 4, setMarker() {}, setPicked() {}, project: () => null, zoom: () => null, view() {} };
  }
  const size = () => ({ width: container.clientWidth || 800, height: container.clientHeight || 600 });
  // The size the last fit was worked out for. Before layout (an in-app browser still sliding in) the map can be 0 x 0,
  // and a fit for the 800 x 600 guess above comes out zoomed in.
  let fitFor = '';
  const fitState = (p: Padding) => {
    const { width, height } = size();
    fitFor = `${container.clientWidth}x${container.clientHeight}`;
    let vp = new WebMercatorViewport({ width, height }).fitBounds(MIDWEST_BOUNDS, {
      padding: { top: p.top, bottom: p.bottom, left: 12, right: 12 + (p.right ?? 0) },
    });
    // On a tall phone the width limits the fit, which would centre the Midwest and leave a gap above it. Pin its
    // north edge under the header instead: the spare room goes to the bottom, where the hex card docks.
    const gap = vp.project([MIDWEST_BOUNDS[0][0], MIDWEST_BOUNDS[1][1]])[1]! - p.top;
    if (gap > 1) {
      const [longitude, latitude] = vp.unproject([width / 2, height / 2 + gap]);
      vp = new WebMercatorViewport({ width, height, longitude, latitude, zoom: vp.zoom });
    }
    // Zoom stops half a step out from the whole Midwest (not a speck in empty sea) and in at about town scale, where a
    // finest hexagon (about 6 km) is still a few dozen pixels, rather than one blank hexagon filling the screen.
    return { longitude: vp.longitude, latitude: vp.latitude, zoom: vp.zoom, minZoom: Math.max(2, vp.zoom - 0.5), maxZoom: 9.5 };
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
    grabbed = false;
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
        return;
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
    // Touch taps are handled below; deck's own click for a touch arrives late, on the next touch.
    onClick: (info: PickingInfo, e) => {
      if ((e?.srcEvent as PointerEvent | undefined)?.pointerType !== 'touch') onProbe(hit(info), true);
    },
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
  // A tap on a touch screen pins its card. deck holds each tap back to rule out a double tap and only lets it go on
  // the next touch (carrying that touch's spot), so a tap never pinned anything. A short, still, one-finger touch is
  // a tap: pick under it here. Double-tap zoom still works, and pins the spot first.
  let touchDown: { x: number; y: number; t: number } | null = null;
  container.addEventListener('pointerdown', (e) => {
    touchDown = e.pointerType === 'touch' && e.isPrimary ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  });
  container.addEventListener('pointerup', (e) => {
    const d = touchDown;
    touchDown = null;
    // 1 s, not the usual 0.5: a busy phone can stamp the lift late, and a press that long still didn't move.
    if (!d || e.pointerType !== 'touch' || e.timeStamp - d.t > 1000 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    const r = container.getBoundingClientRect();
    const info = deck.pickObject({ x: e.clientX - r.left, y: e.clientY - r.top });
    onProbe(info ? hit(info) : null, true);
  });
  container.addEventListener('pointercancel', () => (touchDown = null));
  // Capture phase: deck's own handler (on the canvas inside) stops the glide first, and must find this already set.
  for (const type of ['pointerdown', 'wheel']) container.addEventListener(type, () => (grabbed = true), { capture: true, passive: true });
  // A phone can take the graphics context back to save memory, which leaves only plain water. Say so, with a way back
  // (the link in the address bar keeps the place, zoom and day).
  container.addEventListener('webglcontextlost', () => {
    if (document.getElementById('map-lost')) return;
    container.insertAdjacentHTML('afterend', `<p id="map-lost" role="status">The browser paused the map to save memory.
      <button type="button">Redraw</button></p>`);
    document.querySelector('#map-lost button')!.addEventListener('click', () => location.reload());
  }, true);
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

  const refresh = () => {
    const { under, mid, over } = basemapLayers(zoom);
    // `playing` is whether playback glides: a slow device's playback draws plain day steps (see TimeAxis.gliding).
    const dataLayers: Layer[] = registry.activeLayers().flatMap((l) => l.render({ t: time.cursor, zoom, theme, wash, playing: time.gliding, frac: time.frac }));
    // Lakes, rivers and roads go over the hexagons but under the sighting dots.
    const hexes = dataLayers.filter((l) => isHexes(l.id));
    const rest = dataLayers.filter((l) => !isHexes(l.id));
    deck.setProps({ layers: [...under, ...hexes, ...mid, ...rest, ...over, ...pickedBuilt, ...markerBuilt] });
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
