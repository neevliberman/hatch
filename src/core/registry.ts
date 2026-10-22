import type { HatchLayer } from './layer';
import type { TimeSpec } from './timeAxis';

type Listener = () => void;

/** Holds the known layers, their preferred time range, and which are switched on. */
export class LayerRegistry {
  private layers = new Map<string, { layer: HatchLayer; time: TimeSpec }>();
  private active = new Set<string>();
  private listeners = new Set<Listener>();

  register(layer: HatchLayer, time: TimeSpec, activate = true): void {
    if (this.layers.has(layer.id)) throw new Error(`Layer already registered: ${layer.id}`);
    this.layers.set(layer.id, { layer, time });
    if (activate) this.active.add(layer.id);
    this.emit();
  }

  all(): HatchLayer[] {
    return [...this.layers.values()].map((e) => e.layer);
  }

  activeLayers(): HatchLayer[] {
    return this.all().filter((l) => this.active.has(l.id));
  }

  /** The scrubber follows the first active layer's time spec. */
  activeTime(): TimeSpec | null {
    for (const [id, e] of this.layers) if (this.active.has(id)) return e.time;
    return null;
  }

  /** Change a layer's preferred time range (e.g. the replay switched year). */
  setTime(id: string, time: TimeSpec): void {
    const e = this.layers.get(id);
    if (!e) return;
    e.time = time;
    this.emit();
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  setActive(id: string, on: boolean): void {
    if (!this.layers.has(id)) return;
    if (on) this.active.add(id);
    else this.active.delete(id);
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}
