import * as Sentry from '@sentry/electron/main';

// Crash reporting is disabled. The DSN belonged to the upstream SPlayer
// project, so every main-process error (with file paths) went to a third
// party. Without init() the SDK's capture calls are no-ops.

export default Sentry;
