import type { App } from 'vue';
import electron from 'electron';
import { analytics } from '@/services/analytics';
import { rendererEventBus, rendererEvents, ScopedEventBus } from '@/services/globalEvents';
import { fadeInDirective } from '@/directives/fadeIn';

/** Install renderer services that used to be injected by Vue 2-only plugins. */
export function installRendererGlobals(app: App) {
  app.config.globalProperties.$electron = electron;
  app.config.globalProperties.$ga = analytics;
  app.config.globalProperties.$bus = rendererEventBus;
  app.config.globalProperties.$event = rendererEvents;
  // Give each component its own view of the bus so its listeners go away with
  // it (see ScopedEventBus). An own property shadows the global one.
  app.mixin({
    beforeCreate(this: { $bus: unknown }) {
      this.$bus = new ScopedEventBus(rendererEventBus);
    },
    unmounted(this: { $bus: unknown }) {
      if (this.$bus instanceof ScopedEventBus) this.$bus.dispose();
    },
  });
  app.directive('fade-in', fadeInDirective);
  return app;
}
