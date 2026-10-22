import { Deck, MapView, WebMercatorViewport } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { latLngToCell } from 'h3-js';
import { GRID_RES, MIDWEST_BOUNDS } from '../core/grid';
import type { LayerRegistry } from '../core/registry';
import type { TimeAxis } from '../core/timeAxis';
import { basemapLayers, theme } from './basemap';

export interface ProbeHit {
  cell: string;
  lngLat: [number, number];
  picked?: { layerId: string; object: unknown };
  /** Screen position of the pointer, when the hit came from the pointer (not from "My area"). */
  px?: [number, number];
}

export interface MapHandle {
  /** Re-render layers (call when time or layer set changes). */
  refresh(): void;
  /** Re-fit the Midwest into the free area between header and bottom bar. */
  fit(padding: { top: number; bottom: number }): void;
  /** Show a "you are here" ring at lngLat (null hides it). */
  setMarker(lngLat: [number, number] | null): void;
  /** Screen position of lngLat in the current view, and the current zoom (null before the first frame). */
  project(lngLat: [number, number]): [number, number] | null;
  zoom(): number | null;
}

interface Opts {
  container: HTMLDivElement;
  registry: LayerRegistry;
  time: TimeAxis;
  /** cell = H3 id under the pointer (null if none); lngLat is where; picked = the data object hit; clicked distinguishes tap from hover. */
  onProbe: (hit: ProbeHit | null, clicked: boolean) => void;
  padding: () => { top: number; bottom: number };
  /** Called when the view leaves (true) or comes back to (false) the fitted whole-Midwest view. */
  onMove?: (moved: boolean) => void;
  /** Called after any pan or zoom has been drawn. */
  onView?: () => void;
}

export function createMap({ container, registry, time, onProbe, padding, onMove, onView }: Opts): MapHandle {
  // deck.gl 9 needs WebGL2. Without it (GPU blocklisted, hardware acceleration off) say so, instead of an empty map.
  if (!document.createElement('canvas').getContext('webgl2')) {
    container.insertAdjacentHTML('beforeend', `<p id="no-webgl" role="alert">This map needs WebGL, which this browser has
      turned off. Try another browser, or turn on hardware acceleration in this one's settings.</p>`);
    return { refresh() {}, fit() {}, setMarker() {}, project: () => null, zoom: () => null };
  }
  const size = () => ({ width: container.clientWidth || 800, height: container.clientHeight || 600 });
  const fitState = (p: { top: number; bottom: number }) => {
    const { width, height } = size();
    const vp = new WebMercatorViewport({ width, height }).fitBounds(MIDWEST_BOUNDS, {
      padding: { top: p.top, bottom: p.bottom, left: 12, right: 12 },
    });
    return { longitude: vp.longitude, latitude: vp.latitude, zoom: vp.zoom, minZoom: 3, maxZoom: 11 };
  };

  // deck.gl 9 creates its view manager asynchronously, so deck.getViewports() is NOT safe right after
  // `new Deck()` (it asserts). Zoom is tracked from onViewStateChange instead.
  const initial = fitState(padding());
  let zoom = initial.zoom;
  // The fitted view, to tell when a pan or zoom has left it (that's when the recenter button shows).
  let fitted = initial;
  let moved = false;
  // deck.gl only re-applies initialViewState when it differs from the last one, so a recenter that lands on the
  // same fit would be ignored; a vanishing zoom nudge that alternates makes each fit a new value.
  let nudge = 0;
  let overSighting = false;
  const setMoved = (m: boolean) => {
    if (m !== moved) onMove?.((moved = m));
  };

  const hit = (info: PickingInfo): ProbeHit | null => {
    if (!info.object || !info.coordinate) return null;
    const [lng, lat] = info.coordinate as [number, number];
    return {
      cell: latLngToCell(lat, lng, GRID_RES),
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
      // Half a zoom step, or the centre shifting by ~a tenth of the screen, counts as having moved.
      const scale = 360 / (512 * 2 ** fitted.zoom) * size().width;
      setMoved(Math.abs(viewState.zoom - fitted.zoom) > 0.5 ||
        Math.abs(viewState.longitude - fitted.longitude) > scale * 0.1 || Math.abs(viewState.latitude - fitted.latitude) > scale * 0.08);
      if (onView) requestAnimationFrame(onView); // after deck has drawn the new view
    },
    onHover: (info: PickingInfo) => {
      overSighting = !!info.object && info.layer?.id !== 'luna-forecast';
      onProbe(hit(info), false);
    },
    // The canvas gets a Tab stop for deck's keyboard controls, which are off: drop it, so Tab goes straight to the controls.
    onLoad: (): void => deck.getCanvas()?.setAttribute('tabindex', '-1'),
    onClick: (info: PickingInfo) => onProbe(hit(info), true),
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
            getFillColor: [245, 215, 110, 255],
            getLineColor: [11, 15, 23, 255],
            getLineWidth: 3,
            lineWidthUnits: 'pixels',
          }),
        ]
      : [];

  const refresh = () => {
    const { under, over } = basemapLayers();
    const dataLayers: Layer[] = registry.activeLayers().flatMap((l) => l.render({ t: time.cursor, zoom, theme }));
    deck.setProps({ layers: [...under, ...dataLayers, ...over, ...markerLayers()] });
  };

  return {
    refresh,
    fit(p) {
      const v = fitState(p);
      zoom = v.zoom;
      fitted = v;
      setMoved(false);
      nudge = nudge ? 0 : 1e-9;
      deck.setProps({ initialViewState: { ...v, zoom: v.zoom + nudge, transitionDuration: 0 } });
      if (onView) requestAnimationFrame(onView);
    },
    setMarker(lngLat) {
      marker = lngLat;
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
}
