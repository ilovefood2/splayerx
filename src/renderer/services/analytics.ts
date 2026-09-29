/**
 * Renderer-facing analytics API, kept so existing `$ga` calls need no changes.
 *
 * Usage analytics are disabled: events are dropped here rather than forwarded
 * to any tracker, so nothing about how the player is used leaves the machine.
 */
export const analytics = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  event(category: string, action: string, label?: string, value?: number) {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  set(field: string, value: unknown) {},
};

export type RendererAnalytics = typeof analytics;
