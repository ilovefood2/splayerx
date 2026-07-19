export const sentryDsn = 'https://6a94feb674b54686a6d88d7278727b7c@sentry.io/1449341';

const eventCounter = {};

export function beforeSend(event, hint) {
  const error = hint.originalException;
  const message = String(typeof error === 'string' ? error : (error && error.message));
  if (message.startsWith('ERR_ABORTED (-3)')
    || message.startsWith('AbortError: The user aborted a request.')
    || message.startsWith('snapshot-reply:')
  ) {
    return null;
  }
  eventCounter[message] = (eventCounter[message] || 0) + 1;
  if (message.startsWith('"PromiseRejectionEvent"')
    || message.startsWith('Duration should be a valid number.')
    || message.startsWith('AbortError: The play() request was interrupted by a call to pause()')
    || message.startsWith('Assertion Error: Unknown assertion type')
  ) {
    if (eventCounter[message] > 1) return null;
  }
  if (eventCounter[message] > 5) return null;
  return event;
}
