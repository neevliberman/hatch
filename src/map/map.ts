import { Deck, MapView, WebMercatorViewport } from '@deck.gl/core';
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
  /** Re-fit the Midwest into the free area between header and bottom bar (and beside an open side panel). */
  fit(padding: Padding): void;
  /** Whether a pan or zoom has left the fitted view (a re-fit on resize would throw that away). */
  moved(): boolean;
  /** Centre lngLat in the free area at a zoom level (the city menu, My area and shared links). */
  focus(lngLat: [number, number], zoom: number, padding: Padding): void;
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
  /** Jump to lngLat at a zoom level (used by the zoomed-in smoke test, scripts/fine.mjs). */
  view(lngLat: [number, number], zoom: number): void;
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
}

export function createMap({ container, registry, time, onProbe, padding, onMove, onView, covers }: Opts): MapHandle {
  // deck.gl 9 needs WebGL2. Without it (GPU blocklisted, hardware acceleration off) say so, instead of an empty map.
  const gl = document.createElement('canvas').getContext('webgl2');
  gl?.getExtension('WEBGL_lose_context')?.loseContext(); // only a test: give the context back
  if (!gl) {
    // Beside the map, not in it: the map's role="img" would hide the message from screen readers.
    container.removeAttribute('role');
    container.removeAttribute('aria-describedby');
    container.insertAdjacentHTML('afterend', `<p id="no-webgl" role="status">This map needs a graphics feature (WebGL) that isn't working in this
      browser. Try another browser, or turn on hardware acceleration in this one's settings.</p>`);
    return { refresh() {}, fit() {}, moved: () => false, focus() {}, center: () => null, fitZoom: () => 4, setMarker() {}, setPicked() {}, project: () => null, zoom: () => null, view() {} };
  }
  const size = () => ({ width: container.clientWidth || 800, height: container.clientHeight || 600 });
  const fitState = (p: Padding) => {
    const { width, height } = size();
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
      zoom = viewState.zoom;
      // Only the view, not deck's whole viewState: that carries a stale width/height that would skew center().
      current = { longitude: viewState.longitude, latitude: viewState.latitude, zoom: viewState.zoom };
      // Half a zoom step, or the centre shifting by ~a tenth of the screen, counts as having moved.
      const scale = 360 / (512 * 2 ** fitted.zoom) * size().width;
      setMoved(Math.abs(viewState.zoom - fitted.zoom) > 0.5 ||
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
    onClick: (info: PickingInfo) => onProbe(hit(info), true),
    // Place names follow the drawn view (they skip the work when neither the view nor the dots changed).
    onAfterRender: () =>
      labels.update(deck.isInitialized ? (deck.getViewports()[0] as WebMercatorViewport) : undefined, padding(),
        registry.activeLayers().map((l) => l.points?.(time.cursor) ?? []), covers?.() ?? []),
  });

  const labels = createLabels(container);
  loadBasemap(initial.zoom, () => {
    labels.setLabels(basemapLabels());
    refresh();
  });

  let marker: [number, number] | null = null;
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
    const dataLayers: Layer[] = registry.activeLayers().flatMap((l) => l.render({ t: time.cursor, zoom, theme }));
    // Lakes, rivers and roads go over the hexagons but under the sighting dots.
    const hexes = dataLayers.filter((l) => isHexes(l.id));
    const rest = dataLayers.filter((l) => !isHexes(l.id));
    deck.setProps({ layers: [...under, ...hexes, ...mid, ...rest, ...over, ...pickedLayers(), ...markerLayers()] });
  };

  const handle: MapHandle = {
    refresh,
    fit(p) {
      const v = fitState(p);
      zoom = v.zoom;
      fitted = v;
      setMoved(false);
      nudge = nudge ? 0 : 1e-9;
      current = v;
      deck.setProps({ initialViewState: { ...v, zoom: v.zoom + nudge, transitionDuration: 0 } });
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
    focus(lngLat, z, p) {
      const v = focusState(lngLat, Math.min(fitted.maxZoom, Math.max(fitted.minZoom, z)), p);
      handle.view([v.longitude, v.latitude], v.zoom);
    },
    view([longitude, latitude], z) {
      z = Math.min(fitted.maxZoom, Math.max(fitted.minZoom, z));
      zoom = z;
      setMoved(true);
      nudge = nudge ? 0 : 1e-9;
      current = { longitude, latitude, zoom: z };
      deck.setProps({ initialViewState: { ...fitted, longitude, latitude, zoom: z + nudge, transitionDuration: 0 } });
      refresh();
      if (onView) requestAnimationFrame(onView);
    },
    setMarker(lngLat) {
      marker = lngLat;
      refresh();
    },
    setPicked(cell) {
      if (cell === picked) return;
      picked = cell;
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
