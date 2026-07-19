import * as Sentry from '@sentry/electron/renderer';
import { init as initVue, vueIntegration } from '@sentry/vue';
import { beforeSend } from './sentry-options';

let initialized = false;

export function initializeVueSentry(app) {
  if (initialized || process.env.NODE_ENV === 'development') return;
  initialized = true;
  Sentry.init({
    app,
    attachProps: true,
    integrations: defaultIntegrations => [
      ...defaultIntegrations,
      vueIntegration({
        app,
        attachProps: true,
      }),
    ],
    beforeSend,
  }, initVue);
}

if (typeof window !== 'undefined') window.Sentry = Sentry;

export default Sentry;
