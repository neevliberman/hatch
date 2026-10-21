import { Deck, MapView, WebMercatorViewport } from '@deck.gl/core';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { MIDWEST_BOUNDS } from '../core/grid';
import type { LayerRegistry } from '../core/registry';
import type { TimeAxis } from '../core/timeAxis';
import { basemapLayers, theme } from './basemap';
import { GRID_RES } from '../core/grid';

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
  onProbe: (cell: string | null, pinned: boolean) => void;
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

  const deck = new Deck({
    parent: container,
    views: new MapView({ repeat: false }),
    initialViewState: fitState(padding()),
    // No rotate/tilt: this is a flat data map. Keyboard off so arrow keys drive the time scrubber.
    controller: { dragRotate: false, touchRotate: false, keyboard: false, doubleClickZoom: true },
    getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    layers: [],
    onHover: (info: PickingInfo) => onProbe(info.object ? hexId(info) : null, false),
    onClick: (info: PickingInfo) => onProbe(info.object ? hexId(info) : null, true),
  });

  const refresh = () => {
    const zoom = (deck.getViewports()[0]?.zoom as number | undefined) ?? 4;
    const { under, over } = basemapLayers();
    const dataLayers: Layer[] = registry
      .activeLayers()
      .flatMap((l) => l.render({ t: time.cursor, res: GRID_RES, zoom, theme }));
    deck.setProps({ layers: [...under, ...dataLayers, ...over] });
  };

  return {
    refresh,
    fit(p) {
      deck.setProps({ initialViewState: { ...fitState(p), transitionDuration: 0 } });
    },
  };
}

function hexId(info: PickingInfo): string | null {
  const o = info.object as { id?: string } | undefined;
  return o?.id ?? null;
}
