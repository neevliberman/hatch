import { Deck, MapView, WebMercatorViewport } from '@deck.gl/core';
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
}

export interface MapHandle {
  /** Re-render layers (call when time or layer set changes). */
  refresh(): void;
  /** Re-fit the Midwest into the free area between header and bottom bar. */
  fit(padding: { top: number; bottom: number }): void;
}

interface Opts {
  container: HTMLDivElement;
  registry: LayerRegistry;
  time: TimeAxis;
  /** cell = H3 id under the pointer (null if none); lngLat is where; picked = the data object hit; clicked distinguishes tap from hover. */
  onProbe: (hit: ProbeHit | null, clicked: boolean) => void;
  padding: () => { top: number; bottom: number };
}

export function createMap({ container, registry, time, onProbe, padding }: Opts): MapHandle {
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

  const hit = (info: PickingInfo): ProbeHit | null => {
    if (!info.object || !info.coordinate) return null;
    const [lng, lat] = info.coordinate as [number, number];
    return {
      cell: latLngToCell(lat, lng, GRID_RES),
      lngLat: [lng, lat],
      picked: info.layer ? { layerId: info.layer.id, object: info.object } : undefined,
    };
  };

  const deck = new Deck({
    parent: container,
    views: new MapView({ repeat: false }),
    // Retina is plenty; 3x phones would triple the fill cost for no visible gain.
    useDevicePixels: Math.min(window.devicePixelRatio || 1, 2),
    initialViewState: initial,
    // No rotate/tilt: flat data map. Keyboard off so arrow keys drive the time scrubber.
    controller: { dragRotate: false, touchRotate: false, keyboard: false, doubleClickZoom: true },
    getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    layers: [],
    onViewStateChange: ({ viewState }) => {
      zoom = viewState.zoom;
    },
    onHover: (info: PickingInfo) => onProbe(hit(info), false),
    onClick: (info: PickingInfo) => onProbe(hit(info), true),
  });

  const refresh = () => {
    const { under, over } = basemapLayers();
    const dataLayers: Layer[] = registry.activeLayers().flatMap((l) => l.render({ t: time.cursor, zoom, theme }));
    deck.setProps({ layers: [...under, ...dataLayers, ...over] });
  };

  return {
    refresh,
    fit(p) {
      const v = fitState(p);
      zoom = v.zoom;
      deck.setProps({ initialViewState: { ...v, transitionDuration: 0 } });
    },
  };
}
