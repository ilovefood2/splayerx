interface AnalyticsWindow extends Window {
  ga?: (...args: unknown[]) => void,
}

function send(...args: unknown[]) {
  if (typeof window === 'undefined') return;
  const ga = (window as AnalyticsWindow).ga;
  if (typeof ga === 'function') ga(...args);
}

/**
 * Stable renderer-facing analytics API. Universal Analytics is no longer
 * loaded by a Vue 2 plugin; if a host-provided tracker exists, events are
 * forwarded without making analytics a renderer-startup dependency.
 */
export const analytics = {
  event(category: string, action: string, label?: string, value?: number) {
    send('send', 'event', category, action, label, value);
  },
  set(field: string, value: unknown) {
    send('set', field, value);
  },
};

export type RendererAnalytics = typeof analytics;
