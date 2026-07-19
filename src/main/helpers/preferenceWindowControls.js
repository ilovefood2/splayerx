export function isPreferenceCloseShortcut(input, platform = process.platform) {
  if (!input || (input.type && input.type !== 'keyDown')) return false;

  const key = String(input.key || '').toLowerCase();
  if (key === 'escape') return true;

  const closeModifier = platform === 'darwin' ? input.meta : input.control;
  return Boolean(closeModifier && key === 'w');
}

export function registerPreferenceWindowControls(preferenceWindow, platform = process.platform) {
  const handleBeforeInput = (event, input) => {
    if (!isPreferenceCloseShortcut(input, platform)) return;

    event.preventDefault();
    if (!preferenceWindow.isDestroyed()) preferenceWindow.close();
  };

  preferenceWindow.webContents.on('before-input-event', handleBeforeInput);
  return () => preferenceWindow.webContents.removeListener('before-input-event', handleBeforeInput);
}

export default registerPreferenceWindowControls;
