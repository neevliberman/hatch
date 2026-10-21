import type { EmergenceLayer } from './layer';

type Listener = () => void;

/** Holds the known layers and which are switched on. UI and renderer both listen to it. */
export class LayerRegistry {
  private layers = new Map<string, EmergenceLayer>();
  private active = new Set<string>();
  private listeners = new Set<Listener>();

  register(layer: EmergenceLayer, activate = true): void {
    if (this.layers.has(layer.id)) throw new Error(`Layer already registered: ${layer.id}`);
    this.layers.set(layer.id, layer);
    if (activate) this.active.add(layer.id);
    this.emit();
  }

  all(): EmergenceLayer[] {
    return [...this.layers.values()];
  }

  activeLayers(): EmergenceLayer[] {
    return this.all().filter((l) => this.active.has(l.id));
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
