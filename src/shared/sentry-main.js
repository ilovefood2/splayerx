import * as Sentry from '@sentry/electron/main';
import { beforeSend, sentryDsn } from './sentry-options';

if (process.env.NODE_ENV !== 'development') {
  Sentry.init({
    release: process.env.SENTRY_RELEASE,
    dsn: sentryDsn,
    beforeSend,
  });
}

export default Sentry;
