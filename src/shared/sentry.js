import * as Sentry from '@sentry/electron/renderer';

// Crash reporting is disabled: reports went to the upstream SPlayer project's
// Sentry account. Sentry is never initialized, so the capture and breadcrumb
// calls made through this module send nothing.

if (typeof window !== 'undefined') window.Sentry = Sentry;

export default Sentry;
