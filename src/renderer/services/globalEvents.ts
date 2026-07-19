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

export const rendererEventBus = new RendererEventBus();
export const rendererEvents = new EventEmitter();
