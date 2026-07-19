import type { App } from 'vue';
import electron from 'electron';
import { analytics } from '@/services/analytics';
import { rendererEventBus, rendererEvents } from '@/services/globalEvents';
import { fadeInDirective } from '@/directives/fadeIn';

/** Install renderer services that used to be injected by Vue 2-only plugins. */
export function installRendererGlobals(app: App) {
  app.config.globalProperties.$electron = electron;
  app.config.globalProperties.$ga = analytics;
  app.config.globalProperties.$bus = rendererEventBus;
  app.config.globalProperties.$event = rendererEvents;
  app.directive('fade-in', fadeInDirective);
  return app;
}
