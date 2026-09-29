import { EventEmitter } from 'events';

type EventHandler = (...args: any[]) => void;

/**
 * Vue 3 no longer exposes component instances as an event bus. This small
 * adapter keeps the existing `$on`/`$once`/`$off`/`$emit` contract while the
 * application is migrated independently of component lifecycles.
 */
export class RendererEventBus {
  private readonly listeners = new Map<string, Set<EventHandler>>();

  $on(eventName: string, handler: EventHandler) {
    const handlers = this.listeners.get(eventName) || new Set<EventHandler>();
    handlers.add(handler);
    this.listeners.set(eventName, handlers);
    return this;
  }

  $once(eventName: string, handler: EventHandler) {
    const onceHandler: EventHandler = (...args) => {
      this.$off(eventName, onceHandler);
      handler(...args);
    };
    return this.$on(eventName, onceHandler);
  }

  $off(eventName?: string, handler?: EventHandler) {
    if (!eventName) {
      this.listeners.clear();
      return this;
    }
    if (!handler) {
      this.listeners.delete(eventName);
      return this;
    }
    const handlers = this.listeners.get(eventName);
    if (!handlers) return this;
    handlers.delete(handler);
    if (!handlers.size) this.listeners.delete(eventName);
    return this;
  }

  $emit(eventName: string, ...args: any[]) {
    const handlers = this.listeners.get(eventName);
    if (handlers) [...handlers].forEach(handler => handler(...args));
    return this;
  }
}

/**
 * One component's view of the shared bus.
 *
 * Vue 2 components could be torn down with their bus listeners; the adapter
 * above has no lifecycle, so every listener a component added stayed behind
 * after it unmounted. Reopening the player then stacked a second set: one
 * play/pause press toggled twice and did nothing, and "next" skipped files.
 * Each component gets one of these, and `dispose()` runs when it unmounts.
 */
export class ScopedEventBus {
  private registered?: [string, EventHandler][];

  constructor(private readonly bus: RendererEventBus) {}

  $on(eventName: string, handler: EventHandler) {
    if (!this.registered) this.registered = [];
    this.registered.push([eventName, handler]);
    this.bus.$on(eventName, handler);
    return this;
  }

  $once(eventName: string, handler: EventHandler) {
    const onceHandler: EventHandler = (...args) => {
      this.bus.$off(eventName, onceHandler);
      handler(...args);
    };
    return this.$on(eventName, onceHandler);
  }

  $off(eventName?: string, handler?: EventHandler) {
    this.bus.$off(eventName, handler);
    return this;
  }

  $emit(eventName: string, ...args: any[]) {
    this.bus.$emit(eventName, ...args);
    return this;
  }

  /** Remove every listener this component added. */
  dispose() {
    const registered = this.registered;
    this.registered = undefined;
    if (registered) registered.forEach(([eventName, handler]) => this.bus.$off(eventName, handler));
  }
}

export const rendererEventBus = new RendererEventBus();
export const rendererEvents = new EventEmitter();
